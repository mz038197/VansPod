import { randomUUID } from "node:crypto";
import { event, frames, streamResponse } from "./adapters/stream";
import { EXPLANATIONS, MAX_QUERY_LENGTH, NO_SHELL, SEARCH_FAILED, routerErrorCode } from "./codexSearch";
import { AdapterError, list, object, string, type AdapterRequest, type JsonObject, type ModelApiAdapter } from "./adapters/types";

// Claude Code's WebSearch is a model request declaring Anthropic's server-side search
// tool (type web_search_<date>). Router has no such tool, so the search loop runs here
// (ADR-0007): the classroom model is offered an ordinary function tool, each call it
// makes is answered from Router's POST /v1/search, and the model continues until it
// answers. What Claude Code gets back is what Anthropic's API would send: a
// server_tool_use block and its web_search_tool_result for every search. A search that
// fails is a result too, Anthropic's web_search_tool_result_error, so the reply still
// ends normally and the model can tell the student why.
// Block shapes: https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool

function isSearchTool(tool: unknown): tool is JsonObject {
  return typeof tool === "object" && tool !== null && typeof (tool as JsonObject).type === "string" && /^web_search_\d+$/.test((tool as JsonObject).type as string);
}

// A request never runs more searches than this, whatever max_uses it carries (ADR-0007).
const MAX_SEARCHES = 5;

function searchLimit(tools: unknown[]): number {
  return Math.min(MAX_SEARCHES, ...tools.filter(isSearchTool).map(tool => typeof tool.max_uses === "number" && tool.max_uses >= 0 ? Math.floor(tool.max_uses) : MAX_SEARCHES));
}

type SearchOutcome = {
  /** `content` of the web_search_tool_result block Claude Code receives. */
  content: unknown;
  /** What the classroom model reads as the result of its function call. */
  forModel: string;
};

// `error_code` is one of Anthropic's; the text is read verbatim by the classroom model.
function failed(error_code: string, forModel: string): SearchOutcome {
  return { content: { type: "web_search_tool_result_error", error_code }, forModel };
}

// What Anthropic's API answers to a search past max_uses.
const LIMIT_REACHED = failed("max_uses_exceeded", `已達到這次回答的搜尋次數上限。The web search limit for this reply has been reached, so this search was not performed. Do not call this tool again. ${NO_SHELL} Answer now from the results you already have, and tell the user if they were not enough.`);

// One search the model asked for. Results reach Claude Code as titles and links only;
// the text Router found goes to the classroom model, which writes the answer. A failure
// is explained by Router's error code, in the words Codex gets (codexSearch.ts). A call
// Router would reject is not sent: the model wrote it and can write a better one.
async function search(request: AdapterRequest, input: JsonObject): Promise<SearchOutcome> {
  const query = typeof input.query === "string" ? input.query.trim() : "";
  if (!query) return failed("invalid_tool_input", "The search call had no query text, so no search was performed. Call this tool again with the search words in `query`.");
  if (query.length > MAX_QUERY_LENGTH) return failed("query_too_long", `The search query was longer than ${MAX_QUERY_LENGTH} characters, so no search was performed. Call this tool again with a short query of a few keywords.`);
  try {
    const response = await fetch(`${request.routerBaseUrl}/v1/search`, { method: "POST", signal: request.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${request.apiKey}` }, body: JSON.stringify({ queries: [query] }) });
    if (!response.ok) {
      const code = await routerErrorCode(response);
      return failed(code === "web_search_rate_limited" ? "too_many_requests" : "unavailable", EXPLANATIONS[code] ?? SEARCH_FAILED);
    }
    const results = list(object(await response.json(), "search response").results, "search results").map(value => object(value, "search result"));
    return {
      content: results.map(result => ({ type: "web_search_result", title: String(result.title ?? ""), url: String(result.url ?? ""), encrypted_content: "", page_age: null })),
      forModel: results.length ? results.map((result, index) => `[${index + 1}] ${result.title}\n${result.url}\n${result.text ?? ""}`).join("\n\n") : "No results found.",
    };
  } catch (error) {
    if (request.signal.aborted) throw error;
    return failed("unavailable", SEARCH_FAILED);
  }
}

// The request the classroom model sees: same conversation, function tool for the server tool.
function modelRequest(body: JsonObject, names: Set<string>): JsonObject {
  return { ...body, tools: list(body.tools, "tools").map(tool => {
    if (!isSearchTool(tool)) return tool;
    const name = string(tool.name, "tool name"); names.add(name);
    return { name, description: "Search the web. Returns the title, URL and a text excerpt of each result.",
      input_schema: { type: "object", properties: { query: { type: "string", description: "The search query." } }, required: ["query"] } };
  }) };
}

function sumUsage(total: JsonObject, turn: unknown): void {
  const usage = object(turn ?? {}, "usage");
  for (const key of ["input_tokens", "output_tokens"]) total[key] = Number(total[key] ?? 0) + Number(usage[key] ?? 0);
}

// What one search adds to the reply and to the conversation the model continues from.
function answered(call: JsonObject, outcome: SearchOutcome): { use: JsonObject; result: JsonObject; forModel: JsonObject } {
  const id = `srvtoolu_${randomUUID().replaceAll("-", "")}`;
  return { use: { type: "server_tool_use", id, name: call.name, input: call.input }, result: { type: "web_search_tool_result", tool_use_id: id, content: outcome.content },
    forModel: { type: "tool_result", tool_use_id: call.id, content: outcome.forModel } };
}

export async function claudeWebSearch(adapter: ModelApiAdapter, received: AdapterRequest): Promise<Response> {
  if (received.client !== "claude" || adapter.id === "messages" || !Array.isArray(received.body.tools) || !received.body.tools.some(isSearchTool)) return adapter.send(received);
  const upstream = new AbortController();
  const request = { ...received, signal: AbortSignal.any([received.signal, upstream.signal]) };
  const names = new Set<string>();
  const body = modelRequest(request.body, names);
  const messages = [...list(body.messages, "messages")];
  const isSearch = (block: JsonObject) => block.type === "tool_use" && names.has(String(block.name));
  const limit = searchLimit(list(request.body.tools, "tools"));
  const usage: JsonObject = {};
  // `asked` counts the search calls answered, `searches` those that returned results.
  let asked = 0, searches = 0, closed = 0, halted = false;
  // With its searches used up the model is asked with tool calls switched off, so it
  // has to answer. One that asks again is refused without a search; twice ends the reply.
  const askModel = () => {
    if (asked < limit) return adapter.send({ ...request, body: { ...body, messages } });
    closed++;
    return adapter.send({ ...request, body: { ...body, messages, tool_choice: { type: "none" } } });
  };
  const answerSearch = async (call: JsonObject) => {
    if (asked++ >= limit) return answered(call, LIMIT_REACHED);
    const outcome = await search(request, object(call.input, "tool input"));
    if (Array.isArray(outcome.content)) searches++;
    return answered(call, outcome);
  };
  // The model goes on only when searches were all it asked for: a call to one of the
  // client's own tools ends the reply, because only the client can run it.
  const proceed = (blocks: JsonObject[], results: JsonObject[]) => {
    if (!results.length || results.length < blocks.filter(block => block.type === "tool_use").length) return false;
    if (closed > 1) { halted = true; return false; }
    messages.push({ role: "assistant", content: blocks }, { role: "user", content: results });
    return true;
  };
  const totalUsage = (last: unknown) => asked ? { ...usage, server_tool_use: { web_search_requests: searches } } : last;

  const first = await askModel();
  if (!first.ok) return first;

  if (body.stream === true) return streamResponse(async function* () {
    let response = first, started = false, next = 0;
    while (true) {
      // Blocks of this turn by the model's index; `index` is where the client sees one.
      const turn = new Map<unknown, { block: JsonObject; json: string; index?: number }>();
      let end: JsonObject | undefined;
      for await (const frame of frames(response)) {
        if (frame.data === "[DONE]") continue;
        const data = frame.data, entry = turn.get(data.index);
        if (data.type === "message_start") { if (!started) yield frame.raw; started = true; }
        else if (data.type === "content_block_start") {
          const block = { ...object(data.content_block, "content block") };
          const index = isSearch(block) ? undefined : next++;
          turn.set(data.index, { block, json: "", index });
          if (index !== undefined) yield event("content_block_start", { ...data, index });
        } else if (data.type === "content_block_delta" && entry) {
          const delta = object(data.delta, "delta");
          if (delta.type === "text_delta") entry.block.text = `${entry.block.text ?? ""}${delta.text}`;
          else if (delta.type === "input_json_delta") entry.json += delta.partial_json;
          if (entry.index !== undefined) yield event("content_block_delta", { ...data, index: entry.index });
        } else if (data.type === "content_block_stop" && entry) {
          if (entry.index !== undefined) yield event("content_block_stop", { ...data, index: entry.index });
        } else if (data.type === "message_delta") end = data;
      }
      if (!end) throw new AdapterError("模型串流中斷，未收到完成事件。", 502);
      sumUsage(usage, end.usage);
      const blocks = [...turn.values()].map(({ block, json }) => block.type === "tool_use" ? { ...block, input: object(JSON.parse(json || "{}"), "tool input") } : block);
      const results: JsonObject[] = [];
      for (const call of blocks.filter(isSearch)) {
        const { use, result, forModel } = await answerSearch(call);
        yield event("content_block_start", { index: next, content_block: { ...use, input: {} } })
          + event("content_block_delta", { index: next, delta: { type: "input_json_delta", partial_json: JSON.stringify(use.input) } })
          + event("content_block_stop", { index: next++ })
          + event("content_block_start", { index: next, content_block: result }) + event("content_block_stop", { index: next++ });
        results.push(forModel);
      }
      if (!proceed(blocks, results)) {
        yield event("message_delta", { ...end, ...(halted ? { delta: { ...object(end.delta, "delta"), stop_reason: "end_turn" } } : {}), usage: totalUsage(end.usage) }) + event("message_stop", {});
        return;
      }
      response = await askModel();
      if (!response.ok) throw new AdapterError(`Router 回傳 HTTP ${response.status}。`, 502);
    }
  }(), () => upstream.abort());

  const content: JsonObject[] = [];
  let response = first;
  while (true) {
    const turn = object(await response.json(), "model response");
    const blocks = list(turn.content, "content").map(value => object(value, "content block"));
    const results: JsonObject[] = [];
    sumUsage(usage, turn.usage);
    for (const block of blocks) {
      if (!isSearch(block)) { content.push(block); continue; }
      const { use, result, forModel } = await answerSearch(block);
      content.push(use, result); results.push(forModel);
    }
    if (!proceed(blocks, results)) return Response.json({ ...turn, content, ...(halted ? { stop_reason: "end_turn" } : {}), usage: totalUsage(turn.usage) });
    response = await askModel();
    if (!response.ok) return response;
  }
}

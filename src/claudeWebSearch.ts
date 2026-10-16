import { randomUUID } from "node:crypto";
import { event, frames, streamResponse } from "./adapters/stream";
import { MAX_QUERY_LENGTH, NO_SHELL, explainSearchFailure, webSearch } from "./webSearch";
import { AdapterError, list, object, string, type AdapterRequest, type JsonObject, type ModelApiAdapter } from "./adapters/types";

// Claude Code's WebSearch is a model request declaring Anthropic's server-side search
// tool (type web_search_<date>). Router has no such tool, so the search loop runs here
// (ADR-0007): the classroom model is offered an ordinary function tool, each call it
// makes is answered from Router's POST /v1/search, and the model continues until it
// answers. What Claude Code gets back is what Anthropic's API would send: a
// server_tool_use block and its web_search_tool_result for every search. A search that
// fails is a result too, Anthropic's web_search_tool_result_error, so the reply still
// ends normally and the model can tell the student why.
// This holds for every Model API Adapter, Messages included: the declaration never
// goes upstream, or a search could run that the teacher's switch knows nothing about.
// Block shapes: https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool

function isSearchTool(tool: unknown): tool is JsonObject {
  return typeof tool === "object" && tool !== null && typeof (tool as JsonObject).type === "string" && /^web_search_\d+$/.test((tool as JsonObject).type as string);
}

export function declaresWebSearch(request: AdapterRequest): boolean {
  return request.client === "claude" && Array.isArray(request.body.tools) && request.body.tools.some(isSearchTool);
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
  modelText: string;
};

// `error_code` is one of Anthropic's; the text is read verbatim by the classroom model.
function searchError(error_code: string, modelText: string): SearchOutcome {
  return { content: { type: "web_search_tool_result_error", error_code }, modelText };
}

// What Anthropic's API answers to a search past max_uses.
const LIMIT_REACHED = searchError("max_uses_exceeded", `已達到這次回答的搜尋次數上限。The web search limit for this reply has been reached, so this search was not performed. Do not call this tool again. ${NO_SHELL} Answer now from the results you already have, and tell the user if they were not enough.`);

// Closes a reply the model was stopped in before it answered. The student reads this one.
const STOPPED_AT_LIMIT = "已達到這次回答的搜尋次數上限，模型沒有在上限內完成回答。請再問一次，或把問題問得更具體。";

// One search the model asked for. Results reach Claude Code as titles and links only;
// the text Router found goes to the classroom model, which writes the answer. A call
// Router would reject is not sent: the model wrote it and can write a better one.
async function search(request: AdapterRequest, input: JsonObject): Promise<SearchOutcome> {
  const query = typeof input.query === "string" ? input.query.trim() : "";
  if (!query) return searchError("invalid_tool_input", "The search call had no query text, so no search was performed. Call this tool again with the search words in `query`.");
  if (query.length > MAX_QUERY_LENGTH) return searchError("query_too_long", `The search query was longer than ${MAX_QUERY_LENGTH} characters, so no search was performed. Call this tool again with a short query of a few keywords.`);
  const reply = await webSearch([query], request.routerBaseUrl, request.apiKey, request.signal);
  if ("errorCode" in reply) return searchError(reply.errorCode === "web_search_rate_limited" ? "too_many_requests" : "unavailable", explainSearchFailure(reply.errorCode));
  return {
    content: reply.results.map(result => ({ type: "web_search_result", title: result.title, url: result.url, encrypted_content: "", page_age: null })),
    modelText: reply.results.length ? reply.results.map((result, index) => `[${index + 1}] ${result.title}\n${result.url}\n${result.text}`).join("\n\n") : "No results found.",
  };
}

// The request the classroom model sees: same conversation, function tool for the server tool.
function modelRequest(body: JsonObject): { body: JsonObject; searchToolNames: Set<string> } {
  const searchToolNames = new Set<string>();
  return { searchToolNames, body: { ...body, tools: list(body.tools, "tools").map(tool => {
    if (!isSearchTool(tool)) return tool;
    const name = string(tool.name, "tool name"); searchToolNames.add(name);
    return { name, description: "Search the web. Returns the title, URL and a text excerpt of each result.",
      input_schema: { type: "object", properties: { query: { type: "string", description: "The search query." } }, required: ["query"] } };
  }) } };
}

// What one search adds to the reply (`use`, `result`) and to the conversation the model
// continues from (`toolResult`).
type SearchBlocks = { use: JsonObject; result: JsonObject; toolResult: JsonObject };

function searchBlocks(call: JsonObject, outcome: SearchOutcome): SearchBlocks {
  const id = `srvtoolu_${randomUUID().replaceAll("-", "")}`;
  return { use: { type: "server_tool_use", id, name: call.name, input: call.input }, result: { type: "web_search_tool_result", tool_use_id: id, content: outcome.content },
    toolResult: { type: "tool_result", tool_use_id: call.id, content: outcome.modelText } };
}

// A search call cut off by max_tokens has JSON that never closes. It is a call with
// no query, which the model is told like any other invalid call.
function searchInput(json: string): JsonObject {
  try { return object(JSON.parse(json || "{}"), "tool input"); } catch { return {}; }
}

// One reply's conversation with the classroom model and the searches it has used.
class SearchLoop {
  private readonly body: JsonObject;
  private readonly searchToolNames: Set<string>;
  private readonly messages: unknown[];
  private readonly limit: number;
  private readonly usage: JsonObject = {};
  // `asked` counts the search calls answered, `searches` those that returned results.
  private asked = 0;
  private searches = 0;
  private turnsWithoutTools = 0;
  private askedModel = false;

  constructor(private readonly adapter: ModelApiAdapter, private readonly request: AdapterRequest) {
    ({ body: this.body, searchToolNames: this.searchToolNames } = modelRequest(request.body));
    this.messages = [...list(this.body.messages, "messages")];
    this.limit = searchLimit(list(request.body.tools, "tools"));
  }

  isSearch(block: JsonObject): boolean { return block.type === "tool_use" && this.searchToolNames.has(String(block.name)); }

  // With its searches used up the model is asked with tool calls switched off, so it
  // has to answer. One that asks again is refused without a search; twice ends the reply.
  askModel(): Promise<Response> {
    // Prompt Capture marks every request after the first as a Web Search follow-up.
    const record = this.request.record, first = !this.askedModel;
    const request = { ...this.request, record: record && !first ? (path: string, body: JsonObject) => record(path, body, { webSearchFollowUp: true }) : record };
    this.askedModel = true;
    if (this.asked < this.limit) return this.adapter.send({ ...request, body: { ...this.body, messages: this.messages } });
    this.turnsWithoutTools++;
    return this.adapter.send({ ...request, body: { ...this.body, messages: this.messages, tool_choice: { type: "none" } } });
  }

  async answerSearch(call: JsonObject): Promise<SearchBlocks> {
    if (this.asked++ >= this.limit) return searchBlocks(call, LIMIT_REACHED);
    const outcome = await search(this.request, object(call.input, "tool input"));
    if (Array.isArray(outcome.content)) this.searches++;
    return searchBlocks(call, outcome);
  }

  // What follows a model turn. The model is asked again ("continue") only when searches
  // were all it asked for: a call to one of the client's own tools ends the reply
  // ("end"), because only the client can run it. "limit" is the model stopped for
  // asking to search again after its second turn with tool calls switched off.
  afterTurn(blocks: JsonObject[], toolResults: JsonObject[]): "continue" | "end" | "limit" {
    if (!toolResults.length || toolResults.length < blocks.filter(block => block.type === "tool_use").length) return "end";
    if (this.turnsWithoutTools > 1) return "limit";
    this.messages.push({ role: "assistant", content: blocks }, { role: "user", content: toolResults });
    return "continue";
  }

  addUsage(turn: unknown): void {
    const usage = object(turn ?? {}, "usage");
    for (const key of ["input_tokens", "output_tokens"]) this.usage[key] = Number(this.usage[key] ?? 0) + Number(usage[key] ?? 0);
  }

  // A reply without a search call reports the usage of its only turn, as the model sent it.
  totalUsage(lastTurn: unknown): unknown {
    return this.asked ? { ...this.usage, server_tool_use: { web_search_requests: this.searches } } : lastTurn;
  }
}

async function jsonReply(loop: SearchLoop, first: Response): Promise<Response> {
  const content: JsonObject[] = [];
  let response = first;
  while (true) {
    const turn = object(await response.json(), "model response");
    const blocks = list(turn.content, "content").map(value => object(value, "content block"));
    const toolResults: JsonObject[] = [];
    loop.addUsage(turn.usage);
    for (const block of blocks) {
      if (!loop.isSearch(block)) { content.push(block); continue; }
      const { use, result, toolResult } = await loop.answerSearch(block);
      content.push(use, result); toolResults.push(toolResult);
    }
    const next = loop.afterTurn(blocks, toolResults);
    if (next === "limit") content.push({ type: "text", text: STOPPED_AT_LIMIT });
    if (next !== "continue") return Response.json({ ...turn, content, ...(next === "limit" ? { stop_reason: "end_turn" } : {}), usage: loop.totalUsage(turn.usage) });
    response = await loop.askModel();
    if (!response.ok) return response;
  }
}

async function* streamedReply(loop: SearchLoop, first: Response): AsyncGenerator<string> {
  let response = first, started = false, next = 0;
  while (true) {
    // Blocks of this turn by the model's index; `index` is where the client sees one.
    const turn = new Map<unknown, { block: JsonObject; json: string; index?: number }>();
    // A Messages upstream reports input tokens when the turn opens, the rest when it ends.
    let opening: unknown, end: JsonObject | undefined;
    for await (const frame of frames(response)) {
      if (frame.data === "[DONE]") continue;
      const data = frame.data, entry = turn.get(data.index);
      if (data.type === "message_start") {
        opening = object(data.message ?? {}, "message").usage;
        if (!started) yield frame.raw; started = true;
      } else if (data.type === "content_block_start") {
        const block = { ...object(data.content_block, "content block") };
        const index = loop.isSearch(block) ? undefined : next++;
        turn.set(data.index, { block, json: "", index });
        if (index !== undefined) yield event("content_block_start", { ...data, index });
      } else if (data.type === "content_block_delta" && entry) {
        const delta = object(data.delta, "delta");
        if (delta.type === "text_delta") entry.block.text = `${entry.block.text ?? ""}${delta.text}`;
        else if (delta.type === "thinking_delta") entry.block.thinking = `${entry.block.thinking ?? ""}${delta.thinking}`;
        else if (delta.type === "signature_delta") entry.block.signature = delta.signature;
        else if (delta.type === "input_json_delta") entry.json += delta.partial_json;
        if (entry.index !== undefined) yield event("content_block_delta", { ...data, index: entry.index });
      } else if (data.type === "content_block_stop" && entry) {
        if (entry.index !== undefined) yield event("content_block_stop", { ...data, index: entry.index });
      } else if (data.type === "message_delta") end = data;
    }
    if (!end) throw new AdapterError("模型串流中斷，未收到完成事件。", 502);
    loop.addUsage({ ...object(opening ?? {}, "usage"), ...object(end.usage ?? {}, "usage") });
    // Only search calls are read here: a call to the client's own tool has already been relayed.
    const blocks = [...turn.values()].map(({ block, json }) => loop.isSearch(block) ? { ...block, input: searchInput(json) } : block);
    const toolResults: JsonObject[] = [];
    for (const call of blocks.filter(block => loop.isSearch(block))) {
      const { use, result, toolResult } = await loop.answerSearch(call);
      yield event("content_block_start", { index: next, content_block: { ...use, input: {} } })
        + event("content_block_delta", { index: next, delta: { type: "input_json_delta", partial_json: JSON.stringify(use.input) } })
        + event("content_block_stop", { index: next++ })
        + event("content_block_start", { index: next, content_block: result }) + event("content_block_stop", { index: next++ });
      toolResults.push(toolResult);
    }
    const after = loop.afterTurn(blocks, toolResults);
    if (after === "continue") {
      response = await loop.askModel();
      if (!response.ok) throw new AdapterError(`Router 回傳 HTTP ${response.status}。`, 502);
      continue;
    }
    if (after === "limit") yield event("content_block_start", { index: next, content_block: { type: "text", text: "" } })
      + event("content_block_delta", { index: next, delta: { type: "text_delta", text: STOPPED_AT_LIMIT } }) + event("content_block_stop", { index: next++ });
    yield event("message_delta", { ...end, ...(after === "limit" ? { delta: { ...object(end.delta, "delta"), stop_reason: "end_turn" } } : {}), usage: loop.totalUsage(end.usage) }) + event("message_stop", {});
    return;
  }
}

export async function claudeWebSearch(adapter: ModelApiAdapter, received: AdapterRequest): Promise<Response> {
  const upstream = new AbortController();
  const loop = new SearchLoop(adapter, { ...received, signal: AbortSignal.any([received.signal, upstream.signal]) });
  const first = await loop.askModel();
  if (!first.ok) return first;
  return received.body.stream === true ? streamResponse(streamedReply(loop, first), () => upstream.abort()) : jsonReply(loop, first);
}

import assert from "node:assert/strict";
import { test } from "node:test";
import http from "node:http";
import path from "node:path";
import { readFileSync } from "node:fs";
import { once } from "node:events";
import { sendRouter } from "../modelProxy";

type Call = { path: string; body: Record<string, unknown>; headers: http.IncomingHttpHeaders };
type Block = Record<string, unknown>;
type Adapter = "chat" | "responses";

// The request Claude Code 2.1.296 really sent for one WebSearch call (GitHub #23).
const sample = JSON.parse(readFileSync(path.join(__dirname, "../../src/test/fixtures/claude-web-search/web-search-request.json"), "utf8")) as { path: string; body: Record<string, unknown> };
const query = "台中 近期活動";
const answer = "台中近期有爵士音樂節。";
const found = { results: [
  { query, title: "台中爵士音樂節", url: "https://example.com/jazz", text: "十月在市民廣場舉行。" },
  { query, title: "台中花毯節", url: "https://example.com/flowers", text: "十一月在新社登場。" },
] };

// What the classroom model says, in each upstream protocol the fake Router speaks.
function modelAsks(adapter: Adapter, stream: boolean, name = "web_search", args = JSON.stringify({ query }), id = "call_s1"): unknown {
  if (adapter === "chat") {
    const call = { index: 0, id, type: "function", function: { name, arguments: args } };
    return stream ? `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [call] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`
      : { id: "chat_1", choices: [{ message: { content: null, tool_calls: [call] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
  }
  const item = { type: "function_call", id: "fc_1", call_id: id, name, arguments: args };
  const response = { id: "resp_1", status: "completed", output: [item], usage: { input_tokens: 10, output_tokens: 5 } };
  return stream ? sse([
    { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
    { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: args },
    { type: "response.completed", response },
  ]) : response;
}

function modelAnswers(adapter: Adapter, stream: boolean): unknown {
  if (adapter === "chat") return stream
    ? `data: ${JSON.stringify({ choices: [{ delta: { content: answer }, finish_reason: "stop" }], usage: { prompt_tokens: 30, completion_tokens: 7 } })}\n\ndata: [DONE]\n\n`
    : { id: "chat_2", choices: [{ message: { content: answer }, finish_reason: "stop" }], usage: { prompt_tokens: 30, completion_tokens: 7 } };
  const response = { id: "resp_2", status: "completed", output: [{ type: "message", id: "m", content: [{ type: "output_text", text: answer }] }], usage: { input_tokens: 30, output_tokens: 7 } };
  return stream ? sse([{ type: "response.output_text.delta", item_id: "m", content_index: 0, delta: answer }, { type: "response.completed", response }]) : response;
}

function sse(events: Array<{ type: string; [key: string]: unknown }>): string {
  return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

// A reply the fake Router sends with a failing HTTP status.
class Failure { constructor(readonly status: number, readonly body: unknown) {} }
const routerError = (status: number, code: string | null, type: string, message: string) => new Failure(status, { error: { message, type, code, param: null } });

// A fake Router that plays its replies in order, whichever endpoint is asked.
async function withRouter(replies: unknown[], run: (url: string, calls: Call[]) => Promise<void>) {
  const calls: Call[] = [], queue = [...replies];
  const server = http.createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    calls.push({ path: req.url ?? "", body: JSON.parse(raw), headers: req.headers });
    const reply = queue.shift();
    if (reply === undefined) { res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: "fake Router has nothing left to say" } })); return; }
    if (reply instanceof Failure) { res.writeHead(reply.status, { "content-type": "application/json" }); res.end(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body)); }
    else if (typeof reply === "string") { res.setHeader("content-type", "text/event-stream"); res.end(reply); }
    else { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(reply)); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try { const address = server.address(); assert.ok(address && typeof address !== "string"); await run(`http://127.0.0.1:${address.port}`, calls); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

function send(adapter: Adapter, body: Record<string, unknown>, routerBaseUrl: string): Promise<Response> {
  return sendRouter({ client: "claude", target: "router", model: "allowed", adapter, path: sample.path, apiKey: "synthetic-key", body: JSON.stringify(body) }, routerBaseUrl);
}

// The message a client assembles from either a JSON reply or a Messages stream.
async function message(response: Response, stream: boolean): Promise<{ content: Block[]; stop_reason: unknown; usage: Record<string, unknown> }> {
  assert.equal(response.status, 200, await response.clone().text());
  if (!stream) return await response.json() as { content: Block[]; stop_reason: unknown; usage: Record<string, unknown> };
  const events = (await response.text()).split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)) as Record<string, any>);
  assert.deepEqual(events.filter(event => event.type === "message_start" || event.type === "message_stop").map(event => event.type), ["message_start", "message_stop"]);
  const starts = events.filter(event => event.type === "content_block_start");
  assert.deepEqual(starts.map(event => event.index), starts.map((_, index) => index));
  assert.deepEqual(events.filter(event => event.type === "content_block_stop").map(event => event.index).sort((a, b) => a - b), starts.map(event => event.index));
  const content = starts.map(start => {
    const deltas = events.filter(event => event.type === "content_block_delta" && event.index === start.index).map(event => event.delta);
    const block = { ...start.content_block } as Block;
    if (block.type === "text") block.text = deltas.map(delta => delta.text).join("");
    else if (deltas.length) block.input = JSON.parse(deltas.map(delta => delta.partial_json).join(""));
    return block;
  });
  const end = events.find(event => event.type === "message_delta")!;
  return { content, stop_reason: end.delta.stop_reason, usage: end.usage };
}

for (const adapter of ["chat", "responses"] as const) for (const stream of [false, true]) test(`Claude Code WebSearch is answered from Router search through ${adapter} (stream ${stream})`, async () => {
  await withRouter([modelAsks(adapter, stream), found, modelAnswers(adapter, stream)], async (routerBaseUrl, calls) => {
    const { content, stop_reason, usage } = await message(await send(adapter, { ...sample.body, stream }, routerBaseUrl), stream);

    const model = adapter === "chat" ? "/v1/chat/completions" : "/v1/responses";
    assert.deepEqual(calls.map(call => call.path), [model, "/v1/search", model]);
    // The model is offered an ordinary function tool in place of Anthropic's server tool.
    const offered = (calls[0].body.tools as Array<Record<string, any>>).map(tool => adapter === "chat" ? tool.function : tool);
    assert.deepEqual(offered.map(tool => [tool.name, tool.parameters.required]), [["web_search", ["query"]]]);
    assert.doesNotMatch(JSON.stringify(calls[0].body), /web_search_20250305|max_uses/);
    assert.deepEqual(calls[1].body, { queries: [query] });
    assert.equal(calls[1].headers.authorization, "Bearer synthetic-key");
    // The model continues from the results, paired with its own call.
    const fed = adapter === "chat" ? (calls[2].body.messages as Block[]).at(-1)! : (calls[2].body.input as Block[]).at(-1)!;
    assert.equal(adapter === "chat" ? fed.tool_call_id : fed.call_id, "call_s1");
    for (const result of found.results) for (const part of [result.title, result.url, result.text]) assert.ok(JSON.stringify(fed).includes(part), part);

    assert.deepEqual(content.map(block => block.type), ["server_tool_use", "web_search_tool_result", "text"]);
    assert.match(String(content[0].id), /^srvtoolu_\w+$/);
    assert.deepEqual(content[0], { type: "server_tool_use", id: content[0].id, name: "web_search", input: { query } });
    assert.deepEqual(content[1], { type: "web_search_tool_result", tool_use_id: content[0].id, content: [
      { type: "web_search_result", title: "台中爵士音樂節", url: "https://example.com/jazz", encrypted_content: "", page_age: null },
      { type: "web_search_result", title: "台中花毯節", url: "https://example.com/flowers", encrypted_content: "", page_age: null },
    ] });
    assert.equal(content[2].text, answer);
    assert.equal(stop_reason, "end_turn");
    assert.deepEqual(usage, { input_tokens: 40, output_tokens: 12, server_tool_use: { web_search_requests: 1 } });
  });
});

const webFetch = { name: "WebFetch", description: "Fetches a URL on the student's computer.", input_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } };

for (const adapter of ["chat", "responses"] as const) for (const stream of [false, true]) test(`a WebSearch request the model answers without searching is an ordinary reply through ${adapter} (stream ${stream})`, async () => {
  const replies: string[] = [];
  for (const tools of [[...sample.body.tools as unknown[], webFetch], [webFetch]]) await withRouter([modelAnswers(adapter, stream)], async (routerBaseUrl, calls) => {
    const response = await send(adapter, { ...sample.body, tools, stream }, routerBaseUrl);
    assert.equal(response.status, 200, await response.clone().text());
    replies.push((await response.text()).replace(/msg_[0-9a-f-]{36}/g, "msg_x"));
    assert.equal(calls.length, 1);
  });
  assert.match(replies[0], /台中近期有爵士音樂節。/);
  assert.equal(replies[0], replies[1]);
});

for (const adapter of ["chat", "responses"] as const) for (const stream of [false, true]) test(`the client's own tools keep working beside WebSearch through ${adapter} (stream ${stream})`, async () => {
  const url = "https://example.com/jazz";
  await withRouter([modelAsks(adapter, stream, "WebFetch", JSON.stringify({ url }))], async (routerBaseUrl, calls) => {
    const { content, stop_reason, usage } = await message(await send(adapter, { ...sample.body, tools: [webFetch, ...sample.body.tools as unknown[]], stream }, routerBaseUrl), stream);
    // WebFetch runs on the student's computer: its call goes back to Claude Code untouched.
    assert.deepEqual(content, [{ type: "tool_use", id: "call_s1", name: "WebFetch", input: { url } }]);
    assert.equal(stop_reason, "tool_use");
    assert.deepEqual(usage, { input_tokens: 10, output_tokens: 5 });
    assert.deepEqual(calls.map(call => call.path), [adapter === "chat" ? "/v1/chat/completions" : "/v1/responses"]);
    const offered = (calls[0].body.tools as Array<Record<string, any>>).map(tool => adapter === "chat" ? tool.function : tool);
    assert.deepEqual(offered.map(tool => tool.name), ["WebFetch", "web_search"]);
    assert.deepEqual([offered[0].description, offered[0].parameters], [webFetch.description, webFetch.input_schema]);
  });
});

const modelPath = (adapter: Adapter) => adapter === "chat" ? "/v1/chat/completions" : "/v1/responses";
const searchTool = (maxUses?: number) => [{ type: "web_search_20250305", name: "web_search", ...(maxUses === undefined ? {} : { max_uses: maxUses }) }];
// What the model reads as the result of its latest search call.
const fedBack = (adapter: Adapter, call: Call) => { const fed = adapter === "chat" ? (call.body.messages as Block[]).at(-1)! : (call.body.input as Block[]).at(-1)!; return String(adapter === "chat" ? fed.content : fed.output); };
const limitReached = { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" };

for (const adapter of ["chat", "responses"] as const) for (const stream of [false, true]) for (const [maxUses, cap] of [[8, 5], [undefined, 5], [2, 2]] as const) {
  test(`a Claude Code request runs at most ${cap} searches when max_uses is ${maxUses} through ${adapter} (stream ${stream})`, async () => {
    // A model that would go on searching for as long as it is allowed to.
    const replies = [...Array.from({ length: cap }, () => [modelAsks(adapter, stream), found]).flat(), modelAnswers(adapter, stream)];
    await withRouter(replies, async (routerBaseUrl, calls) => {
      const { content, stop_reason, usage } = await message(await send(adapter, { ...sample.body, tools: searchTool(maxUses), stream }, routerBaseUrl), stream);
      assert.deepEqual(calls.map(call => call.path), [...Array.from({ length: cap }, () => [modelPath(adapter), "/v1/search"]).flat(), modelPath(adapter)]);
      // Once the searches are used up the model is asked again with tool calls switched off.
      const asked = calls.filter(call => call.path === modelPath(adapter));
      assert.deepEqual(asked.map(call => call.body.tool_choice), [...Array.from({ length: cap }, () => "auto"), "none"]);
      assert.deepEqual(content.map(block => block.type), [...Array.from({ length: cap }, () => ["server_tool_use", "web_search_tool_result"]).flat(), "text"]);
      assert.equal(content.at(-1)!.text, answer);
      assert.equal(stop_reason, "end_turn");
      assert.deepEqual(usage.server_tool_use, { web_search_requests: cap });
    });
  });
}

for (const adapter of ["chat", "responses"] as const) for (const stream of [false, true]) test(`a model that keeps asking past the limit is refused without a search and then stopped through ${adapter} (stream ${stream})`, async () => {
  const again = () => modelAsks(adapter, stream);
  await withRouter([again(), found, again(), again(), again(), found], async (routerBaseUrl, calls) => {
    const { content, stop_reason, usage } = await message(await send(adapter, { ...sample.body, tools: searchTool(1), stream }, routerBaseUrl), stream);
    assert.deepEqual(calls.map(call => call.path), [modelPath(adapter), "/v1/search", modelPath(adapter), modelPath(adapter)]);
    assert.match(fedBack(adapter, calls[3]), /limit .* has been reached/);
    assert.match(fedBack(adapter, calls[3]), /Do not call this tool again/);
    assert.deepEqual(content.map(block => block.type), Array.from({ length: 3 }, () => ["server_tool_use", "web_search_tool_result"]).flat());
    assert.deepEqual([content[3].content, content[5].content], [limitReached, limitReached]);
    assert.equal(content[5].tool_use_id, content[4].id);
    assert.equal(stop_reason, "end_turn");
    assert.deepEqual(usage.server_tool_use, { web_search_requests: 1 });
  });
});

for (const adapter of ["chat", "responses"] as const) for (const stream of [false, true]) test(`a failed search reaches Claude Code as a search error result and the model as an explanation through ${adapter} (stream ${stream})`, async () => {
  // Router relays its search provider's HTTP status, so only the error code tells the cases apart.
  const cases: Array<[string, unknown, string, RegExp]> = [
    ["disabled", routerError(403, "web_search_disabled", "invalid_request_error", "此課堂未開放網路搜尋"), "unavailable", /not enabled for this class session/],
    ["rate limited", routerError(429, "web_search_rate_limited", "rate_limit_error", "搜尋太頻繁，請稍後再試"), "too_many_requests", /too many searches/],
    ["unavailable", routerError(503, "web_search_unavailable", "server_error", "網路搜尋目前無法使用"), "unavailable", /not available right now/],
    ["provider 429", routerError(429, null, "upstream_error", "Upstream provider error synthetic-key"), "unavailable", /search failed/],
    ["provider 503", routerError(503, null, "upstream_error", "Upstream provider error"), "unavailable", /search failed/],
    ["not JSON", new Failure(502, "<html>bad gateway</html>"), "unavailable", /search failed/],
    ["malformed success", { results: "none" }, "unavailable", /search failed/],
  ];
  const read = new Map<string, string>();
  for (const [name, reply, code, expected] of cases) await withRouter([modelAsks(adapter, stream), reply, modelAnswers(adapter, stream)], async (routerBaseUrl, calls) => {
    // The request itself succeeds: the model goes on to tell the student what happened.
    const { content, stop_reason, usage } = await message(await send(adapter, { ...sample.body, stream }, routerBaseUrl), stream);
    assert.deepEqual(calls.map(call => call.path), [modelPath(adapter), "/v1/search", modelPath(adapter)], name);
    assert.deepEqual(content.map(block => block.type), ["server_tool_use", "web_search_tool_result", "text"], name);
    assert.deepEqual(content[1], { type: "web_search_tool_result", tool_use_id: content[0].id, content: { type: "web_search_tool_result_error", error_code: code } }, name);
    assert.equal(content[2].text, answer, name);
    assert.equal(stop_reason, "end_turn", name);
    assert.deepEqual(usage, { input_tokens: 40, output_tokens: 12, server_tool_use: { web_search_requests: 0 } }, name);
    read.set(name, fedBack(adapter, calls[2]));
    assert.match(read.get(name)!, expected, name);
    assert.doesNotMatch(read.get(name)!, /synthetic-key/, name);
  });
  assert.equal(new Set(["disabled", "rate limited", "unavailable", "provider 429"].map(name => read.get(name))).size, 4);
  for (const name of ["provider 503", "not JSON", "malformed success"]) assert.equal(read.get(name), read.get("provider 429"), name);
  const disabled = read.get("disabled")!;
  assert.match(disabled, /這堂課沒有開放網路搜尋/);
  assert.match(disabled, /Do not retry/);
  assert.match(disabled, /tell the user directly/i);
  assert.doesNotMatch(disabled, /another way|other way|instead|alternative|built-in|其他方式|改用|內建|WebFetch|Codex/i);
});

for (const adapter of ["chat", "responses"] as const) for (const stream of [false, true]) test(`a search call Router would reject is refused as a search error result through ${adapter} (stream ${stream})`, async () => {
  const cases: Array<[string, string, string, RegExp]> = [
    ["too long", JSON.stringify({ query: "台".repeat(1001) }), "query_too_long", /longer than 1000 characters/],
    ["no query", JSON.stringify({ q: query }), "invalid_tool_input", /no query text/],
    ["blank query", JSON.stringify({ query: "  " }), "invalid_tool_input", /no query text/],
  ];
  for (const [name, args, code, expected] of cases) await withRouter([modelAsks(adapter, stream, "web_search", args), modelAnswers(adapter, stream)], async (routerBaseUrl, calls) => {
    const { content, stop_reason } = await message(await send(adapter, { ...sample.body, stream }, routerBaseUrl), stream);
    // Router is never asked; the model reads what was wrong and may call again.
    assert.deepEqual(calls.map(call => call.path), [modelPath(adapter), modelPath(adapter)], name);
    assert.deepEqual(content.map(block => block.type), ["server_tool_use", "web_search_tool_result", "text"], name);
    assert.deepEqual(content[1].content, { type: "web_search_tool_result_error", error_code: code }, name);
    assert.match(fedBack(adapter, calls[1]), expected, name);
    assert.equal(stop_reason, "end_turn", name);
  });
  // A query of exactly Router's maximum length is searched as it is.
  await withRouter([modelAsks(adapter, stream, "web_search", JSON.stringify({ query: "台".repeat(1000) })), found, modelAnswers(adapter, stream)], async (routerBaseUrl, calls) => {
    await message(await send(adapter, { ...sample.body, stream }, routerBaseUrl), stream);
    assert.deepEqual(calls[1].body, { queries: ["台".repeat(1000)] });
  });
});

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

// A fake Router that plays its replies in order, whichever endpoint is asked.
async function withRouter(replies: unknown[], run: (url: string, calls: Call[]) => Promise<void>) {
  const calls: Call[] = [], queue = [...replies];
  const server = http.createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    calls.push({ path: req.url ?? "", body: JSON.parse(raw), headers: req.headers });
    const reply = queue.shift();
    if (reply === undefined) { res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: "fake Router has nothing left to say" } })); return; }
    if (typeof reply === "string") { res.setHeader("content-type", "text/event-stream"); res.end(reply); }
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
  assert.deepEqual(events.filter(event => event.type === "content_block_stop").map(event => event.index).sort(), starts.map(event => event.index));
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

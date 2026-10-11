import assert from "node:assert/strict";
import { test } from "node:test";
import http from "node:http";
import { once } from "node:events";
import { modelApiAdapter } from "../adapters";
import { sendRouter } from "../modelProxy";

async function withRouter(run: (url: string, calls: Array<{ path: string; body: Record<string, unknown>; headers: http.IncomingHttpHeaders }>) => Promise<void>, reply: unknown) {
  const calls: Array<{ path: string; body: Record<string, unknown>; headers: http.IncomingHttpHeaders }> = [];
  const server = http.createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    calls.push({ path: req.url ?? "", body: JSON.parse(raw), headers: req.headers });
    if (typeof reply === "string") {
      res.setHeader("content-type", "text/event-stream");
      const bytes = Buffer.from(reply); for (let i = 0; i < bytes.length; i += 7) res.write(bytes.subarray(i, i + 7));
      res.end();
    } else { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(reply)); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try { const address = server.address(); assert.ok(address && typeof address !== "string"); await run(`http://127.0.0.1:${address.port}`, calls); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

test("Claude Chat stream carries text and split tool arguments before normal completion", async () => {
  const chunks = [
    { choices: [{ delta: { content: "你好" } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_read", function: { name: "read", arguments: '{"path":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a"}' } }] }, finish_reason: "tool_calls" }] },
  ];
  await withRouter(async (routerBaseUrl) => {
    const response = await modelApiAdapter("chat").send({ client: "claude", model: "allowed", routerBaseUrl, apiKey: "synthetic-key", signal: new AbortController().signal,
      body: { stream: true, max_tokens: 100, messages: [{ role: "user", content: "hello" }] } });
    const sse = await response.text();
    assert.match(sse, /event: message_start/); assert.match(sse, /"text":"你好"/);
    assert.match(sse, /"id":"call_read"/); assert.match(sse, /"partial_json"/);
    assert.match(sse, /"stop_reason":"tool_use"/); assert.match(sse, /event: message_stop/);
  }, chunks.map(c => `data: ${JSON.stringify(c)}\r\n\r\n`).join("") + "data: [DONE]\r\n\r\n");
});

test("Claude Responses stream translates text and tool deltas into Messages", async () => {
  const events = [
    { type: "response.created", response: { id: "r", status: "in_progress" } },
    { type: "response.output_text.delta", item_id: "m", output_index: 0, content_index: 0, delta: "你好" },
    { type: "response.output_item.added", output_index: 1, item: { type: "function_call", id: "f", call_id: "call_read", name: "read", arguments: "" } },
    { type: "response.function_call_arguments.delta", item_id: "f", delta: '{"path":"a"}' },
    { type: "response.completed", response: { id: "r", status: "completed", output: [
      { type: "message", id: "m", content: [{ type: "output_text", text: "你好" }] },
      { type: "function_call", id: "f", call_id: "call_read", name: "read", arguments: '{"path":"a"}' },
    ], usage: { input_tokens: 2, output_tokens: 4 } } },
  ];
  await withRouter(async routerBaseUrl => {
    const response = await modelApiAdapter("responses").send({ client: "claude", model: "allowed", routerBaseUrl, apiKey: "synthetic-key", signal: new AbortController().signal,
      body: { stream: true, messages: [{ role: "user", content: "hello" }], max_tokens: 100 } });
    const sse = await response.text(); assert.match(sse, /"text":"你好"/); assert.match(sse, /"id":"call_read"/);
    assert.equal((sse.match(/"text":"你好"/g) ?? []).length, 1);
    assert.match(sse, /"output_tokens":4/); assert.match(sse, /event: message_stop/);
  }, events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""));
});

test("Codex Chat stream retains custom apply_patch calls and checks upstream completion", async () => {
  const patch = "*** Begin Patch\n*** Add File: a.txt\n+hi\n*** End Patch";
  await withRouter(async routerBaseUrl => {
    const response = await modelApiAdapter("chat").send({ client: "codex", model: "allowed", routerBaseUrl, apiKey: "synthetic-key", signal: new AbortController().signal,
      body: { stream: true, input: "make a file", tools: [{ type: "custom", name: "apply_patch" }] } });
    const sse = await response.text(); assert.match(sse, /response.custom_tool_call_input.done/);
    const done = sse.match(/event: response.completed\ndata: ([^\n]+)/); assert.ok(done);
    assert.equal(JSON.parse(done[1]).response.output[0].input, patch);
  }, `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_patch", function: { name: "apply_patch", arguments: JSON.stringify({ input: patch }) } }] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
});

for (const [id, client, reply] of [
  ["responses", "codex", 'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n'],
  ["messages", "claude", 'event: message_stop\ndata: {"type":"message_stop"}\n\n'],
] as const) test(`${client} ${id} relays native SSE and refuses premature EOF`, async () => {
  await withRouter(async routerBaseUrl => {
    const response = await modelApiAdapter(id).send({ client, model: "allowed", routerBaseUrl, apiKey: "synthetic-key", signal: new AbortController().signal, body: { stream: true, input: "hello", messages: [{ role: "user", content: "hello" }] } });
    assert.equal(await response.text(), reply);
  }, reply);
  await withRouter(async routerBaseUrl => {
    const response = await modelApiAdapter(id).send({ client, model: "allowed", routerBaseUrl, apiKey: "synthetic-key", signal: new AbortController().signal, body: { stream: true } });
    await assert.rejects(response.text(), /中斷/);
  }, 'data: {"type":"ping"}\n\n');
});

test("unrepresentable data fails before contacting Router and never changes adapters", async () => {
  await withRouter(async (routerBaseUrl, calls) => {
    for (const [client, body] of [
      ["codex", { input: [{ type: "reasoning", encrypted_content: "opaque" }] }],
      ["codex", { input: "hello", tools: [{ type: "web_search" }] }],
      ["codex", { input: [{ type: "function_call", call_id: "call_1", name: "read", arguments: "{}", namespace: "files" }] }],
      ["codex", { input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello", extra: "must not vanish" }] }] }],
      ["claude", { messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "secret", signature: "signed" }] }], max_tokens: 100 }],
    ] as const) {
      const response = await sendRouter({ client, target: "router", model: "allowed", adapter: "chat", path: client === "codex" ? "/v1/responses" : "/v1/messages", body: JSON.stringify(body), apiKey: "synthetic-key" }, routerBaseUrl);
      assert.equal(response.status, 400); assert.match(await response.text(), /無法/);
    }
    assert.equal(calls.length, 0);
  }, {});
});

test("Chat streams with missing completion or malformed tool arguments cannot finish successfully", async () => {
  for (const client of ["codex", "claude"] as const) for (const delta of [
    { choices: [{ delta: { content: "partial" } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read", arguments: "{" } }] }, finish_reason: "tool_calls" }] },
  ]) await withRouter(async routerBaseUrl => {
    const response = await modelApiAdapter("chat").send({ client, model: "allowed", routerBaseUrl, apiKey: "synthetic-key", signal: new AbortController().signal,
      body: client === "codex" ? { input: "hello", stream: true } : { messages: [{ role: "user", content: "hello" }], max_tokens: 100, stream: true } });
    await assert.rejects(response.text(), /中斷|參數/);
  }, `data: ${JSON.stringify(delta)}\n\n`);
});

test("Codex Chat reports token-limit truncation as incomplete and preserves token usage", async () => {
  await withRouter(async routerBaseUrl => {
    const response = await modelApiAdapter("chat").send({ client: "codex", model: "allowed", routerBaseUrl, apiKey: "synthetic-key", signal: new AbortController().signal,
      body: { stream: false, input: "hello", max_output_tokens: 1 } });
    const body = await response.json() as { status: string; incomplete_details: unknown; usage: unknown };
    assert.equal(body.status, "incomplete"); assert.deepEqual(body.incomplete_details, { reason: "max_output_tokens" });
    assert.deepEqual(body.usage, { input_tokens: 2, output_tokens: 1, total_tokens: 3 });
  }, { choices: [{ message: { content: "partial" }, finish_reason: "length" }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } });
});

test("aborting a downstream request cancels the ongoing upstream stream", async () => {
  let disconnected!: () => void;
  const gone = new Promise<void>(resolve => { disconnected = resolve; });
  const server = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume body */ }
    res.setHeader("content-type", "text/event-stream"); res.write('data: {"type":"response.created"}\n\n');
    res.on("close", disconnected);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const controller = new AbortController();
    const response = await modelApiAdapter("responses").send({ client: "codex", model: "allowed", routerBaseUrl: `http://127.0.0.1:${address.port}`, apiKey: "synthetic-key", signal: controller.signal, body: { input: "hello", stream: true } });
    const reader = response.body!.getReader(); await reader.read(); controller.abort();
    await assert.rejects(reader.read());
    await Promise.race([gone, new Promise<never>((_, reject) => { const timeout = setTimeout(() => reject(new Error("upstream did not close")), 2000); timeout.unref(); })]);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("cancelling a response body releases a stalled upstream without changing the caller signal", async () => {
  let closed!: () => void;
  const gone = new Promise<void>(resolve => { closed = resolve; });
  const server = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume body */ }
    res.setHeader("content-type", "text/event-stream"); res.flushHeaders(); res.on("close", closed);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const caller = new AbortController();
    const response = await modelApiAdapter("responses").send({ client: "codex", model: "allowed", routerBaseUrl: `http://127.0.0.1:${address.port}`, apiKey: "synthetic-key", signal: caller.signal, body: { input: "hello", stream: true } });
    await Promise.race([response.body!.cancel().then(() => gone), new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error("upstream cancellation stalled")), 500); timer.unref(); })]);
    assert.equal(caller.signal.aborted, false);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("Claude uses Responses for an image and a tool round-trip and receives Messages JSON", async () => {
  await withRouter(async (routerBaseUrl, calls) => {
    const response = await modelApiAdapter("responses").send({ client: "claude", model: "allowed", routerBaseUrl, apiKey: "synthetic-key", signal: new AbortController().signal,
      body: { stream: false, max_tokens: 100, system: "Help", tools: [{ name: "read", input_schema: { type: "object" } }], messages: [
        { role: "user", content: [{ type: "text", text: "看圖" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } }] },
        { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "read", input: { path: "a" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "file content" }] },
      ] },
    });
    assert.equal(calls[0].path, "/v1/responses");
    assert.deepEqual(calls[0].body.input, [
      { role: "user", content: [{ type: "input_text", text: "看圖" }, { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" }] },
      { type: "function_call", call_id: "call_1", name: "read", arguments: '{"path":"a"}' },
      { type: "function_call_output", call_id: "call_1", output: "file content" },
    ]);
    assert.deepEqual(calls[0].body.tools, [{ type: "function", name: "read", parameters: { type: "object" } }]);
    assert.deepEqual(await response.json(), { id: "resp_tool", type: "message", role: "assistant", model: "allowed", content: [
      { type: "text", text: "下一步" }, { type: "tool_use", id: "call_2", name: "read", input: { path: "b" } },
    ], stop_reason: "tool_use", stop_sequence: null, usage: { input_tokens: 5, output_tokens: 8 } });
  }, { id: "resp_tool", status: "completed", output: [
    { type: "message", content: [{ type: "output_text", text: "下一步", annotations: [] }] },
    { type: "function_call", call_id: "call_2", name: "read", arguments: '{"path":"b"}' },
  ], usage: { input_tokens: 5, output_tokens: 8 } });
});

test("Claude uses Chat for multiple turns and receives its tool call in Messages format", async () => {
  await withRouter(async (routerBaseUrl, calls) => {
    const response = await modelApiAdapter("chat").send({ client: "claude", model: "allowed", routerBaseUrl, apiKey: "synthetic-key", signal: new AbortController().signal,
      body: { stream: false, max_tokens: 100, messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "read", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "done" }, { type: "text", text: "next" }] },
      ] },
    });
    assert.equal(calls[0].path, "/v1/chat/completions");
    assert.deepEqual(calls[0].body.messages, [
      { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_1", content: "done" }, { role: "user", content: "next" },
    ]);
    const body = await response.json() as { content: unknown; stop_reason: string };
    assert.deepEqual(body.content, [{ type: "tool_use", id: "call_2", name: "read", input: { path: "b" } }]);
    assert.equal(body.stop_reason, "tool_use");
  }, { id: "chat_tool", choices: [{ message: { content: null, tool_calls: [{ id: "call_2", type: "function", function: { name: "read", arguments: '{"path":"b"}' } }] }, finish_reason: "tool_calls" }] });
});

test("Messages adapter preserves Claude thinking, images, and protocol headers", async () => {
  const body = { messages: [{ role: "user", content: [{ type: "image", source: { type: "url", url: "https://example.com/a.png" } }] }], thinking: { type: "enabled", budget_tokens: 1024 }, max_tokens: 2048, stream: false };
  await withRouter(async (routerBaseUrl, calls) => {
    const response = await modelApiAdapter("messages").send({ client: "claude", model: "allowed", routerBaseUrl, apiKey: "synthetic-key", signal: new AbortController().signal, body,
      headers: { "anthropic-version": "2023-06-01", "anthropic-beta": "test-beta", authorization: "Bearer client-secret" } });
    assert.equal(calls[0].path, "/v1/messages");
    assert.deepEqual(calls[0].body, { ...body, model: "allowed" });
    assert.equal(calls[0].headers["anthropic-beta"], "test-beta");
    assert.equal(calls[0].headers.authorization, "Bearer synthetic-key");
    assert.deepEqual(await response.json(), { type: "message", content: [{ type: "text", text: "ok" }] });
  }, { type: "message", content: [{ type: "text", text: "ok" }] });
});

test("Responses adapter preserves Codex payload and rewrites the allowed model", async () => {
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    assert.equal(req.url, "/v1/responses");
    assert.equal(req.headers.authorization, "Bearer synthetic-key");
    assert.deepEqual(JSON.parse(raw), { model: "allowed", input: "你好", stream: false, reasoning: { effort: "low" } });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ id: "resp_test", status: "completed", output: [] }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const response = await modelApiAdapter("responses").send({
      client: "codex", model: "allowed", body: { model: "original", input: "你好", stream: false, reasoning: { effort: "low" } },
      routerBaseUrl: `http://127.0.0.1:${address.port}`, apiKey: "synthetic-key", signal: new AbortController().signal,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { id: "resp_test", status: "completed", output: [] });
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("Chat adapter carries Codex text and images and returns a non-streaming Responses result", async () => {
  const server = http.createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    assert.equal(req.url, "/v1/chat/completions");
    assert.deepEqual(JSON.parse(raw).messages, [{ role: "user", content: [
      { type: "text", text: "看圖" }, { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=", detail: "auto" } },
    ] }]);
    assert.equal(JSON.parse(raw).stream, false);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { content: "圖中有文字" }, finish_reason: "stop" }], usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 } }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const response = await modelApiAdapter("chat").send({ client: "codex", model: "allowed", apiKey: "synthetic-key",
      routerBaseUrl: `http://127.0.0.1:${address.port}`, signal: new AbortController().signal,
      body: { input: [{ role: "user", content: [{ type: "input_text", text: "看圖" }, { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" }] }], stream: false },
    });
    const body = await response.json() as { output: Array<{ content: Array<{ text: string }> }> };
    assert.equal(body.output[0].content[0].text, "圖中有文字");
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

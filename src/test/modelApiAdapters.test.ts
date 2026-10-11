import assert from "node:assert/strict";
import { test } from "node:test";
import http from "node:http";
import { once } from "node:events";
import { modelApiAdapter } from "../adapters";
import { sendRouter } from "../modelProxy";

test("Chat rejects known unsupported model semantics before contacting Router", async () => {
  await withRouter(async (routerBaseUrl, calls) => {
    for (const fields of [{ prompt: { id: "pmpt_required", variables: { topic: "synthetic" } } }, { top_logprobs: 4 }, { logprobs: true }]) {
      const response = await sendRouter({ client: "codex", target: "router", model: "allowed", adapter: "chat", path: "/v1/responses", apiKey: "synthetic-key", body: JSON.stringify({ input: "hello", ...fields }) }, routerBaseUrl);
      assert.equal(response.status, 400);
      assert.match(await response.text(), /請求語意/);
    }
    assert.equal(calls.length, 0);
  }, { choices: [{ message: { content: "hello" }, finish_reason: "stop" }] });
});

for (const stream of [false, true]) test(`Chat projects model options without rejecting Codex access programs or future envelope extensions (${stream})`, async () => {
  const body = { input: "hello", stream, access_programs: { cyber: ["standard"] }, client_metadata: { thread_id: "synthetic" }, future_client_extension: { version: 3 }, temperature: 0.2 };
  await withRouter(async (routerBaseUrl, calls) => {
    const response = await sendRouter({ client: "codex", target: "router", model: "allowed", adapter: "chat", path: "/v1/responses", apiKey: "synthetic-key", body: JSON.stringify(body) }, routerBaseUrl);
    assert.equal(response.status, 200, await response.clone().text()); await response.text();
    assert.deepEqual(calls[0].body, { model: "allowed", messages: [{ role: "user", content: "hello" }], stream, temperature: 0.2 });
  }, stream ? 'data: {"choices":[{"delta":{"content":"hello"},"finish_reason":"stop"}]}\n\n' : { choices: [{ message: { content: "hello" }, finish_reason: "stop" }] });
});

test("Responses strips only canonical access programs and preserves unknown upstream extensions", async () => {
  const body = { input: "hello", stream: false, access_programs: { cyber: ["standard"] }, future_upstream_extension: { enabled: true } };
  const original = structuredClone(body);
  await withRouter(async (routerBaseUrl, calls) => {
    const response = await modelApiAdapter("responses").send({ client: "codex", model: "allowed", body, routerBaseUrl, apiKey: "synthetic-key", signal: new AbortController().signal });
    await response.text();
    assert.equal(calls[0].body.access_programs, undefined);
    assert.deepEqual(calls[0].body.future_upstream_extension, body.future_upstream_extension);
    assert.deepEqual(body, original);
  }, { status: "completed", output: [] });
});

for (const adapter of ["chat", "responses"] as const) for (const stream of [false, true]) test(`${adapter} preserves remote namespace grammar bytes (${stream})`, async () => {
  for (const [name, input] of [["apply_patch", "*** Begin Patch ***\n*** Delete File: a\n*** End Patch ***"], ["exec", '```js\ntext("hello")\n```']]) {
    const call = { type: "function_call", id: "f", call_id: "c", name, namespace: "remote", arguments: JSON.stringify({ input }), status: "completed" };
    const reply = adapter === "responses" ? { status: "completed", output: [call] } : { choices: [{ message: { content: null, tool_calls: [{ id: "c", type: "function", function: { name: `remote__${name}`, arguments: call.arguments } }] }, finish_reason: "tool_calls" }] };
    const wire = adapter === "responses" ? `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: reply })}\n\n` : `data: ${JSON.stringify({ choices: [{ delta: reply.choices![0].message, finish_reason: "tool_calls" }] })}\n\n`;
    await withRouter(async routerBaseUrl => {
      const response = await modelApiAdapter(adapter).send({ client: "codex", model: "allowed", routerBaseUrl, apiKey: "synthetic-key", signal: new AbortController().signal,
        body: { input: "hello", stream, tools: [{ type: "namespace", name: "remote", tools: [{ type: "custom", name, format: { type: "text" } }] }] } });
      const raw = await response.text();
      const result = stream ? JSON.parse(raw.match(/event: response.completed\ndata: ([^\n]+)/)![1]).response : JSON.parse(raw);
      assert.equal(result.output[0].input, input);
      assert.equal(result.output[0].namespace, "remote");
    }, stream ? wire : reply);
  }
});

test("Responses rejects an ambiguous upstream custom tool identity", async () => {
  await withRouter(async routerBaseUrl => {
    const response = await sendRouter({ client: "codex", target: "router", model: "allowed", adapter: "responses", path: "/v1/responses", apiKey: "synthetic-key", body: JSON.stringify({ input: "hello", stream: false,
      tools: ["a", "b"].map(name => ({ type: "namespace", name, tools: [{ type: "custom", name: "exec" }] })) }) }, routerBaseUrl);
    assert.equal(response.status, 502);
    assert.match(await response.text(), /namespace|識別/);
  }, { status: "completed", output: [{ type: "function_call", name: "exec", call_id: "c", arguments: '{"input":"hello"}' }] });
});

test("Responses rejects conflicting declarations promoted from additional_tools before sending", async () => {
  await withRouter(async (routerBaseUrl, calls) => {
    const response = await sendRouter({ client: "codex", target: "router", model: "allowed", adapter: "responses", path: "/v1/responses", apiKey: "synthetic-key", body: JSON.stringify({
      tools: [{ type: "custom", name: "exec", format: { type: "text" } }],
      input: [{ type: "additional_tools", role: "developer", tools: [{ type: "function", name: "exec", parameters: { type: "object" } }] }],
    }) }, routerBaseUrl);
    assert.equal(response.status, 400); assert.match(await response.text(), /識別重複/);
    assert.equal(calls.length, 0);
  }, { status: "completed", output: [] });
});

for (const stream of [false, true]) test(`Codex Responses sends freeform call history back as paired function items (${stream})`, async () => {
  const tool = { type: "namespace", name: "functions", tools: [{ type: "custom", name: "exec", format: { type: "grammar", syntax: "lark", definition: "start: /[\\s\\S]+/" } }] };
  const upstreamCall = { type: "function_call", id: "f", call_id: "call_exec", name: "exec", namespace: "functions", arguments: JSON.stringify({ input: 'text("hello")' }), status: "completed" };
  const reply = { status: "completed", output: [upstreamCall] };
  await withRouter(async (routerBaseUrl, calls) => {
    const options = { client: "codex" as const, model: "allowed", routerBaseUrl, apiKey: "synthetic-key", signal: new AbortController().signal };
    const first = await modelApiAdapter("responses").send({ ...options, body: { input: "hello", tools: [tool], stream } });
    const raw = await first.text();
    const output = stream ? JSON.parse(raw.match(/event: response.completed\ndata: ([^\n]+)/)![1]).response.output : JSON.parse(raw).output;
    assert.equal(output[0].type, "custom_tool_call");
    const history = { input: [...output, { type: "custom_tool_call_output", call_id: "call_exec", output: [{ type: "input_text", text: "hello" }] }], tools: [tool], stream, tool_choice: { type: "custom", namespace: "functions", name: "exec" } };
    const original = structuredClone(history);
    const second = await modelApiAdapter("responses").send({ ...options, body: history });
    assert.equal(second.status, 200, await second.clone().text()); await second.text();
    assert.deepEqual(calls[1].body.input, [
      { type: "function_call", call_id: "call_exec", name: "exec", namespace: "functions", arguments: JSON.stringify({ input: 'text("hello")' }), status: "completed" },
      { type: "function_call_output", call_id: "call_exec", output: [{ type: "input_text", text: "hello" }] },
    ]);
    assert.deepEqual(calls[1].body.tool_choice, { type: "function", namespace: "functions", name: "exec" });
    const tools = calls[1].body.tools as Array<{ tools: Array<{ type: string; parameters: { properties: { input: { description: string } } } }> }>;
    assert.equal(tools[0].tools[0].type, "function");
    assert.match(tools[0].tools[0].parameters.properties.input.description, /start:/);
    assert.deepEqual(history, original);
  }, stream ? `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: reply })}\n\n` : reply);
});

for (const stream of [false, true]) test(`Codex Responses unwraps native custom tool input too (${stream})`, async () => {
  const input = JSON.stringify({ code: 'text("hello")' });
  const call = { type: "custom_tool_call", id: "f", call_id: "c", name: "exec", namespace: "functions", input, status: "completed" };
  const result = { status: "completed", output: [call] };
  const events = [
    { type: "response.output_item.added", output_index: 0, item: { ...call, input: "", status: "in_progress" } },
    { type: "response.custom_tool_call_input.delta", item_id: "f", output_index: 0, delta: input },
    { type: "response.custom_tool_call_input.done", item_id: "f", output_index: 0, input },
    { type: "response.output_item.done", output_index: 0, item: call },
    { type: "response.completed", response: result },
  ];
  await withRouter(async routerBaseUrl => {
    const response = await modelApiAdapter("responses").send({ client: "codex", model: "allowed", routerBaseUrl, apiKey: "synthetic-key", signal: new AbortController().signal,
      body: { input: "hello", stream, tools: [{ type: "namespace", name: "functions", tools: [{ type: "custom", name: "exec", format: { type: "text" } }] }] } });
    const raw = await response.text();
    const output = stream ? JSON.parse(raw.match(/event: response.completed\ndata: ([^\n]+)/)![1]).response.output : JSON.parse(raw).output;
    assert.equal(output[0].input, 'text("hello")');
    if (stream) {
      const received = raw.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
      assert.equal(received.filter(event => event.type === "response.custom_tool_call_input.delta").map(event => event.delta).join(""), 'text("hello")');
    }
  }, stream ? events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("") : result);
});

test("Codex Chat honors summary none without losing plaintext reasoning on the next turn", async () => {
  await withRouter(async (routerBaseUrl, calls) => {
    const response = await modelApiAdapter("chat").send({ client: "codex", model: "allowed", routerBaseUrl, apiKey: "synthetic-key", signal: new AbortController().signal,
      body: { input: "hello", stream: false, reasoning: { effort: "medium", summary: "none" }, client_metadata: ["opaque"] } });
    const result = await response.json() as { output: Array<Record<string, unknown>> };
    assert.deepEqual(result.output[0].summary, []);
    assert.deepEqual(result.output[0].content, [{ type: "reasoning_text", text: "plan" }]);
    const next = await modelApiAdapter("chat").send({ client: "codex", model: "allowed", routerBaseUrl, apiKey: "synthetic-key", signal: new AbortController().signal,
      body: { input: [...result.output, { role: "user", content: "next" }], stream: false } });
    await next.text();
    assert.match((calls[1].body.messages as Array<{ content: string }>)[0].content, /plan/);
    assert.equal(calls[0].body.client_metadata, undefined);
  }, { choices: [{ message: { content: "hello", reasoning: "plan" }, finish_reason: "stop" }] });
});

for (const stream of [false, true]) test(`Codex Chat accepts a complete client envelope without forwarding client metadata (${stream})`, async () => {
  const metadata = { thread_id: "synthetic-thread", responses_lite: "true", future_client_field: { version: 2 } };
  const body = { model: "client-model", instructions: "be brief", input: [{ type: "additional_tools", role: "developer", tools: [{ type: "namespace", name: "functions", tools: [{ type: "custom", name: "exec", format: { type: "text" } }] }] }, { role: "user", content: "hello" }], stream,
    client_metadata: metadata, prompt_cache_key: "synthetic-cache", store: false, include: ["reasoning.encrypted_content"], reasoning: { effort: "medium", summary: "auto" }, text: { verbosity: "low" } };
  const original = structuredClone(body);
  const reply = { choices: [{ message: { content: "hello", reasoning: "plan" }, finish_reason: "stop" }] };
  await withRouter(async (routerBaseUrl, calls) => {
    const response = await sendRouter({ client: "codex", target: "router", model: "allowed", adapter: "chat", path: "/v1/responses", apiKey: "synthetic-key", body: JSON.stringify(body) }, routerBaseUrl);
    assert.equal(response.status, 200, await response.clone().text());
    await response.text();
    assert.equal(calls[0].body.client_metadata, undefined);
    assert.equal(calls[0].body.prompt_cache_key, body.prompt_cache_key);
    assert.equal(calls[0].body.reasoning_effort, "medium");
    assert.equal(calls[0].body.verbosity, "low");
    assert.deepEqual(body, original);
  }, stream ? `data: ${JSON.stringify({ choices: [{ delta: reply.choices[0].message, finish_reason: "stop" }] })}\n\n` : reply);
});

for (const stream of [false, true]) test(`Codex Chat restores namespaced freeform tools and accepts their next turn (${stream})`, async () => {
  const call = { id: "call_exec", type: "function", function: { name: "functions__exec", arguments: JSON.stringify({ code: 'text("hello")' }) } };
  const tool = { type: "namespace", name: "functions", tools: [{ type: "custom", name: "exec", format: { type: "text" } }] };
  await withRouter(async (routerBaseUrl, calls) => {
    const body = { stream, tools: [tool], input: "hello" };
    const response = await modelApiAdapter("chat").send({ client: "codex", model: "allowed", apiKey: "synthetic-key", routerBaseUrl, signal: new AbortController().signal, body });
    const raw = await response.text();
    const output = stream ? JSON.parse(raw.match(/event: response.completed\ndata: ([^\n]+)/)![1]).response.output : JSON.parse(raw).output;
    assert.equal(output[0].name, "exec"); assert.equal(output[0].namespace, "functions");
    assert.equal(output[0].type, "custom_tool_call"); assert.equal(output[0].input, 'text("hello")');
    const next = await modelApiAdapter("chat").send({ client: "codex", model: "allowed", apiKey: "synthetic-key", routerBaseUrl, signal: new AbortController().signal,
      body: { stream, tools: [tool], input: [output[0], { type: "custom_tool_call_output", call_id: "call_exec", output: "hello" }] } });
    await next.text();
    const messages = calls[1].body.messages as Array<{ tool_calls: Array<{ function: { name: string } }> }>;
    assert.equal(messages.find(message => message.tool_calls)?.tool_calls[0].function.name, "functions__exec");
  }, stream ? `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ ...call, index: 0 }] }, finish_reason: "tool_calls" }] })}\n\n` : { choices: [{ message: { content: null, tool_calls: [call] }, finish_reason: "tool_calls" }] });
});

for (const stream of [false, true]) test(`Codex Chat preserves plaintext reasoning in Responses output (${stream})`, async () => {
  const reply = stream ? [
    { choices: [{ delta: { reasoning: "plan " } }] },
    { choices: [{ delta: { reasoning: "briefly", content: "hello" }, finish_reason: "stop" }] },
  ].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") : { choices: [{ message: { reasoning: "plan briefly", content: "hello" }, finish_reason: "stop" }] };
  await withRouter(async (routerBaseUrl, calls) => {
    const response = await sendRouter({ client: "codex", target: "router", model: "allowed", adapter: "chat", path: "/v1/responses", apiKey: "synthetic-key", body: JSON.stringify({ input: "hello", stream }) }, routerBaseUrl);
    assert.equal(response.status, 200, await response.clone().text());
    const raw = await response.text();
    const output = stream ? JSON.parse(raw.match(/event: response.completed\ndata: ([^\n]+)/)![1]).response.output : JSON.parse(raw).output;
    assert.deepEqual(output[0].summary, [{ type: "summary_text", text: "plan briefly" }]);
    assert.equal(output[1].content[0].text, "hello");
    const next = await sendRouter({ client: "codex", target: "router", model: "allowed", adapter: "chat", path: "/v1/responses", apiKey: "synthetic-key", body: JSON.stringify({ input: [...output, { role: "user", content: "next" }], stream }) }, routerBaseUrl);
    assert.equal(next.status, 200);
    await next.text();
    assert.match((calls[1].body.messages as Array<{ content: string }>)[0].content, /plan briefly/);
  }, reply);
});

for (const stream of [false, true]) test(`Codex Responses restores a declared freeform executor from function payload (${stream})`, async () => {
  const code = 'text("hello")';
  const call = { type: "function_call", id: "f", call_id: "call_exec", name: "exec", namespace: "functions", arguments: JSON.stringify({ code }), status: "completed" };
  const output = { id: "r", status: "completed", output: [call] };
  const events = [
    { type: "response.output_item.added", output_index: 0, item: { ...call, arguments: "", status: "in_progress" } },
    { type: "response.function_call_arguments.delta", item_id: "f", output_index: 0, delta: call.arguments.slice(0, 8) },
    { type: "response.function_call_arguments.delta", item_id: "f", output_index: 0, delta: call.arguments.slice(8) },
    { type: "response.function_call_arguments.done", item_id: "f", output_index: 0, arguments: call.arguments },
    { type: "response.output_item.done", output_index: 0, item: call },
    { type: "response.completed", response: output },
  ];
  await withRouter(async routerBaseUrl => {
    const response = await modelApiAdapter("responses").send({ client: "codex", model: "allowed", apiKey: "synthetic-key", routerBaseUrl, signal: new AbortController().signal,
      body: { stream, input: "hello", tools: [{ type: "namespace", name: "functions", tools: [{ type: "custom", name: "exec", format: { type: "text" } }] }] } });
    const expected = { type: "custom_tool_call", id: "f", call_id: "call_exec", name: "exec", namespace: "functions", input: code, status: "completed" };
    if (!stream) assert.deepEqual((await response.json() as { output: unknown[] }).output, [expected]);
    else {
      const text = await response.text();
      const received = text.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
      assert.deepEqual(received.find(event => event.type === "response.output_item.done").item, expected);
      assert.deepEqual(received.find(event => event.type === "response.completed").response.output, [expected]);
      assert.equal(received.filter(event => event.type === "response.custom_tool_call_input.delta").map(event => event.delta).join(""), code);
      assert.equal(received.find(event => event.type === "response.custom_tool_call_input.done").input, code);
      assert.doesNotMatch(text, /response.function_call_arguments/);
      assert.deepEqual(received.map(event => event.sequence_number), received.map((_, index) => index));
    }
  }, stream ? events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("") : output);
});

test("Codex Chat preserves cache routing and request metadata accepted by Chat", async () => {
  const metadata = { prompt_cache_key: "synthetic-session", prompt_cache_retention: "in_memory", safety_identifier: "synthetic-user", service_tier: "auto" };
  await withRouter(async (routerBaseUrl, calls) => {
    const response = await sendRouter({ client: "codex", target: "router", model: "allowed", adapter: "chat", path: "/v1/responses", apiKey: "synthetic-key",
      body: JSON.stringify({ input: "hello", stream: false, include: ["reasoning.encrypted_content"], ...metadata }) }, routerBaseUrl);
    assert.equal(response.status, 200, await response.clone().text());
    for (const [key, value] of Object.entries(metadata)) assert.equal(calls[0].body[key], value);
  }, { choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });
});

for (const stream of [false, true]) test(`Codex Responses preserves executor namespace, type, arguments and tool results (${stream})`, async () => {
  const tool = { type: "namespace", name: "functions", tools: [{ type: "function", name: "exec", parameters: { type: "object", properties: { code: { type: "string" } }, required: ["code"] } }] };
  const call = { type: "function_call", id: "f", call_id: "call_exec", name: "exec", namespace: "functions", arguments: JSON.stringify({ code: 'text("hello")' }), status: "completed" };
  const output = { id: "r", status: "completed", output: [call] };
  await withRouter(async (routerBaseUrl, calls) => {
    const body = { stream, input: [{ type: "additional_tools", role: "developer", tools: [tool] }, { role: "user", content: "hello" }] };
    const response = await modelApiAdapter("responses").send({ client: "codex", model: "allowed", body, apiKey: "synthetic-key", routerBaseUrl, signal: new AbortController().signal });
    assert.deepEqual(calls[0].body.tools, [tool]);
    if (stream) {
      const text = await response.text();
      const events = text.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
      assert.deepEqual(events[0].item, call);
      assert.deepEqual(events[1].response, output);
    } else assert.deepEqual(await response.json(), output);
    const followup = { stream, tools: [tool], input: [call, { type: "function_call_output", call_id: call.call_id, output: "hello" }] };
    const next = await modelApiAdapter("responses").send({ client: "codex", model: "allowed", body: followup, apiKey: "synthetic-key", routerBaseUrl, signal: new AbortController().signal });
    await next.text();
    assert.deepEqual(calls[1].body.input, followup.input);
  }, stream ? `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: call })}\n\nevent: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: output })}\n\n` : output);
});

test("Codex Chat accepts the optional encrypted reasoning include selector", async () => {
  await withRouter(async (routerBaseUrl, calls) => {
    const response = await sendRouter({ client: "codex", target: "router", model: "allowed", adapter: "chat", path: "/v1/responses", apiKey: "synthetic-key",
      body: JSON.stringify({ input: "hello", stream: false, include: ["reasoning.encrypted_content"] }) }, routerBaseUrl);
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(calls[0].body.messages, [{ role: "user", content: "hello" }]);
    assert.equal(calls[0].body.include, undefined);
  }, { choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });
});

for (const adapter of ["responses", "chat"] as const) test(`Codex ${adapter} promotes additional_tools without losing custom tools`, async () => {
  const tool = { type: "custom", name: "apply_patch", format: { type: "text" } };
  await withRouter(async (routerBaseUrl, calls) => {
    const response = await sendRouter({ client: "codex", target: "router", model: "allowed", adapter, path: "/v1/responses", apiKey: "synthetic-key",
      body: JSON.stringify({ stream: false, input: [{ type: "additional_tools", role: "developer", tools: [tool] }, { role: "user", content: "hello" }] }) }, routerBaseUrl);
    assert.equal(response.status, 200, await response.clone().text());
    if (adapter === "responses") {
      const tools = calls[0].body.tools as Array<{ type: string; name: string; parameters: { properties: { input: { description: string } } } }>;
      assert.equal(tools[0].type, "function"); assert.equal(tools[0].name, tool.name);
      assert.match(tools[0].parameters.properties.input.description, /"type":"text"/);
      assert.deepEqual(calls[0].body.input, [{ role: "user", content: "hello" }]);
    } else {
      const tools = calls[0].body.tools as Array<{ function: { name: string } }>;
      assert.equal(tools[0].function.name, "apply_patch");
      const body = await response.json() as { output: Array<{ type: string; input: string }> };
      assert.equal(body.output[0].type, "custom_tool_call");
      assert.equal(body.output[0].input, "hello");
    }
  }, adapter === "responses" ? { id: "r", status: "completed", output: [] } : { choices: [{ message: { content: null, tool_calls: [{ id: "call_patch", type: "function", function: { name: "apply_patch", arguments: '{"input":"hello"}' } }] }, finish_reason: "tool_calls" }] });
});

async function withRouter(run: (url: string, calls: Array<{ path: string; body: Record<string, unknown>; headers: http.IncomingHttpHeaders }>) => Promise<void>, reply: unknown) {
  const calls: Array<{ path: string; body: Record<string, unknown>; headers: http.IncomingHttpHeaders }> = [];
  const server = http.createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    calls.push({ path: req.url ?? "", body: JSON.parse(raw), headers: req.headers });
    if (req.url === "/v1/responses" && Array.isArray(calls.at(-1)!.body.input)) {
      const index = (calls.at(-1)!.body.input as Array<{ type?: string }>).findIndex(item => item.type === "custom_tool_call" || item.type === "custom_tool_call_output");
      if (index >= 0) { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: `input[${index}]: unknown input item type: "custom_tool_call"` } })); return; }
    }
    if (req.url === "/v1/responses" && Array.isArray(calls.at(-1)!.body.input) && (calls.at(-1)!.body.input as Array<{ type?: string }>).some(item => item.type === "additional_tools")) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: 'input[0]: unknown input item type: "additional_tools"' } }));
      return;
    }
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

test("Codex Responses merges inline tool groups with existing tools without mutating input", async () => {
  const tools = [{ type: "function", name: "read", parameters: { type: "object" } }];
  const extra = { type: "namespace", name: "files", tools: [{ type: "function", name: "write", parameters: { type: "object" } }] };
  const body = { tools, include: ["reasoning.encrypted_content"], input: [
    { type: "additional_tools", role: "developer", tools: [extra] },
    { role: "user", content: "hello" },
    { type: "additional_tools", role: "developer", tools: [] },
  ] };
  const original = structuredClone(body);
  await withRouter(async (routerBaseUrl, calls) => {
    await modelApiAdapter("responses").send({ client: "codex", model: "allowed", body, apiKey: "synthetic-key", routerBaseUrl, signal: new AbortController().signal });
    assert.deepEqual(calls[0].body.tools, [...tools, extra]);
    assert.deepEqual(calls[0].body.include, body.include);
    assert.deepEqual(calls[0].body.input, [{ role: "user", content: "hello" }]);
    assert.deepEqual(body, original);
  }, { status: "completed", output: [] });
});

test("Codex still refuses unsupported includes and malformed inline tool catalogs before sending", async () => {
  for (const adapter of ["chat", "responses"] as const) await withRouter(async (routerBaseUrl, calls) => {
    const bodies = [
      { input: [{ type: "additional_tools", role: "developer", tools: "invalid" }] },
      { input: [{ type: "additional_tools", role: "developer", tools: [], extra: "keep me" }] },
      ...(adapter === "chat" ? [{ input: "hello", include: ["message.output_text.logprobs"] }] : []),
    ];
    for (const body of bodies) {
      const response = await sendRouter({ client: "codex", target: "router", model: "allowed", adapter, path: "/v1/responses", apiKey: "synthetic-key", body: JSON.stringify(body) }, routerBaseUrl);
      assert.equal(response.status, 400);
    }
    assert.equal(calls.length, 0);
  }, {});
});

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

test("grammar-defined apply_patch retains its definition and freeform result through Chat", async () => {
  const definition = 'start: "*** Begin Patch" /[\\s\\S]*/ "*** End Patch"';
  const patch = "*** Begin Patch\n*** Add File: a.txt\n+hi\n*** End Patch";
  await withRouter(async (routerBaseUrl, calls) => {
    const response = await modelApiAdapter("chat").send({ client: "codex", model: "allowed", routerBaseUrl, apiKey: "synthetic-key", signal: new AbortController().signal,
      body: { input: "make file", stream: false, tools: [{ type: "custom", name: "apply_patch", format: { type: "grammar", syntax: "lark", definition } }] } });
    const tools = calls[0].body.tools as Array<{ function: { parameters: { properties: { input: { description: string } } } } }>;
    const description = tools[0].function.parameters.properties.input.description;
    assert.deepEqual(JSON.parse(description.slice(description.indexOf("{"))), { type: "grammar", syntax: "lark", definition });
    const body = await response.json() as { output: Array<{ type: string; input: string }> };
    assert.equal(body.output[0].type, "custom_tool_call"); assert.equal(body.output[0].input, patch);
  }, { choices: [{ message: { content: null, tool_calls: [{ id: "call_patch", type: "function", function: { name: "apply_patch", arguments: JSON.stringify({ input: patch }) } }] }, finish_reason: "tool_calls" }] });
});

for (const client of ["codex", "claude"] as const) test(`${client} Chat waits for a complete tool name and rejects missing tool identity`, async () => {
  const requestBody = client === "codex" ? { input: "hello", stream: true } : { messages: [{ role: "user", content: "hello" }], max_tokens: 100, stream: true };
  const first = { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "rea", arguments: '{"path":' } }] } }] };
  const last = { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "d", arguments: '"a"}' } }] }, finish_reason: "tool_calls" }] };
  await withRouter(async routerBaseUrl => {
    const response = await modelApiAdapter("chat").send({ client, model: "allowed", routerBaseUrl, apiKey: "synthetic-key", signal: new AbortController().signal, body: requestBody });
    const sse = await response.text(); assert.match(sse, /"name":"read"/); assert.doesNotMatch(sse, /"name":"rea"/);
  }, [first, last].map(value => `data: ${JSON.stringify(value)}\n\n`).join(""));
  await withRouter(async routerBaseUrl => {
    const response = await modelApiAdapter("chat").send({ client, model: "allowed", routerBaseUrl, apiKey: "synthetic-key", signal: new AbortController().signal, body: requestBody });
    await assert.rejects(response.text(), /名稱|識別/);
  }, `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { arguments: "{}" } }] }, finish_reason: "tool_calls" }] })}\n\n`);
});

for (const client of ["codex", "claude"] as const) test(`${client} Chat JSON refuses empty or unidentifiable tool turns and labels upstream shape failures`, async () => {
  for (const reply of [
    { choices: [{ message: { content: null }, finish_reason: "tool_calls" }] },
    { choices: [{ message: { content: null, tool_calls: [{ id: "", function: { name: "", arguments: "{}" } }] }, finish_reason: "tool_calls" }] },
    { choices: "invalid" },
  ]) await withRouter(async routerBaseUrl => {
    const response = await sendRouter({ client, target: "router", model: "allowed", adapter: "chat", path: client === "codex" ? "/v1/responses" : "/v1/messages", apiKey: "synthetic-key", body: JSON.stringify(client === "codex" ? { input: "hello", stream: false } : { messages: [{ role: "user", content: "hello" }], max_tokens: 100, stream: false }) }, routerBaseUrl);
    assert.equal(response.status, 502);
  }, reply);
});

test("Claude Responses refuses to mislabel content-filter incomplete results as token limits", async () => {
  await withRouter(async routerBaseUrl => {
    const response = await sendRouter({ client: "claude", target: "router", model: "allowed", adapter: "responses", path: "/v1/messages", apiKey: "synthetic-key", body: JSON.stringify({ messages: [{ role: "user", content: "hello" }], max_tokens: 100 }) }, routerBaseUrl);
    assert.equal(response.status, 502); assert.match(await response.text(), /content_filter/);
  }, { id: "r", status: "incomplete", incomplete_details: { reason: "content_filter" }, output: [] });
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

for (const adapter of ["chat", "responses"] as const) test(`Codex ${adapter} sends code-mode guidance with its actual tool identity`, async () => {
  const body = { instructions: "ORIGINAL RULES", stream: false, input: [{ type: "additional_tools", role: "developer", tools: [{ type: "namespace", name: "functions", tools: [{ type: "custom", name: "exec", format: { type: "text" } }] }] }, { role: "user", content: "hello" }] };
  await withRouter(async (routerBaseUrl, calls) => {
    const response = await modelApiAdapter(adapter).send({ client: "codex", model: "allowed", body, routerBaseUrl, apiKey: "synthetic-key", signal: new AbortController().signal });
    await response.text();
    const sent = calls[0].body;
    const guidance = adapter === "chat" ? JSON.stringify(sent.messages) : String(sent.instructions);
    assert.match(guidance, /ORIGINAL RULES/);
    assert.match(guidance, /Nothing in the isolate is echoed automatically/);
    assert.match(guidance, /Host contract for the nested helpers/);
    assert.match(guidance, /ALL_TOOLS/);
    assert.match(JSON.stringify(sent.tools), /JavaScript source for unified exec/);
    if (adapter === "chat") assert.match(guidance, /functions__exec/);
    assert.deepEqual(body.instructions, "ORIGINAL RULES");
  }, adapter === "chat" ? { choices: [{ message: { content: "hello" }, finish_reason: "stop" }] } : { object: "response", status: "completed", output: [] });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPromptCapture } from "../promptCapture";
import { sendRouter } from "../modelProxy";
import { Failure, fixture, withFakeRouter } from "./fakeRouter";

const API_KEY = "sk-classroom-synthetic-4f9a";
const claudeReply = { id: "msg_1", type: "message", role: "assistant", model: "allowed", content: [{ type: "text", text: "hi" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } };

describe("Prompt Capture recorder", () => {
  it("starts with recording off and nothing captured", () => {
    const capture = createPromptCapture();
    assert.equal(capture.recording, false);
    assert.deepEqual(capture.list(), { captures: [], dropped: 0 });
  });

  it("records only between start and pause", () => {
    const capture = createPromptCapture();
    capture.start();
    assert.equal(capture.recording, true);
    capture.pause();
    assert.equal(capture.recording, false);
  });

  it("clear empties the recorder without changing the recording state", () => {
    const capture = createPromptCapture();
    capture.start();
    capture.clear();
    assert.equal(capture.recording, true);
    assert.deepEqual(capture.list(), { captures: [], dropped: 0 });
  });

  it("lists the newest capture first", () => {
    const capture = createPromptCapture(); capture.start();
    for (const text of ["first", "second"]) capture.record({ client: "claude", adapter: "messages", path: "/v1/messages", sent: { model: "m", messages: [{ role: "user", content: text }] }, raw: {} });
    assert.deepEqual(capture.list().captures.map(one => [one.id, one.messages[0].text]), [[2, "second"], [1, "first"]]);
  });

  it("parses a Messages body into System, Tools and the conversation", () => {
    const capture = createPromptCapture(); capture.start();
    const reminder = "<system-reminder>\nThe following skills are available:\n- tdd\n</system-reminder>";
    capture.record({ client: "claude", adapter: "messages", path: "/v1/messages", raw: {}, sent: {
      model: "claude-sonnet", max_tokens: 100,
      system: [{ type: "text", text: "You are Claude Code." }, { type: "text", text: "Be concise.", cache_control: { type: "ephemeral" } }],
      tools: [
        { name: "Read", description: "Reads a file. Paths are absolute.", input_schema: { type: "object", properties: { file_path: { type: "string" } } } },
        { name: "Skill", description: "Invoke a skill.", input_schema: { type: "object" } },
      ],
      messages: [
        { role: "user", content: [{ type: "text", text: reminder }, { type: "text", text: "讀 hello.py" }] },
        { role: "assistant", content: [{ type: "thinking", thinking: "hmm", signature: "s" }, { type: "text", text: "Reading." }, { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "C:\\hello.py" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "print('hi')" }] }] },
        { role: "user", content: "thanks" },
      ],
    } });
    const [one] = capture.list().captures;
    assert.equal(one.protocol, "messages");
    assert.equal(one.model, "claude-sonnet");
    assert.deepEqual(one.system, ["You are Claude Code.", "Be concise."]);
    assert.deepEqual(one.tools, [
      { name: "Read", description: "Reads a file. Paths are absolute.", schema: { type: "object", properties: { file_path: { type: "string" } } } },
      { name: "Skill", description: "Invoke a skill.", schema: { type: "object" } },
    ]);
    assert.deepEqual(one.messages, [
      { role: "user", kind: "text", text: reminder, isNew: true, reminder: true },
      { role: "user", kind: "text", text: "讀 hello.py", isNew: true, reminder: false },
      { role: "assistant", kind: "text", text: "Reading.", isNew: true, reminder: false },
      { role: "assistant", kind: "tool_use", name: "Read", text: '{\n  "file_path": "C:\\\\hello.py"\n}', isNew: true, reminder: false },
      { role: "tool", kind: "tool_result", name: "Read", text: "print('hi')", isNew: true, reminder: false },
      { role: "user", kind: "text", text: "thanks", isNew: true, reminder: false },
    ]);
    assert.equal(one.newConversation, true);
    assert.equal(one.webSearchFollowUp, false);
    assert.equal(one.failedStatus, undefined);
  });

  it("keeps the newest 20 captures, counts the dropped ones, and clear resets the count", () => {
    const capture = createPromptCapture(); capture.start();
    for (let index = 1; index <= 21; index++) capture.record({ client: "claude", adapter: "messages", path: "/v1/messages", sent: { model: "m", messages: [{ role: "user", content: `ask ${index}` }] }, raw: {} });
    const { captures, dropped } = capture.list();
    assert.equal(captures.length, 20);
    assert.equal(dropped, 1);
    assert.deepEqual([captures[0].id, captures.at(-1)!.id], [21, 2]);
    capture.clear();
    assert.deepEqual(capture.list(), { captures: [], dropped: 0 });
  });

  it("stores base64 images and files as placeholders with their size, in both bodies", () => {
    const capture = createPromptCapture(); capture.start();
    const png = Buffer.alloc(3 * 1024).toString("base64");
    const pdf = Buffer.alloc(10 * 1024).toString("base64");
    const content = [
      { type: "text", text: "看圖" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: png } },
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdf } },
    ];
    capture.record({ client: "claude", adapter: "messages", path: "/v1/messages",
      sent: { model: "m", messages: [{ role: "user", content }] },
      raw: { model: "m", messages: [{ role: "user", content: [{ type: "input_image", image_url: `data:image/jpeg;base64,${png}` }] }] } });
    const [one] = capture.list().captures;
    const stored = JSON.stringify(one);
    assert.ok(!stored.includes(png.slice(0, 64)) && !stored.includes(pdf.slice(0, 64)));
    const sent = one.sent as { messages: [{ content: Array<{ source: { data: string; media_type: string } }> }] };
    assert.equal(sent.messages[0].content[1].source.data, "[圖片 3 KB]");
    assert.equal(sent.messages[0].content[1].source.media_type, "image/png");
    assert.equal(sent.messages[0].content[2].source.data, "[檔案 10 KB]");
    const raw = one.raw as { messages: [{ content: [{ image_url: string }] }] };
    assert.equal(raw.messages[0].content[0].image_url, "[圖片 3 KB]");
  });

  it("parses a Responses body: instructions and system/developer input are System, function calls are tool use", () => {
    const capture = createPromptCapture(); capture.start();
    capture.record({ client: "codex", adapter: "responses", path: "/v1/responses", raw: {}, sent: {
      model: "gpt-5", instructions: "You are Codex.",
      tools: [{ type: "function", name: "shell", description: "Runs a command.", parameters: { type: "object", properties: { cmd: { type: "string" } } } }],
      input: [
        { type: "message", role: "developer", content: [{ type: "input_text", text: "Sandbox: read-only." }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "<system-reminder>skills</system-reminder>" }, { type: "input_text", text: "list files" }] },
        { type: "reasoning", summary: [] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "Listing." }] },
        { type: "function_call", call_id: "call_1", name: "shell", arguments: '{"cmd":"ls"}' },
        { type: "function_call_output", call_id: "call_1", output: "a.txt" },
        { role: "user", content: "thanks" },
      ],
    } });
    const [one] = capture.list().captures;
    assert.equal(one.protocol, "responses");
    assert.equal(one.model, "gpt-5");
    assert.deepEqual(one.system, ["You are Codex.", "Sandbox: read-only."]);
    assert.deepEqual(one.tools, [{ name: "shell", description: "Runs a command.", schema: { type: "object", properties: { cmd: { type: "string" } } } }]);
    assert.deepEqual(one.messages, [
      { role: "user", kind: "text", text: "<system-reminder>skills</system-reminder>", isNew: true, reminder: true },
      { role: "user", kind: "text", text: "list files", isNew: true, reminder: false },
      { role: "assistant", kind: "text", text: "Listing.", isNew: true, reminder: false },
      { role: "assistant", kind: "tool_use", name: "shell", text: '{\n  "cmd": "ls"\n}', isNew: true, reminder: false },
      { role: "tool", kind: "tool_result", name: "shell", text: "a.txt", isNew: true, reminder: false },
      { role: "user", kind: "text", text: "thanks", isNew: true, reminder: false },
    ]);
  });

  it("reads a Responses input given as a plain string", () => {
    const capture = createPromptCapture(); capture.start();
    capture.record({ client: "codex", adapter: "responses", path: "/v1/responses", raw: {}, sent: { model: "m", input: "hello" } });
    assert.deepEqual(capture.list().captures[0].messages, [{ role: "user", kind: "text", text: "hello", isNew: true, reminder: false }]);
  });

  it("parses a Chat Completions body: system/developer messages are System, tool_calls are tool use", () => {
    const capture = createPromptCapture(); capture.start();
    capture.record({ client: "copilot", adapter: "chat", path: "/v1/chat/completions", raw: {}, sent: {
      model: "gpt-4o",
      tools: [{ type: "function", function: { name: "read_file", description: "Reads a file.", parameters: { type: "object" } } }],
      messages: [
        { role: "system", content: "You are VS Code Chat." },
        { role: "developer", content: [{ type: "text", text: "Prefer short answers." }] },
        { role: "user", content: [{ type: "text", text: "open a.txt" }] },
        { role: "assistant", content: "Opening.", tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } }] },
        { role: "tool", tool_call_id: "call_1", content: "hello" },
        { role: "assistant", content: null, tool_calls: [{ id: "call_2", type: "function", function: { name: "read_file", arguments: "{}" } }] },
      ],
    } });
    const [one] = capture.list().captures;
    assert.equal(one.protocol, "chat");
    assert.equal(one.model, "gpt-4o");
    assert.deepEqual(one.system, ["You are VS Code Chat.", "Prefer short answers."]);
    assert.deepEqual(one.tools, [{ name: "read_file", description: "Reads a file.", schema: { type: "object" } }]);
    assert.deepEqual(one.messages, [
      { role: "user", kind: "text", text: "open a.txt", isNew: true, reminder: false },
      { role: "assistant", kind: "text", text: "Opening.", isNew: true, reminder: false },
      { role: "assistant", kind: "tool_use", name: "read_file", text: '{\n  "path": "a.txt"\n}', isNew: true, reminder: false },
      { role: "tool", kind: "tool_result", name: "read_file", text: "hello", isNew: true, reminder: false },
      { role: "assistant", kind: "tool_use", name: "read_file", text: "{}", isNew: true, reminder: false },
    ]);
  });

  it("parses the same conversation alike whichever of the three protocols carries it", () => {
    const capture = createPromptCapture(); capture.start();
    const schema = { type: "object", properties: { path: { type: "string" } } };
    capture.record({ client: "claude", adapter: "messages", path: "/v1/messages", raw: {}, sent: {
      model: "m", system: "Be helpful.", tools: [{ name: "read", description: "Reads.", input_schema: schema }],
      messages: [
        { role: "user", content: "open a.txt" },
        { role: "assistant", content: [{ type: "text", text: "Opening." }, { type: "tool_use", id: "c1", name: "read", input: { path: "a.txt" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "hello" }] },
      ],
    } });
    capture.record({ client: "codex", adapter: "responses", path: "/v1/responses", raw: {}, sent: {
      model: "m", instructions: "Be helpful.", tools: [{ type: "function", name: "read", description: "Reads.", parameters: schema }],
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "open a.txt" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "Opening." }] },
        { type: "function_call", call_id: "c1", name: "read", arguments: '{"path":"a.txt"}' },
        { type: "function_call_output", call_id: "c1", output: "hello" },
      ],
    } });
    capture.record({ client: "copilot", adapter: "chat", path: "/v1/chat/completions", raw: {}, sent: {
      model: "m", tools: [{ type: "function", function: { name: "read", description: "Reads.", parameters: schema } }],
      messages: [
        { role: "system", content: "Be helpful." },
        { role: "user", content: "open a.txt" },
        { role: "assistant", content: "Opening.", tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: '{"path":"a.txt"}' } }] },
        { role: "tool", tool_call_id: "c1", content: "hello" },
      ],
    } });
    const shapes = capture.list().captures.map(one => ({ protocol: one.protocol, system: one.system, tools: one.tools,
      messages: one.messages.map(({ isNew: _isNew, ...message }) => message) }));
    assert.deepEqual(shapes.map(shape => shape.protocol), ["chat", "responses", "messages"]);
    const expected = {
      system: ["Be helpful."], tools: [{ name: "read", description: "Reads.", schema }],
      messages: [
        { role: "user", kind: "text", text: "open a.txt", reminder: false },
        { role: "assistant", kind: "text", text: "Opening.", reminder: false },
        { role: "assistant", kind: "tool_use", name: "read", text: '{\n  "path": "a.txt"\n}', reminder: false },
        { role: "tool", kind: "tool_result", name: "read", text: "hello", reminder: false },
      ],
    };
    for (const { protocol: _protocol, ...shape } of shapes) assert.deepEqual(shape, expected);
  });

  it("estimates tokens: one per CJK character, one per four other characters", () => {
    const capture = createPromptCapture(); capture.start();
    capture.record({ client: "claude", adapter: "messages", path: "/v1/messages", raw: {}, sent: {
      model: "m", system: "abcdefgh",
      messages: [{ role: "user", content: [{ type: "text", text: "<system-reminder>x</system-reminder>" }, { type: "text", text: "你好嗎abcd" }] }],
    } });
    const [one] = capture.list().captures;
    assert.deepEqual(one.sizes, { system: 2, tools: 0, reminder: 9, history: 0, fresh: 4 });
    assert.equal(one.total, 15);
  });
});

describe("Prompt Capture fresh vs history", () => {
  type Turn = { role: "user" | "assistant"; content: unknown };
  const send = (capture: ReturnType<typeof createPromptCapture>, messages: Turn[]) =>
    capture.record({ client: "claude", adapter: "messages", path: "/v1/messages", raw: {}, sent: { model: "m", messages } });
  const marks = (one: { messages: { text: string; isNew: boolean }[] }) => one.messages.map(message => [message.text, message.isNew]);

  it("marks only what the second request of a conversation adds as fresh", () => {
    const capture = createPromptCapture(); capture.start();
    const first: Turn[] = [{ role: "user", content: "hello" }];
    send(capture, first);
    send(capture, [...first, { role: "assistant", content: "hi there" }, { role: "user", content: "thanks" }]);
    const [second] = capture.list().captures;
    assert.equal(second.newConversation, false);
    assert.deepEqual(marks(second), [["hello", false], ["hi there", true], ["thanks", true]]);
    assert.deepEqual(second.sizes, { system: 0, tools: 0, reminder: 0, history: 2, fresh: 4 });
  });

  it("matches each request to its own conversation when two conversations interleave", () => {
    const capture = createPromptCapture(); capture.start();
    const main: Turn[] = [{ role: "user", content: "fix the bug" }];
    const agent: Turn[] = [{ role: "user", content: "search the repo" }];
    send(capture, main);
    send(capture, agent);
    send(capture, [...main, { role: "assistant", content: "looking" }]);
    send(capture, [...agent, { role: "assistant", content: "found it" }]);
    const [agentSecond, mainSecond] = capture.list().captures;
    assert.deepEqual(marks(mainSecond), [["fix the bug", false], ["looking", true]]);
    assert.deepEqual(marks(agentSecond), [["search the repo", false], ["found it", true]]);
    assert.equal(mainSecond.newConversation, false);
    assert.equal(agentSecond.newConversation, false);
  });

  it("marks a request with no earlier match as a new conversation, all of it fresh", () => {
    const capture = createPromptCapture(); capture.start();
    send(capture, [{ role: "user", content: "hello" }, { role: "assistant", content: "hi" }]);
    send(capture, [{ role: "user", content: "summary of our chat" }, { role: "assistant", content: "hi" }]);
    const [compacted, first] = capture.list().captures;
    assert.equal(first.newConversation, true);
    assert.equal(compacted.newConversation, true);
    assert.deepEqual(marks(compacted), [["summary of our chat", true], ["hi", true]]);
    assert.equal(compacted.sizes.history, 0);
  });

  it("keeps each request's fresh marks after the request it matched is dropped", () => {
    const capture = createPromptCapture(); capture.start();
    const turns: Turn[] = [{ role: "user", content: "ask 0" }];
    send(capture, turns);
    for (let index = 1; index <= 20; index++) { turns.push({ role: "user", content: `ask ${index}` }); send(capture, [...turns]); }
    const oldest = capture.list().captures.at(-1)!;
    assert.equal(oldest.id, 2);
    assert.equal(oldest.newConversation, false);
    assert.deepEqual(marks(oldest), [["ask 0", false], ["ask 1", true]]);
  });

  it("matches a request only to earlier ones from the same client", () => {
    const capture = createPromptCapture(); capture.start();
    const first: Turn[] = [{ role: "user", content: "hello" }];
    send(capture, first);
    capture.record({ client: "copilot", adapter: "chat", path: "/v1/chat/completions", raw: {}, sent: { model: "m", messages: [{ role: "user", content: "hello" }, { role: "assistant", content: "hi" }] } });
    const [other] = capture.list().captures;
    assert.equal(other.newConversation, true);
    assert.deepEqual(marks(other), [["hello", true], ["hi", true]]);
  });

  it("keeps system reminders in their own share, neither history nor fresh", () => {
    const capture = createPromptCapture(); capture.start();
    const reminder = "<system-reminder>skills</system-reminder>";
    const first: Turn[] = [{ role: "user", content: [{ type: "text", text: reminder }, { type: "text", text: "hello" }] }];
    send(capture, first);
    send(capture, [...first, { role: "assistant", content: "hi there" }, { role: "user", content: [{ type: "text", text: reminder }, { type: "text", text: "go" }] }]);
    const [second] = capture.list().captures;
    assert.deepEqual(second.sizes, { system: 0, tools: 0, reminder: 22, history: 2, fresh: 3 });
  });
});

describe("Prompt Capture through sendRouter", () => {
  const clientBody = { model: "claude-sonnet", max_tokens: 100, stream: false, messages: [{ role: "user", content: "hello" }] };
  const send = (routerBaseUrl: string, capture: ReturnType<typeof createPromptCapture>) => sendRouter({
    client: "claude", target: "router", model: "allowed", adapter: "messages", path: "/v1/messages?beta=true", apiKey: API_KEY,
    headers: { "anthropic-version": "2023-06-01", "anthropic-beta": "synthetic-beta" }, body: JSON.stringify(clientBody),
  }, routerBaseUrl, capture);

  it("records what the Messages adapter sends to Router, with the client's own body and path", async () => {
    await withFakeRouter([claudeReply], async (routerBaseUrl, calls) => {
      const capture = createPromptCapture(); capture.start();
      const response = await send(routerBaseUrl, capture);
      assert.equal(response.status, 200);
      const { captures } = capture.list();
      assert.equal(captures.length, 1);
      const [one] = captures;
      assert.equal(one.client, "claude");
      assert.equal(one.adapter, "messages");
      assert.equal(one.protocol, "messages");
      assert.equal(one.path, "/v1/messages");
      assert.equal(one.model, "allowed");
      assert.deepEqual(one.sent, calls[0].body);
      assert.deepEqual(one.raw, clientBody);
    });
  });

  for (const status of [429, 503]) it(`marks a request Router rejects with HTTP ${status}, without its error body`, async () => {
    await withFakeRouter([new Failure(status, { error: { message: "synthetic-router-complaint" } })], async (routerBaseUrl) => {
      const capture = createPromptCapture(); capture.start();
      const response = await send(routerBaseUrl, capture);
      assert.equal(response.status, status);
      const [one] = capture.list().captures;
      assert.equal(one.failedStatus, status);
      assert.ok(!JSON.stringify(capture.list()).includes("synthetic-router-complaint"));
    });
  });

  it("records nothing for Codex's /alpha/search, which is not a model request", async () => {
    const sample = fixture<{ path: string; body: unknown }>("codex-search/search-query.json");
    await withFakeRouter([{ results: [{ query: "台中 近期活動", title: "t", url: "https://example.com", text: "x" }] }], async (routerBaseUrl, calls) => {
      const capture = createPromptCapture(); capture.start();
      const response = await sendRouter({ client: "codex", target: "router", model: "allowed", adapter: "responses", path: sample.path, apiKey: API_KEY, body: JSON.stringify(sample.body) }, routerBaseUrl, capture);
      assert.equal(response.status, 200, await response.clone().text());
      assert.ok(calls.length > 0);
      assert.deepEqual(capture.list(), { captures: [], dropped: 0 });
    });
  });

  const responsesBody = { model: "gpt-5", stream: false, instructions: "You are Codex.", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }] };
  const responsesReply = { id: "resp_1", object: "response", status: "completed", model: "allowed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] }] };
  const chatReply = { id: "chat_1", object: "chat.completion", model: "allowed", choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }] };
  for (const [client, adapter, reply, protocol, path] of [
    ["codex", "responses", responsesReply, "responses", "/v1/responses"],
    ["codex", "chat", chatReply, "chat", "/v1/chat/completions"],
    ["copilot", "chat", chatReply, "chat", "/v1/chat/completions"],
  ] as const) it(`records what the ${adapter} adapter sends to Router for ${client}`, async () => {
    await withFakeRouter([reply], async (routerBaseUrl, calls) => {
      const capture = createPromptCapture(); capture.start();
      const response = await sendRouter({ client, target: "router", model: "allowed", adapter, path: "/v1/responses", apiKey: API_KEY, body: JSON.stringify(responsesBody) }, routerBaseUrl, capture);
      assert.equal(response.status, 200, await response.clone().text());
      const [one] = capture.list().captures;
      assert.deepEqual([one.client, one.adapter, one.protocol, one.path], [client, adapter, protocol, path]);
      assert.equal(calls[0].path, path);
      assert.deepEqual(one.sent, calls[0].body);
      assert.deepEqual(one.raw, responsesBody);
      assert.deepEqual(one.system, ["You are Codex."]);
      assert.deepEqual(one.messages.map(message => [message.role, message.kind, message.text]), [["user", "text", "hello"]]);
    });
  });

  it("records nothing while recording is off", async () => {
    await withFakeRouter([claudeReply], async (routerBaseUrl, calls) => {
      const capture = createPromptCapture();
      await send(routerBaseUrl, capture);
      assert.equal(calls.length, 1);
      assert.deepEqual(capture.list(), { captures: [], dropped: 0 });
    });
  });

  it("redacts the Classroom API Key when a body carries it", async () => {
    await withFakeRouter([claudeReply], async (routerBaseUrl) => {
      const capture = createPromptCapture(); capture.start();
      const body = { ...clientBody, messages: [{ role: "user", content: `my key is ${API_KEY}` }] };
      await sendRouter({ client: "claude", target: "router", model: "allowed", adapter: "messages", path: "/v1/messages", apiKey: API_KEY, body: JSON.stringify(body) }, routerBaseUrl, capture);
      const [one] = capture.list().captures;
      assert.ok(!JSON.stringify(capture.list()).includes(API_KEY));
      assert.equal(one.messages[0].text, "my key is [redacted]");
      assert.deepEqual((one.raw as typeof body).messages[0].content, "my key is [redacted]");
    });
  });

  it("keeps no headers and never the Classroom API Key", async () => {
    await withFakeRouter([claudeReply], async (routerBaseUrl, calls) => {
      const capture = createPromptCapture(); capture.start();
      await send(routerBaseUrl, capture);
      assert.equal(calls[0].headers.authorization, `Bearer ${API_KEY}`);
      const stored = JSON.stringify(capture.list());
      assert.ok(!stored.includes(API_KEY));
      assert.ok(!/authorization|anthropic-version|anthropic-beta|synthetic-beta/i.test(stored));
    });
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPromptCapture } from "../promptCapture";
import { sendRouter } from "../modelProxy";
import { withFakeRouter } from "./fakeRouter";

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
    assert.equal(one.newConversation, false);
    assert.equal(one.webSearchFollowUp, false);
    assert.equal(one.failedStatus, undefined);
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

  it("records nothing while recording is off", async () => {
    await withFakeRouter([claudeReply], async (routerBaseUrl, calls) => {
      const capture = createPromptCapture();
      await send(routerBaseUrl, capture);
      assert.equal(calls.length, 1);
      assert.deepEqual(capture.list(), { captures: [], dropped: 0 });
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

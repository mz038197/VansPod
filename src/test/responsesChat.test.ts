import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { describe, it, test } from "node:test";
import { zstdCompressSync } from "node:zlib";
import { decodeRequestBody, ResponsesSse, responsesToChatBody, toolKindsFromResponses } from "../responsesChat";
import { codexResponsesUpstreamBody } from "../codexWire/request";
import { codexToolGuidance, CODE_MODE_RESULT_ECHO_SENTENCE, CODE_MODE_HOST_CONTRACT_SENTENCE } from "../codexWire/tool-guidance";

describe("responses to chat", () => {
  it("turns Responses input into a streaming chat completion", () => {
    const body = responsesToChatBody(
      JSON.stringify({
        model: "VCRouter/vcr-auto",
        instructions: "be brief",
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "hello" }],
          },
        ],
      }),
      "vcr-auto",
    );
    assert.deepEqual(JSON.parse(body), {
      model: "vcr-auto",
      stream: true,
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "hello" },
      ],
    });
  });

  it("reads a developer message and a bare input_text item", () => {
    const body = responsesToChatBody(
      JSON.stringify({
        input: [
          {
            type: "message",
            role: "developer",
            content: [{ type: "input_text", text: "rules" }],
          },
          { type: "input_text", text: "hello" },
        ],
      }),
      "vcr-auto",
    );
    assert.deepEqual(JSON.parse(body).messages, [
      { role: "system", content: "rules" },
      { role: "user", content: "hello" },
    ]);
  });

  it("decompresses a zstd Responses body before parsing", () => {
    const json = JSON.stringify({
      input: [{ type: "input_text", text: "hello" }],
    });
    const decoded = decodeRequestBody(zstdCompressSync(Buffer.from(json)));
    const body = responsesToChatBody(decoded, "vcr-auto");
    assert.deepEqual(JSON.parse(body).messages, [
      { role: "user", content: "hello" },
    ]);
  });

  it("keeps a function call and its output in the next chat request", () => {
    const body = responsesToChatBody(
      JSON.stringify({
        tools: [
          {
            type: "function",
            name: "shell",
            description: "run",
            parameters: { type: "object", properties: {} },
          },
        ],
        input: [
          { type: "input_text", text: "list files" },
          {
            type: "custom_tool_call",
            call_id: "call_1",
            name: "exec",
            input: "console.log(1)",
          },
          {
            type: "custom_tool_call_output",
            call_id: "call_1",
            output: "1",
          },
        ],
      }),
      "vcr-auto",
    );
    const parsed = JSON.parse(body);
    assert.equal(parsed.messages[0].role, "system");
    assert.match(parsed.messages[0].content, /Valid tool names for this turn are exactly `shell`/);
    assert.deepEqual(parsed.messages.slice(1), [
      { role: "user", content: "list files" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "exec", arguments: "{\"input\":\"console.log(1)\"}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "1" },
    ]);
    assert.equal(parsed.tools[0].function.name, "shell");
  });

  it("emits a Codex function_call from a chat tool_calls delta", () => {
    const sse = new ResponsesSse("vcr-auto");
    const frames = sse.pushChatChunk(
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"shell","arguments":""}}]}}]}\n\n' +
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"command\\":\\"ls\\"}"}}]}}]}\n\n',
    );
    const done = sse.finish();
    assert.match(frames, /"type":"function_call"/);
    assert.match(frames, /event: response\.function_call_arguments\.delta/);
    const doneEvent = done.match(
      /event: response\.function_call_arguments\.done\ndata: (.*)\n/,
    );
    assert.ok(doneEvent?.[1]);
    assert.equal(JSON.parse(doneEvent[1]).arguments, "{\"command\":\"ls\"}");
    assert.match(done, /event: response\.completed/);
  });

  it("unwraps a custom exec tool's JSON wrapper into the script", () => {
    const body = responsesToChatBody(
      JSON.stringify({
        tools: [{ type: "custom", name: "exec" }],
      }),
      "vcr-auto",
    );
    assert.deepEqual(JSON.parse(body).tools[0].function.parameters.required, [
      "input",
    ]);
    const sse = new ResponsesSse(
      "vcr-auto",
      toolKindsFromResponses(
        JSON.stringify({ tools: [{ type: "custom", name: "exec" }] }),
      ),
    );
    sse.pushChatChunk(
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"exec","arguments":"{\\"command\\":\\"console.log(1)\\"}"}}]}}]}\n\n',
    );
    const done = sse.finish();
    const event = done.match(
      /event: response\.custom_tool_call_input\.done\ndata: (.*)\n/,
    );
    assert.ok(event?.[1]);
    assert.equal(JSON.parse(event[1]).input, "console.log(1)");
  });

  it("emits Responses text deltas from chat SSE", () => {
    const sse = new ResponsesSse("vcr-auto");
    const created = sse.created();
    const deltas = sse.pushChatChunk(
      'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n' +
        "data: [DONE]\n\n",
    );
    const done = sse.finish();
    assert.match(created, /event: response\.created/);
    assert.match(deltas, /event: response\.output_text\.delta/);
    assert.match(deltas, /"delta":"Hi"/);
    assert.match(done, /event: response\.completed/);
    assert.match(done, /data: \[DONE\]/);
  });
});


test("Tool guidance distinguishes code mode from structured exec and shell bridges", () => {
  const exec = { type: "custom", name: "exec", format: { type: "text" } };
  const shell = { type: "function", name: "exec_command", parameters: { type: "object" } };
  for (const tools of [[{ ...exec, type: "function" }], [{ type: "namespace", name: "remote", tools: [exec] }], [exec, shell]]) {
    const body = { tools, input: "hello" };
    assert.equal(codexToolGuidance(body).codeMode, false);
    assert.equal(codexResponsesUpstreamBody(body).instructions, undefined);
  }
  assert.equal(codexToolGuidance({ tools: [exec, { type: "namespace", name: "remote", tools: [shell] }] }).codeMode, true);
});

test("Tool guidance follows none, forced and allowed tool choices", () => {
  const exec = { type: "custom", name: "exec" };
  const read = { type: "function", name: "read", parameters: {} };
  for (const tool_choice of ["none", { type: "function", name: "read" }, { type: "allowed_tools", tools: [{ type: "function", name: "read" }] }]) {
    const body = { tools: [exec, read], tool_choice };
    assert.equal(codexToolGuidance(body).codeMode, false);
    assert.equal(codexResponsesUpstreamBody(body).instructions, undefined);
  }
  assert.equal(codexToolGuidance({ tools: [exec, read], tool_choice: { type: "custom", name: "exec" } }).codeMode, true);
  const chat = JSON.parse(responsesToChatBody(JSON.stringify({ tools: [exec, read], tool_choice: "none", input: "hello" }), "model"));
  assert.deepEqual(chat.messages, [{ role: "user", content: "hello" }]);
});

test("Responses guidance is idempotent and retains the original grammar and transcript", () => {
  const body = { instructions: `ORIGINAL\n\n${CODE_MODE_RESULT_ECHO_SENTENCE}`, tools: [{ type: "custom", name: "exec", format: { type: "grammar", syntax: "regex", definition: "RAW-GRAMMAR" } }], input: [{ role: "developer", content: "PROJECT" }] };
  const original = structuredClone(body);
  const first = codexResponsesUpstreamBody(body);
  const second = codexResponsesUpstreamBody({ ...body, instructions: first.instructions });
  assert.deepEqual(second, first);
  assert.equal(String(first.instructions).split(CODE_MODE_RESULT_ECHO_SENTENCE).length, 2);
  assert.ok(String(first.instructions).includes(CODE_MODE_HOST_CONTRACT_SENTENCE));
  assert.match(JSON.stringify(first.tools), /RAW-GRAMMAR/);
  assert.deepEqual(first.input, body.input);
  assert.deepEqual(body, original);
});

test("Chat guidance uses collision-safe aliases and is not appended twice", () => {
  const tools = [{ type: "namespace", name: "functions", tools: [{ type: "custom", name: "exec" }] }, { type: "function", name: "functions__exec", parameters: {} }];
  const raw = { instructions: "ORIGINAL", tools, input: "hello" };
  const first = JSON.parse(responsesToChatBody(JSON.stringify(raw), "model"));
  const name = first.tools[0].function.name;
  assert.match(name, /^vanspod_tool_/);
  assert.ok(first.messages[0].content.includes(`\`${name}\` is Codex code mode`));
  const second = JSON.parse(responsesToChatBody(JSON.stringify({ ...raw, instructions: first.messages[0].content }), "model"));
  assert.deepEqual(first, second);
});

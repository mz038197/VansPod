import { randomUUID } from "node:crypto";
import { AdapterError, object, type JsonObject } from "./types";
import { event, frames } from "./stream";
import { thinkingBlock, type Reasoning, type ThinkingMode } from "./claude-reasoning";
import { ChatToolCalls, chatFinishReason, validateChatContent } from "./chat-output";

export class MessagesStream {
  private readonly blocks = new Map<string, { index: number; kind: "text" | "tool" | "thinking"; value: string; closed: boolean }>();
  private inputTokens = 0;
  private outputTokens = 0;
  constructor(private readonly model: string) {}
  start(): string { return event("message_start", { message: { id: `msg_${randomUUID()}`, type: "message", role: "assistant", model: this.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } }); }
  usage(input: unknown, output: unknown): void { if (typeof input === "number") this.inputTokens = input; if (typeof output === "number") this.outputTokens = output; }
  text(key: string, delta: string): string {
    let block = this.blocks.get(key), out = "";
    if (!block) { block = { index: this.blocks.size, kind: "text", value: "", closed: false }; this.blocks.set(key, block); out += event("content_block_start", { index: block.index, content_block: { type: "text", text: "" } }); }
    block.value += delta;
    return out + event("content_block_delta", { index: block.index, delta: { type: "text_delta", text: delta } });
  }
  tool(key: string, id: string, name: string): string {
    if (this.blocks.has(key)) return "";
    const block = { index: this.blocks.size, kind: "tool" as const, value: "", closed: false }; this.blocks.set(key, block);
    return event("content_block_start", { index: block.index, content_block: { type: "tool_use", id, name, input: {} } });
  }
  // The signature only exists once the upstream has finished the reasoning, so the block is sent whole.
  thinking(key: string, reasoning: Reasoning, mode: ThinkingMode): string {
    if (mode === "off" || this.blocks.has(key)) return "";
    const index = this.blocks.size, block = thinkingBlock(reasoning, mode, this.model); this.blocks.set(key, { index, kind: "thinking", value: "", closed: true });
    return event("content_block_start", { index, content_block: { type: "thinking", thinking: "", signature: "" } })
      + (block.thinking ? event("content_block_delta", { index, delta: { type: "thinking_delta", thinking: block.thinking } }) : "")
      + event("content_block_delta", { index, delta: { type: "signature_delta", signature: block.signature } }) + event("content_block_stop", { index });
  }
  arguments(key: string, delta: string): string {
    const block = this.blocks.get(key); if (!block || block.kind !== "tool") throw new AdapterError("上游工具串流缺少識別資訊。", 502);
    block.value += delta;
    return event("content_block_delta", { index: block.index, delta: { type: "input_json_delta", partial_json: delta } });
  }
  reconcile(key: string, value: string): string {
    const previous = this.blocks.get(key)?.value ?? "";
    if (!value.startsWith(previous)) throw new AdapterError("上游完成內容與串流內容不一致。", 502);
    const rest = value.slice(previous.length);
    return rest ? this.blocks.get(key)?.kind === "tool" ? this.arguments(key, rest) : this.text(key, rest) : "";
  }
  finish(reason: string): string {
    let out = "";
    for (const block of this.blocks.values()) {
      if (block.kind === "tool") {
        try { object(JSON.parse(block.value || "{}"), "tool input"); } catch { throw new AdapterError("上游工具參數不是有效 JSON 物件。", 502); }
      }
      if (!block.closed) { out += event("content_block_stop", { index: block.index }); block.closed = true; }
    }
    return out + event("message_delta", { delta: { stop_reason: reason, stop_sequence: null }, usage: { input_tokens: this.inputTokens, output_tokens: this.outputTokens } }) + event("message_stop", {});
  }
}

export async function* chatToMessagesStream(response: Response, model: string, mode: ThinkingMode = "off"): AsyncGenerator<string> {
  const output = new MessagesStream(model); yield output.start();
  const tools = new ChatToolCalls();
  let finish: unknown, reasoning = "", thoughts = 0;
  // Reasoning comes before the answer it led to; it becomes one block when that answer starts.
  const thought = () => { const text = reasoning; reasoning = ""; return text ? output.thinking(`thinking:${thoughts++}`, { text }, mode) : ""; };
  for await (const frame of frames(response)) {
    if (frame.data === "[DONE]") continue;
    const body = frame.data;
    if (body.error) throw new AdapterError("Chat 上游串流回報失敗。", 502);
    if (body.usage) { const usage = object(body.usage, "usage"); output.usage(usage.prompt_tokens, usage.completion_tokens); }
    for (const raw of (body.choices ?? []) as JsonObject[]) {
      const choice = object(raw, "choice"), delta = object(choice.delta ?? {}, "delta");
      validateChatContent(delta, true);
      const reasoned = delta.reasoning_content ?? delta.reasoning;
      if (typeof reasoned === "string") reasoning += reasoned;
      if (typeof delta.content === "string" && delta.content) { yield thought(); yield output.text("text", delta.content); }
      if (delta.tool_calls !== undefined) tools.add(delta.tool_calls);
      if (choice.finish_reason != null) finish = choice.finish_reason;
    }
  }
  finish = chatFinishReason(finish);
  const calls = tools.completed();
  if (finish === "tool_calls" && !calls.length) throw new AdapterError("上游工具呼叫缺少識別資訊。", 502);
  yield thought();
  for (const call of calls) {
    yield output.tool(`tool:${call.index}`, call.id, call.function.name);
    yield output.arguments(`tool:${call.index}`, call.function.arguments);
  }
  yield output.finish(finish === "tool_calls" ? "tool_use" : finish === "length" ? "max_tokens" : "end_turn");
}

import { randomUUID } from "node:crypto";
import { AdapterError, object, type JsonObject } from "./types";
import { event, frames } from "./stream";

export class MessagesStream {
  private readonly blocks = new Map<string, { index: number; kind: "text" | "tool"; value: string; closed: boolean }>();
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

export async function* chatToMessagesStream(response: Response, model: string): AsyncGenerator<string> {
  const output = new MessagesStream(model); yield output.start();
  const tools = new Map<number, { id: string; name: string; args: string; emitted: number }>();
  let finish: unknown;
  for await (const frame of frames(response)) {
    if (frame.data === "[DONE]") continue;
    const body = frame.data;
    if (body.error) throw new AdapterError("Chat 上游串流回報失敗。", 502);
    if (body.usage) { const usage = object(body.usage, "usage"); output.usage(usage.prompt_tokens, usage.completion_tokens); }
    for (const raw of (body.choices ?? []) as JsonObject[]) {
      const choice = object(raw, "choice"), delta = object(choice.delta ?? {}, "delta");
      if (delta.reasoning_content || delta.reasoning || delta.refusal || delta.audio) throw new AdapterError("Claude 無法保留此 Chat 串流內容。", 502);
      if (typeof delta.content === "string") yield output.text("text", delta.content);
      for (const value of (delta.tool_calls ?? []) as JsonObject[]) {
        const call = object(value, "tool call"), fn = object(call.function ?? {}, "tool function");
        const index = Number(call.index ?? 0);
        const tool = tools.get(index) ?? { id: "", name: "", args: "", emitted: 0 }; tools.set(index, tool);
        if (typeof call.id === "string") { if (tool.id && tool.id !== call.id) throw new AdapterError("工具 ID 在串流中改變。", 502); tool.id = call.id; }
        if (typeof fn.name === "string") tool.name += fn.name;
        if (typeof fn.arguments === "string") tool.args += fn.arguments;
        if (tool.id && tool.name) {
          yield output.tool(`tool:${index}`, tool.id, tool.name);
          if (tool.args.length > tool.emitted) { yield output.arguments(`tool:${index}`, tool.args.slice(tool.emitted)); tool.emitted = tool.args.length; }
        }
      }
      if (choice.finish_reason != null) finish = choice.finish_reason;
    }
  }
  if (!["stop", "tool_calls", "length"].includes(String(finish))) throw new AdapterError("Chat 串流中斷或結束原因無法轉換。", 502);
  if ([...tools.values()].some(tool => !tool.id || !tool.name)) throw new AdapterError("上游工具呼叫缺少 ID 或名稱。", 502);
  yield output.finish(finish === "tool_calls" ? "tool_use" : finish === "length" ? "max_tokens" : "end_turn");
}

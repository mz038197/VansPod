import { AdapterError, list, object, type JsonObject } from "./types";

export function validateChatContent(message: JsonObject): void {
  if (message.reasoning_content || message.reasoning || message.refusal || message.audio || message.annotations) throw new AdapterError("所選客戶端無法保留此 Chat 輸出。", 502);
  if (message.function_call !== undefined) throw new AdapterError("無法保留舊版 Chat function_call 輸出。", 502);
  if (message.content !== undefined && message.content !== null && typeof message.content !== "string") throw new AdapterError("Chat 輸出 content 必須是文字。", 502);
}

export function chatFinishReason(value: unknown): "stop" | "tool_calls" | "length" {
  if (value === "stop" || value === "tool_calls" || value === "length") return value;
  throw new AdapterError("Chat 串流中斷或結束原因無法轉換。", 502);
}

// A Chat tool name can span packets. The downstream start event is immutable, so
// collect each complete call before publishing it; text still streams immediately.
export class ChatToolCalls {
  private readonly calls = new Map<number, { id: string; name: string; args: string }>();
  add(value: unknown): void {
    for (const raw of list(value, "tool_calls")) {
      const call = object(raw, "tool call"), fn = object(call.function ?? {}, "tool function");
      const index = call.index ?? 0;
      if (typeof index !== "number" || !Number.isInteger(index) || index < 0) throw new AdapterError("Chat tool index 無效。", 502);
      const tool = this.calls.get(index) ?? { id: "", name: "", args: "" }; this.calls.set(index, tool);
      if (typeof call.id === "string") {
        if (tool.id && tool.id !== call.id) throw new AdapterError("工具 ID 在串流中改變。", 502);
        tool.id = call.id;
      }
      if (typeof fn.name === "string") tool.name += fn.name;
      if (typeof fn.arguments === "string") tool.args += fn.arguments;
    }
  }
  completed(toolKinds: ReadonlyMap<string, "function" | "custom"> = new Map()): Array<{ index: number; id: string; type: "function"; function: { name: string; arguments: string } }> {
    return [...this.calls.entries()].map(([index, call]) => {
      if (!call.id || !call.name) throw new AdapterError("上游工具呼叫缺少 ID 或名稱。", 502);
      if (toolKinds.get(call.name) !== "custom") {
        let input: unknown; try { input = JSON.parse(call.args || "{}"); } catch { throw new AdapterError("上游工具參數不是有效 JSON。", 502); }
        if (!input || typeof input !== "object" || Array.isArray(input)) throw new AdapterError("上游工具參數必須是 JSON 物件。", 502);
      }
      return { index, id: call.id, type: "function", function: { name: call.name, arguments: call.args || "{}" } };
    });
  }
}

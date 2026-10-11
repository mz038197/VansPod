import { AdapterError, list, object, string, type JsonObject } from "./types";

export function responsesToClaude(body: JsonObject, model: string): JsonObject {
  if (body.status !== "completed" && body.status !== "incomplete") throw new AdapterError("Responses 未正常完成。", 502);
  const content: JsonObject[] = [];
  for (const value of list(body.output, "Responses output")) {
    const item = object(value, "output item");
    if (item.type === "message") for (const raw of list(item.content, "message content")) {
      const part = object(raw, "output part");
      if (part.type !== "output_text" || (Array.isArray(part.annotations) && part.annotations.length)) throw new AdapterError("Claude 無法轉換此 Responses 輸出內容。", 502);
      content.push({ type: "text", text: string(part.text, "output text") });
    } else if (item.type === "function_call") {
      let input: unknown; try { input = JSON.parse(string(item.arguments, "arguments")); } catch { throw new AdapterError("上游工具參數不是有效 JSON。", 502); }
      content.push({ type: "tool_use", id: string(item.call_id, "call_id"), name: string(item.name, "tool name"), input: object(input, "tool input") });
    } else throw new AdapterError(`Claude 無法保留 Responses 輸出 ${String(item.type)}。`, 502);
  }
  const usage = body.usage ? object(body.usage, "usage") : {};
  return { id: body.id ?? "msg_vanspod", type: "message", role: "assistant", model, content,
    stop_reason: body.status === "incomplete" ? "max_tokens" : content.some(c => c.type === "tool_use") ? "tool_use" : "end_turn",
    stop_sequence: null, usage: { input_tokens: usage.input_tokens ?? 0, output_tokens: usage.output_tokens ?? 0 } };
}

export function chatToClaude(body: JsonObject, model: string): JsonObject {
  const choice = object(list(body.choices, "choices")[0], "choice");
  const message = object(choice.message, "Chat message");
  if (message.reasoning_content || message.reasoning || message.refusal || message.audio) throw new AdapterError("Claude 無法保留此 Chat 輸出。", 502);
  const content: JsonObject[] = [];
  if (message.content !== null && message.content !== undefined) content.push({ type: "text", text: string(message.content, "Chat content") });
  for (const value of message.tool_calls === undefined ? [] : list(message.tool_calls, "tool_calls")) {
    const call = object(value, "tool call"), fn = object(call.function, "tool function");
    let input: unknown; try { input = JSON.parse(string(fn.arguments, "arguments")); } catch { throw new AdapterError("上游工具參數不是有效 JSON。", 502); }
    content.push({ type: "tool_use", id: string(call.id, "tool id"), name: string(fn.name, "tool name"), input: object(input, "tool input") });
  }
  const usage = body.usage ? object(body.usage, "usage") : {};
  if (!["stop", "tool_calls", "length"].includes(String(choice.finish_reason))) throw new AdapterError("Chat 結束原因無法轉換。", 502);
  return { id: body.id ?? "msg_vanspod", type: "message", role: "assistant", model, content, stop_reason: choice.finish_reason === "length" ? "max_tokens" : choice.finish_reason === "tool_calls" ? "tool_use" : "end_turn",
    stop_sequence: null, usage: { input_tokens: usage.prompt_tokens ?? 0, output_tokens: usage.completion_tokens ?? 0 } };
}

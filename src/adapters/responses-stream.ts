import { MessagesStream } from "./messages-stream";
import { responsesToClaude } from "./claude-response";
import { AdapterError, list, object, string, type JsonObject } from "./types";
import { frames } from "./stream";
import { responsesReasoning, type ThinkingMode } from "./claude-reasoning";

export async function* responsesToMessagesStream(response: Response, model: string, mode: ThinkingMode = "off"): AsyncGenerator<string> {
  const output = new MessagesStream(model); yield output.start();
  let terminal: JsonObject | undefined;
  for await (const frame of frames(response)) {
    if (frame.data === "[DONE]") continue;
    const body = frame.data, type = String(body.type);
    if (type === "error" || type === "response.failed") throw new AdapterError("Responses 上游串流回報失敗。", 502);
    if (type === "response.output_text.delta") yield output.text(`text:${body.item_id}:${body.content_index ?? 0}`, string(body.delta, "text delta"));
    else if (type === "response.output_item.added") {
      const item = object(body.item, "output item");
      if (item.type === "function_call") {
        const key = `tool:${string(item.id, "item id")}`;
        yield output.tool(key, string(item.call_id, "call id"), string(item.name, "tool name"));
        if (typeof item.arguments === "string" && item.arguments) yield output.arguments(key, item.arguments);
      } else if (item.type !== "message" && item.type !== "reasoning") throw new AdapterError(`Claude 無法保留 Responses 輸出 ${String(item.type)}。`, 502);
    } else if (type === "response.output_item.done") {
      const item = object(body.item, "output item"), reasoning = item.type === "reasoning" ? responsesReasoning(item) : undefined;
      if (reasoning) yield output.thinking(`reasoning:${item.id}`, reasoning, mode);
    } else if (type === "response.function_call_arguments.delta") yield output.arguments(`tool:${body.item_id}`, string(body.delta, "arguments delta"));
    else if (type === "response.completed" || type === "response.incomplete") terminal = object(body.response, "response");
    else if (/^response\.(refusal|custom_tool_call)/.test(type)) throw new AdapterError("Claude 無法保留此 Responses 串流內容。", 502);
  }
  if (!terminal) throw new AdapterError("Responses 串流中斷，未收到完成事件。", 502);
  const message = responsesToClaude(terminal, model, mode);
  for (const value of list(terminal.output, "output")) {
    const item = object(value, "output item");
    if (item.type === "message") {
      const parts = list(item.content, "content");
      for (let index = 0; index < parts.length; index++) {
        const part = object(parts[index], "content part");
        yield output.reconcile(`text:${item.id}:${index}`, string(part.text, "output text"));
      }
    } else if (item.type === "reasoning") {
      const reasoning = responsesReasoning(item);
      if (reasoning) yield output.thinking(`reasoning:${item.id}`, reasoning, mode);
    } else if (item.type === "function_call") {
      const key = `tool:${item.id}`;
      yield output.tool(key, string(item.call_id, "call_id"), string(item.name, "name"));
      yield output.reconcile(key, string(item.arguments, "arguments"));
    }
  }
  const usage = object(message.usage, "usage"); output.usage(usage.input_tokens, usage.output_tokens);
  yield output.finish(string(message.stop_reason, "stop_reason"));
}

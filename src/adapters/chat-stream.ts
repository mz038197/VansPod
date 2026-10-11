import { ResponsesSse } from "../responsesChat";
import { frames } from "./stream";
import { AdapterError, object, list } from "./types";
import { ChatToolCalls, chatFinishReason, validateChatContent } from "./chat-output";

export async function* chatToResponsesStream(response: Response, model: string, toolKinds: ReadonlyMap<string, "function" | "custom">): AsyncGenerator<string> {
  const output = new ResponsesSse(model, toolKinds); yield output.created();
  let finish: unknown;
  const tools = new ChatToolCalls();
  for await (const frame of frames(response)) {
    if (frame.data === "[DONE]") continue;
    const body = frame.data;
    if (body.error) throw new AdapterError("Chat 上游串流回報失敗。", 502);
    for (const value of list(body.choices ?? [], "choices")) {
      const choice = object(value, "choice"), delta = object(choice.delta ?? {}, "delta");
      validateChatContent(delta);
      if (delta.tool_calls !== undefined) tools.add(delta.tool_calls);
      if (choice.finish_reason != null) finish = choice.finish_reason;
    }
    const textOnly = { ...body, choices: list(body.choices ?? [], "choices").map(value => {
      const choice = object(value, "choice"), delta = { ...object(choice.delta ?? {}, "delta") }; delete delta.tool_calls;
      return { ...choice, delta };
    }) };
    yield output.pushChatChunk(`data: ${JSON.stringify(textOnly)}\n`);
  }
  finish = chatFinishReason(finish);
  const calls = tools.completed(toolKinds);
  if (finish === "tool_calls" && !calls.length) throw new AdapterError("上游工具呼叫缺少識別資訊。", 502);
  if (calls.length) yield output.pushChatChunk(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: calls } }] })}\n`);
  const terminal = output.finish();
  if (terminal.includes("event: response.failed")) throw new AdapterError("上游工具參數無法轉換。", 502);
  yield terminal;
}

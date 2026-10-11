import { ResponsesSse } from "../responsesChat";
import { frames } from "./stream";
import { AdapterError, object, list } from "./types";

export async function* chatToResponsesStream(response: Response, model: string, toolKinds: ReadonlyMap<string, "function" | "custom">): AsyncGenerator<string> {
  const output = new ResponsesSse(model, toolKinds); yield output.created();
  let finish: unknown;
  for await (const frame of frames(response)) {
    if (frame.data === "[DONE]") continue;
    const body = frame.data;
    if (body.error) throw new AdapterError("Chat 上游串流回報失敗。", 502);
    for (const value of list(body.choices ?? [], "choices")) {
      const choice = object(value, "choice"), delta = object(choice.delta ?? {}, "delta");
      if (delta.reasoning_content || delta.reasoning || delta.refusal || delta.audio) throw new AdapterError("Responses 無法保留此 Chat 串流內容。", 502);
      if (choice.finish_reason != null) finish = choice.finish_reason;
    }
    yield output.pushChatChunk(`data: ${JSON.stringify(body)}\n`);
  }
  if (!["stop", "tool_calls", "length"].includes(String(finish))) throw new AdapterError("Chat 串流中斷或結束原因無法轉換。", 502);
  const terminal = output.finish();
  if (terminal.includes("event: response.failed")) throw new AdapterError("上游工具參數無法轉換。", 502);
  yield terminal;
}

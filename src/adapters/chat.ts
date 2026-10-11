import { ResponsesSse, responsesToChatBody, toolKindsFromResponses } from "../responsesChat";
import { AdapterError, object, list, type AdapterRequest, type ModelApiAdapter } from "./types";
import { claudeToChat } from "./claude-request";
import { chatToClaude } from "./claude-response";
import { chatToMessagesStream } from "./messages-stream";
import { streamResponse } from "./stream";
import { chatToResponsesStream } from "./chat-stream";
import { upstreamRequest } from "./transport";

export class ChatAdapter implements ModelApiAdapter {
  readonly id = "chat";
  async send(request: AdapterRequest): Promise<Response> {
    const raw = JSON.stringify({ ...request.body, stream: request.body.stream === true });
    const bodyToSend = request.client === "codex" ? object(JSON.parse(responsesToChatBody(raw, request.model)), "Chat request") : claudeToChat(request.body, request.model);
    const { response, abort } = await upstreamRequest(request, "/v1/chat/completions", bodyToSend);
    if (!response.ok) return response;
    if (request.body.stream) {
      if (request.client === "claude") return streamResponse(chatToMessagesStream(response, request.model), abort);
      return streamResponse(chatToResponsesStream(response, request.model, toolKindsFromResponses(raw)), abort);
    }
    const body = object(await response.json(), "Chat response");
    if (request.client === "claude") return Response.json(chatToClaude(body, request.model));
    const choice = object(list(body.choices, "choices")[0], "choice");
    const message = object(choice.message, "message");
    if (message.reasoning_content || message.reasoning || message.refusal || message.audio) throw new AdapterError("Responses 無法保留此 Chat 輸出。", 502);
    if (!["stop", "tool_calls", "length"].includes(String(choice.finish_reason))) throw new AdapterError("Chat 結束原因無法轉換。", 502);
    if (Array.isArray(message.tool_calls)) message.tool_calls = message.tool_calls.map((call, index) => ({ ...object(call, "tool call"), index }));
    const sse = new ResponsesSse(request.model, toolKindsFromResponses(raw));
    sse.pushChatChunk(`data: ${JSON.stringify({ choices: [{ delta: message, finish_reason: choice.finish_reason }], usage: body.usage })}\n\n`);
    const frames = sse.finish();
    const event = frames.match(/event: response.(?:completed|incomplete)\ndata: ([^\n]+)/);
    if (!event) throw new AdapterError("Chat 回應無法轉換成 Responses。", 502);
    const result = JSON.parse(event[1]).response;
    if (body.usage) { const usage = object(body.usage, "usage"); result.usage = { input_tokens: usage.prompt_tokens, output_tokens: usage.completion_tokens, total_tokens: usage.total_tokens }; }
    return Response.json(result);
  }
}

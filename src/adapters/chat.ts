import { ResponsesSse, responsesToChatBody, toolKindsFromResponses, type FreeformToolIdentity } from "../responsesChat";
import { AdapterError, object, list, type AdapterRequest, type ModelApiAdapter } from "./types";
import { claudeToChat } from "./claude-request";
import { thinkingMode, upstreamRequestWithReplay } from "./claude-reasoning";
import { chatToClaude } from "./claude-response";
import { chatToMessagesStream } from "./messages-stream";
import { streamResponse } from "./stream";
import { chatToResponsesStream } from "./chat-stream";
import { jsonResponse, upstreamRequest } from "./transport";
import { ChatToolCalls, chatFinishReason, validateChatContent } from "./chat-output";
import { codexChatTools, restoreChatToolResponse, restoreChatToolStream } from "../codexWire/chat-tools";

export class ChatAdapter implements ModelApiAdapter {
  readonly id = "chat";
  async send(request: AdapterRequest): Promise<Response> {
    const codexTools = request.client === "codex" ? codexChatTools(request.body) : undefined;
    const toolIdentity = (name: string): FreeformToolIdentity => {
      const item = codexTools!.restore({ type: "custom_tool_call", name });
      return { name: String(item.name), ...(typeof item.namespace === "string" ? { namespace: item.namespace } : {}) };
    };
    const hideReasoningSummary = request.client === "codex" && typeof request.body.reasoning === "object" && request.body.reasoning !== null && object(request.body.reasoning, "reasoning").summary === "none";
    const raw = JSON.stringify({ ...request.body, stream: request.body.stream === true });
    const bodyToSend = request.client === "codex" ? object(JSON.parse(responsesToChatBody(raw, request.model)), "Chat request") : claudeToChat(request.body, request.model);
    const { response, abort } = await (request.client === "codex" ? upstreamRequest : upstreamRequestWithReplay)(request, "/v1/chat/completions", bodyToSend);
    if (!response.ok) return response;
    if (request.body.stream) {
      if (request.client === "claude") return streamResponse(chatToMessagesStream(response, request.model, thinkingMode(request.body)), abort);
      return streamResponse(restoreChatToolStream(chatToResponsesStream(response, request.model, toolKindsFromResponses(raw), toolIdentity, hideReasoningSummary), codexTools!.restore), abort);
    }
    return jsonResponse(response, body => {
      if (request.client === "claude") return chatToClaude(body, request.model, thinkingMode(request.body));
      const choice = object(list(body.choices, "choices")[0], "choice");
      const message = object(choice.message, "message");
      validateChatContent(message, true);
      chatFinishReason(choice.finish_reason);
      if (message.tool_calls !== undefined) {
        const tools = new ChatToolCalls();
        tools.add(list(message.tool_calls, "tool_calls").map((call, index) => ({ ...object(call, "tool call"), index })));
        message.tool_calls = tools.completed(toolKindsFromResponses(raw));
      }
      if (choice.finish_reason === "tool_calls" && (!Array.isArray(message.tool_calls) || !message.tool_calls.length)) throw new AdapterError("上游工具呼叫缺少識別資訊。", 502);
      const sse = new ResponsesSse(request.model, toolKindsFromResponses(raw), toolIdentity, hideReasoningSummary);
      sse.pushChatChunk(`data: ${JSON.stringify({ choices: [{ delta: message, finish_reason: choice.finish_reason }], usage: body.usage })}\n\n`);
      const frames = sse.finish();
      const event = frames.match(/event: response.(?:completed|incomplete)\ndata: ([^\n]+)/);
      if (!event) throw new AdapterError("Chat 回應無法轉換成 Responses。", 502);
      const result = JSON.parse(event[1]).response;
      if (body.usage) {
        const usage = object(body.usage, "usage");
        result.usage = { input_tokens: usage.prompt_tokens, output_tokens: usage.completion_tokens, total_tokens: usage.total_tokens };
      }
      return restoreChatToolResponse(result, codexTools!.restore);
    });
  }
}

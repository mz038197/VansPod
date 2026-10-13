import type { AdapterRequest, ModelApiAdapter } from "./types";
import { claudeToResponses } from "./claude-request";
import { thinkingMode, upstreamRequestWithReplay } from "./claude-reasoning";
import { responsesToClaude } from "./claude-response";
import { responsesToMessagesStream } from "./responses-stream";
import { nativeStream, streamResponse } from "./stream";
import { jsonResponse, upstreamRequest } from "./transport";
import { codexResponsesUpstreamBody, normalizeCodexRequest } from "../codexWire/request";
import { CodexResponsesTools } from "../codexWire/responses-tools";

export class ResponsesAdapter implements ModelApiAdapter {
  readonly id = "responses";
  async send(request: AdapterRequest): Promise<Response> {
    const normalized = request.client === "codex" ? normalizeCodexRequest(request.body) : undefined;
    const tools = normalized ? new CodexResponsesTools(normalized) : undefined;
    const body = normalized ? { ...codexResponsesUpstreamBody(normalized), model: request.model } : claudeToResponses(request.body, request.model);
    const { response, abort } = await (normalized ? upstreamRequest : upstreamRequestWithReplay)(request, "/v1/responses", body);
    if (!response.ok) return response;
    if (request.body.stream === true) return streamResponse(request.client === "codex" ? nativeStream(response, "responses", tools?.hasCustomTools ? data => tools.events(data) : undefined) : responsesToMessagesStream(response, request.model, thinkingMode(request.body)), abort);
    if (request.client === "codex") return tools?.hasCustomTools ? jsonResponse(response, body => tools.response(body)) : response;
    return jsonResponse(response, body => responsesToClaude(body, request.model, thinkingMode(request.body)));
  }
}

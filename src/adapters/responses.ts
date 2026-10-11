import type { AdapterRequest, ModelApiAdapter } from "./types";
import { object } from "./types";
import { claudeToResponses } from "./claude-request";
import { responsesToClaude } from "./claude-response";
import { responsesToMessagesStream } from "./responses-stream";
import { nativeStream, streamResponse } from "./stream";
import { upstreamRequest } from "./transport";

export class ResponsesAdapter implements ModelApiAdapter {
  readonly id = "responses";
  async send(request: AdapterRequest): Promise<Response> {
    const body = request.client === "codex" ? { ...request.body, model: request.model } : claudeToResponses(request.body, request.model);
    const { response, abort } = await upstreamRequest(request, "/v1/responses", body);
    if (!response.ok) return response;
    if (request.body.stream === true) return streamResponse(request.client === "codex" ? nativeStream(response, "responses") : responsesToMessagesStream(response, request.model), abort);
    if (request.client === "codex") return response;
    return Response.json(responsesToClaude(object(await response.json(), "Responses response"), request.model));
  }
}

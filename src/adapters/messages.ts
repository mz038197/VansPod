import { AdapterError, type AdapterRequest, type ModelApiAdapter } from "./types";
import { nativeStream, streamResponse } from "./stream";
import { upstreamRequest } from "./transport";

export class MessagesAdapter implements ModelApiAdapter {
  readonly id = "messages";
  async send(request: AdapterRequest): Promise<Response> {
    if (request.client !== "claude") throw new AdapterError("Messages adapter 僅支援 Claude Code。");
    const headers: Record<string, string> = { "Content-Type": "application/json", "anthropic-version": "2023-06-01", Authorization: `Bearer ${request.apiKey}` };
    for (const name of ["anthropic-version", "anthropic-beta"]) if (request.headers?.[name]) headers[name] = request.headers[name];
    const { response, abort } = await upstreamRequest(request, "/v1/messages", { ...request.body, model: request.model }, headers);
    return response.ok && request.body.stream === true ? streamResponse(nativeStream(response, "messages"), abort) : response;
  }
}

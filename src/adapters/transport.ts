import { AdapterError, object, type AdapterRequest, type JsonObject } from "./types";

export async function upstreamRequest(request: AdapterRequest, path: string, body: JsonObject, extraHeaders: Record<string, string> = {}): Promise<{ response: Response; abort: () => void }> {
  const failed = request.record?.(path, body);
  const controller = new AbortController();
  const response = await fetch(`${request.routerBaseUrl.replace(/\/+$/, "")}${path}`, {
    method: "POST", signal: AbortSignal.any([request.signal, controller.signal]),
    headers: { ...extraHeaders, "Content-Type": "application/json", Authorization: `Bearer ${request.apiKey}` },
    body: JSON.stringify(body),
  });
  // Prompt Capture keeps the failing status only, never Router's error body.
  if (!response.ok) failed?.(response.status);
  if (response.ok && body.stream === true && !response.headers.get("content-type")?.includes("text/event-stream")) {
    controller.abort(); throw new AdapterError("上游沒有回傳所要求的 SSE 串流。", 502);
  }
  return { response, abort: () => controller.abort() };
}

export async function jsonResponse(response: Response, convert: (body: JsonObject) => JsonObject): Promise<Response> {
  try { return Response.json(convert(object(await response.json(), "upstream response"))); }
  catch (error) { throw new AdapterError(error instanceof AdapterError ? error.message : "上游 JSON 回應格式無效。", 502); }
}

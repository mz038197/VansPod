import type { UpstreamSend } from "./classroomApp";
import { modelApiAdapter } from "./adapters";
import { AdapterError, object, type AdapterRequest, type RecordUpstream } from "./adapters/types";
import { event } from "./adapters/stream";
import { claudeWebSearch, declaresWebSearch } from "./claudeWebSearch";
import { codexWebSearch } from "./codexWebSearch";
import type http from "node:http";
import { once } from "node:events";
import type { PromptCapture } from "./promptCapture";

export function proxyError(client: "codex" | "claude", message: string, status: number): Response {
  const error = { type: status < 500 ? "invalid_request_error" : "api_error", message };
  return Response.json(client === "claude" ? { type: "error", error } : { error }, { status });
}

// Codex's built-in web search (web__run) posts to /alpha/search on the model base
// URL. It is not a model request, so its body need not name a model at all.
export function isCodexSearch(client: string, path: string | undefined): boolean {
  return client === "codex" && (path ?? "").split("?")[0].endsWith("/alpha/search");
}

function redact(text: string, apiKey: string | undefined): string {
  return apiKey ? text.split(apiKey).join("[redacted]") : text;
}

function redactBody(body: unknown, apiKey: string | undefined): unknown {
  return apiKey ? JSON.parse(redact(JSON.stringify(body), apiKey)) : body;
}

// Prompt Capture sees the body each request sends to Router, never its headers or the Classroom API Key.
function recordUpstream(capture: PromptCapture, upstream: UpstreamSend, adapter: string, raw: unknown): RecordUpstream {
  return (path, sent, options) => capture.record({ client: upstream.client, adapter, path,
    sent: redactBody(sent, upstream.apiKey), raw: redactBody(raw, upstream.apiKey), ...options });
}

export async function sendRouter(upstream: UpstreamSend, baseUrl: string, capture?: PromptCapture): Promise<Response> {
  const client = upstream.client === "claude" ? "claude" : "codex";
  try {
    const path = upstream.path ?? "";
    if (isCodexSearch(client, path)) return await codexWebSearch(upstream, baseUrl);
    const route = path.split("?")[0];
    if (client === "codex" ? !route.endsWith("/responses") : !route.endsWith("/messages")) throw new AdapterError(`此 API 路徑尚未支援所選 adapter：${route}`);
    let body: unknown; try { body = JSON.parse(upstream.body ?? ""); } catch { throw new AdapterError("請求正文必須是有效 JSON。"); }
    const parsed = object(body, "request");
    if (parsed.stream !== undefined && typeof parsed.stream !== "boolean") throw new AdapterError("stream 必須是布林值。");
    const adapter = modelApiAdapter(upstream.adapter ?? "responses");
    const request: AdapterRequest = { client, model: upstream.model, body: parsed,
      apiKey: upstream.apiKey ?? "", routerBaseUrl: baseUrl.replace(/\/+$/, ""), headers: upstream.headers,
      signal: upstream.signal ?? new AbortController().signal };
    if (capture) request.record = recordUpstream(capture, upstream, adapter.id, parsed);
    // Claude Code searches inside a model request: Router runs the searches, not the model upstream.
    const response = declaresWebSearch(request) ? await claudeWebSearch(adapter, request) : await adapter.send(request);
    if (response.ok) return response;
    let message = `Router 回傳 HTTP ${response.status}。`;
    try {
      const body = object(await response.json(), "upstream error");
      const error = typeof body.error === "object" && body.error !== null ? object(body.error, "error") : body;
      if (typeof error.message === "string") message += ` ${error.message}`;
    } catch { /* HTTP status remains useful without exposing an arbitrary upstream body. */ }
    return proxyError(client, redact(message, upstream.apiKey), response.status);
  } catch (error) {
    if (upstream.signal?.aborted) throw error;
    return proxyError(client, error instanceof AdapterError ? error.message : "上游沒有回應或回應格式無效。", error instanceof AdapterError ? error.status : 502);
  }
}

// VS Code Chat already speaks the protocol Router expects: its body goes to Router as is,
// with only the model swapped for the Class Session model.
export async function forwardRouter(upstream: UpstreamSend, baseUrl: string, capture?: PromptCapture): Promise<Response> {
  const path = upstream.path ?? "";
  let raw: unknown; try { raw = JSON.parse(upstream.body ?? ""); } catch { raw = undefined; }
  const sent = raw && typeof raw === "object" && !Array.isArray(raw) ? { ...raw, model: upstream.model } : undefined;
  const markFailed = capture && sent ? recordUpstream(capture, upstream, upstream.adapter ?? "chat", raw)(path, sent) : undefined;
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}${path}`, {
      method: upstream.method ?? "POST",
      headers: { "Content-Type": "application/json", ...(upstream.apiKey ? { Authorization: `Bearer ${upstream.apiKey}` } : {}) },
      body: sent ? JSON.stringify(sent) : upstream.body,
      signal: upstream.signal,
    });
    if (!response.ok) markFailed?.(response.status);
    return response;
  } catch {
    return Response.json({ error: { message: "上游沒有回應。" } }, { status: 502 });
  }
}

export async function relayResponse(response: Response, res: http.ServerResponse, client: "codex" | "claude", signal: AbortSignal): Promise<void> {
  const type = response.headers.get("content-type") ?? "application/json; charset=utf-8";
  res.writeHead(response.status, { "Content-Type": type, "Cache-Control": "no-store" });
  if (!response.body) { res.end(); return; }
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (!signal.aborted && !res.destroyed) {
      const next = await reader.read(); if (next.done) break;
      if (!res.write(next.value)) {
        // AbortSignal also breaks waits when the downstream connection closes.
        await once(res, "drain", { signal });
      }
    }
  } catch {
    if (!signal.aborted && !res.destroyed) {
      if (type.includes("text/event-stream")) res.write(client === "claude"
        ? event("error", { error: { type: "api_error", message: "上游串流中斷或內容無法轉換。" } })
        : event("response.failed", { response: { object: "response", status: "failed", error: { type: "upstream_error", message: "上游串流中斷或內容無法轉換。" } } }));
      else res.destroy();
    }
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {}); reader.releaseLock();
    if (!res.destroyed) res.end();
  }
}

import type { UpstreamSend } from "./classroomApp";
import { modelApiAdapter } from "./adapters";
import { AdapterError, object } from "./adapters/types";
import { event } from "./adapters/stream";
import type http from "node:http";
import { once } from "node:events";
import fs from "node:fs/promises";
import nodePath from "node:path";

export function proxyError(client: "codex" | "claude", message: string, status: number): Response {
  const error = { type: status < 500 ? "invalid_request_error" : "api_error", message };
  return Response.json(client === "claude" ? { type: "error", error } : { error }, { status });
}

// Temporary diagnostic for #23: writes one JSON file per search request so real
// Codex and Claude Code samples can be collected. Off unless a directory is given
// (CLASSROOM_APP_CAPTURE_SEARCH_DIR in start.ts). Headers are never written, and
// the Classroom API Key and any credential header value are scrubbed from the rest.
let captureCount = 0;
async function captureSearchRequest(directory: string, client: "codex" | "claude", upstream: UpstreamSend): Promise<void> {
  try {
    const secrets = [upstream.apiKey ?? "", ...Object.entries(upstream.headers ?? {}).filter(([name]) => /authorization|api-key|cookie|token/i.test(name))
      .flatMap(([, value]) => [value, value.replace(/^\S+\s+/, "")])].filter(Boolean).sort((a, b) => b.length - a.length);
    const redact = (text: string) => secrets.reduce((result, secret) => result.split(secret).join("[redacted]"), text);
    const raw = redact(upstream.body ?? "");
    let body: unknown = raw; try { body = JSON.parse(raw); } catch { /* keep the text: a malformed sample is still a sample */ }
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(nodePath.join(directory, `${Date.now()}-${String(++captureCount).padStart(4, "0")}-${client}.json`),
      JSON.stringify({ client, method: upstream.method, path: redact(upstream.path ?? ""), body }, null, 2), { flag: "wx" });
  } catch { /* a failed recording must never change what the client gets back */ }
}

export async function sendRouter(upstream: UpstreamSend, baseUrl: string, captureSearchDirectory?: string): Promise<Response> {
  const client = upstream.client === "claude" ? "claude" : "codex";
  try {
    const path = upstream.path ?? "";
    // Codex's built-in web search (web__run) posts to /alpha/search on the model
    // base URL. Classroom Router has no search backend, so tell the model plainly;
    // the generic message made it retry the same tool over and over.
    // The English half is addressed to the model, which reads this text verbatim.
    // It must not hint at any other route to the information: an earlier wording
    // did, and the model crawled sites from the shell for minutes (ADR-0007).
    const route = path.split("?")[0];
    if (client === "codex" && route.endsWith("/alpha/search") && captureSearchDirectory) await captureSearchRequest(captureSearchDirectory, client, upstream);
    if (client === "codex" && route.endsWith("/alpha/search")) throw new AdapterError("課堂模式不支援 Codex 內建的網路搜尋。Classroom mode has no web search capability. Do not retry this tool. Do not use shell commands (curl, wget, scripts) to fetch web pages. Tell the user directly that web search is not available in this classroom session.");
    if (client === "codex" ? !route.endsWith("/responses") : !route.endsWith("/messages")) throw new AdapterError(`此 API 路徑尚未支援所選 adapter：${route}`);
    let body: unknown; try { body = JSON.parse(upstream.body ?? ""); } catch { throw new AdapterError("請求正文必須是有效 JSON。"); }
    const parsed = object(body, "request");
    // Claude Code's WebSearch is an ordinary messages request whose tools declare
    // Anthropic's server-side search tool (type web_search_<date>, with max_uses).
    if (captureSearchDirectory && client === "claude" && Array.isArray(parsed.tools) && parsed.tools.some(tool => typeof tool?.type === "string" && tool.type.startsWith("web_search")))
      await captureSearchRequest(captureSearchDirectory, client, upstream);
    if (parsed.stream !== undefined && typeof parsed.stream !== "boolean") throw new AdapterError("stream 必須是布林值。");
    const response = await modelApiAdapter(upstream.adapter ?? "responses").send({ client, model: upstream.model, body: parsed,
      apiKey: upstream.apiKey ?? "", routerBaseUrl: baseUrl.replace(/\/+$/, ""), headers: upstream.headers,
      signal: upstream.signal ?? new AbortController().signal });
    if (response.ok) return response;
    let message = `Router 回傳 HTTP ${response.status}。`;
    try {
      const body = object(await response.json(), "upstream error");
      const error = typeof body.error === "object" && body.error !== null ? object(body.error, "error") : body;
      if (typeof error.message === "string") message += ` ${error.message}`;
    } catch { /* HTTP status remains useful without exposing an arbitrary upstream body. */ }
    if (upstream.apiKey) message = message.split(upstream.apiKey).join("[redacted]");
    return proxyError(client, message, response.status);
  } catch (error) {
    if (upstream.signal?.aborted) throw error;
    return proxyError(client, error instanceof AdapterError ? error.message : "上游沒有回應或回應格式無效。", error instanceof AdapterError ? error.status : 502);
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

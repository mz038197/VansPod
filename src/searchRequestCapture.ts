import fs from "node:fs/promises";
import nodePath from "node:path";
import type http from "node:http";
import { isCodexSearch } from "./modelProxy";

// Temporary diagnostic for #23: writes one JSON file per search request a Client
// Route receives, so real Codex and Claude Code samples can be collected. Off unless
// start.ts is given a directory. Removal: docs/verification/search-request-capture.md.

export type ReceivedRequest = {
  client: "codex" | "claude";
  method?: string;
  /** As received, query string included. */
  url?: string;
  headers: http.IncomingHttpHeaders;
  body: string;
  /** Asked only for a search request; a failed lookup records nothing. */
  classroomApiKey(): Promise<string | undefined>;
};

let written = 0;

// Claude Code's WebSearch is an ordinary messages request whose tools declare
// Anthropic's server-side search tool (type web_search_<date>, with max_uses).
function isSearch(request: ReceivedRequest): boolean {
  if (request.client === "codex") return isCodexSearch(request.client, request.url);
  if (!(request.url ?? "").split("?")[0].endsWith("/messages")) return false;
  try {
    const tools: unknown = JSON.parse(request.body)?.tools;
    return Array.isArray(tools) && tools.some(tool => typeof tool?.type === "string" && tool.type.startsWith("web_search"));
  } catch { return false; }
}

// Headers are never written. What the client put in its credential headers, and the
// Classroom API Key, are replaced wherever they recur in the path or body: verbatim,
// URL-encoded or JSON-escaped. Pieces under 8 characters are left alone, because
// replacing every "1" of a cookie "a=1" would destroy the sample without hiding a secret.
function redactor(headers: http.IncomingHttpHeaders, apiKey: string | undefined): (text: string) => string {
  const secrets = [apiKey ?? ""];
  for (const [name, value] of Object.entries(headers)) {
    if (!/authorization|api-key|cookie|token/i.test(name)) continue;
    // "Bearer x" and "a=1; b=2" carry their credentials as parts of the value.
    for (const whole of [value ?? []].flat()) secrets.push(whole, ...whole.split(/[\s;,]+/).flatMap(part => [part, part.slice(part.indexOf("=") + 1)]));
  }
  const forms = new Set(secrets.filter(secret => secret.length >= 8).flatMap(secret => {
    const encoded = encodeURIComponent(secret);
    return [secret, encoded, encoded.replace(/%[0-9A-F]{2}/g, escape => escape.toLowerCase()), JSON.stringify(secret).slice(1, -1)];
  }));
  const longestFirst = [...forms].sort((a, b) => b.length - a.length);
  return text => longestFirst.reduce((result, form) => result.split(form).join("[redacted]"), text);
}

function redactJson(value: unknown, redact: (text: string) => string): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(item => redactJson(item, redact));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key), redactJson(item, redact)]));
  return value;
}

export async function captureSearchRequest(directory: string, request: ReceivedRequest): Promise<void> {
  try {
    if (!isSearch(request)) return;
    const redact = redactor(request.headers, await request.classroomApiKey());
    // Parsed strings are redacted after decoding, so no JSON escape can hide a secret.
    let body: unknown; try { body = redactJson(JSON.parse(request.body), redact); } catch { body = redact(request.body); /* a malformed sample is still a sample */ }
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(nodePath.join(directory, `${Date.now()}-${String(++written).padStart(4, "0")}-${request.client}.json`),
      JSON.stringify({ client: request.client, method: request.method, path: redact(request.url ?? ""), body }, null, 2), { flag: "wx" });
  } catch { /* a failed recording must never change what the client gets back */ }
}

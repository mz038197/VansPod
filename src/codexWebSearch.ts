import type { UpstreamSend } from "./classroomApp";
import { AdapterError, object } from "./adapters/types";
import { MAX_QUERY_LENGTH, NO_SHELL, explainSearchFailure, webSearch, type WebSearchResult } from "./webSearch";

// Codex's web__run tool posts every command to /alpha/search and reads the reply as
// codex-api's SearchResponse { encrypted_output, output, results }: `output` is the
// text handed to the model, `results` only feeds the client's own display.
// Router's POST /v1/search knows none of this (ADR-0007); the translation lives here.
// A failure is still a 200: Codex treats a non-2xx reply as fatal to the whole turn
// (and retries 5xx first), so the model would never get to tell the student why.

const MAX_QUERIES = 3;

function unsupported(commands: string[]): string {
  return `課堂模式的網路搜尋只支援以關鍵字搜尋。${commands.length ? `These web commands are not supported in this classroom session and were not run: ${commands.join(", ")}.` : "This request named no search_query, and nothing else is supported in this classroom session."} Only search_query (searching by query text) is supported; its results already include a text snippet of each page. Do not retry the unsupported commands. ${NO_SHELL} If that is not enough, tell the user this classroom session cannot do it.`;
}

function envelope(output: string, results: WebSearchResult[] = []): Response {
  return Response.json({ encrypted_output: null, output,
    results: results.map((result, index) => ({ type: "text_result", ref_id: `turn0search${index}`, url: result.url, title: result.title, snippet: result.text })) });
}

function resultsText(queries: string[], results: WebSearchResult[]): string {
  if (results.length === 0) return `No web search results were found for: ${queries.join(" | ")}`;
  return [`Web search results for: ${queries.join(" | ")}`,
    ...results.map((result, index) => `[${index + 1}] ${result.title}\nURL: ${result.url}\n${result.text}`)].join("\n\n");
}

export async function codexWebSearch(upstream: UpstreamSend, baseUrl: string): Promise<Response> {
  let body: unknown; try { body = JSON.parse(upstream.body ?? ""); } catch { throw new AdapterError("請求正文必須是有效 JSON。"); }
  const commands = object(object(body, "request").commands ?? {}, "commands");
  const queries = (Array.isArray(commands.search_query) ? commands.search_query : [])
    .map(item => { const q = (item as { q?: unknown } | null)?.q; return typeof q === "string" ? q.trim().slice(0, MAX_QUERY_LENGTH) : ""; })
    .filter(Boolean).slice(0, MAX_QUERIES);
  // response_length only shapes a search; every other key is a command Router does not run.
  const unsupportedCommands = Object.keys(commands).filter(name => name !== "search_query" && name !== "response_length"
    && commands[name] != null && !(Array.isArray(commands[name]) && (commands[name] as unknown[]).length === 0));
  if (queries.length === 0) return envelope(unsupported(unsupportedCommands));
  const reply = await webSearch(queries, baseUrl, upstream.apiKey ?? "", upstream.signal);
  if ("errorCode" in reply) return envelope(explainSearchFailure(reply.errorCode));
  return envelope(resultsText(queries, reply.results) + (unsupportedCommands.length ? `\n\n${unsupported(unsupportedCommands)}` : ""), reply.results);
}

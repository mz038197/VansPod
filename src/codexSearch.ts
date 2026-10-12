import type { UpstreamSend } from "./classroomApp";
import { AdapterError, list, object } from "./adapters/types";

// Codex's web__run tool posts every command to /alpha/search and reads the reply as
// codex-api's SearchResponse { encrypted_output, output, results }: `output` is the
// text handed to the model, `results` only feeds the client's own display.
// Router's POST /v1/search knows none of this (ADR-0007); the translation lives here.

type RouterResult = { query: string; title: string; url: string; text: string };

const MAX_QUERIES = 3;
export const MAX_QUERY_LENGTH = 1000;

// Every explanation below is read verbatim by the model, hence the English half; Claude
// Code's search loop (claudeWebSearch.ts) gives the same ones for the same Router code. A
// failure is still a 200: Codex treats a non-2xx reply as fatal to the whole turn
// (and retries 5xx first), so the model would never get to tell the student why.
// None of them may hint at another route to the information: an earlier refusal
// did, and the model crawled sites from the shell for minutes (ADR-0007).
export const NO_SHELL = "Do not use shell commands (curl, wget, scripts) to fetch web pages.";
export const EXPLANATIONS: Record<string, string> = {
  web_search_disabled: `這堂課沒有開放網路搜尋。Web search is not enabled for this class session. This is a class setting, not a malfunction, and no search was performed. Do not retry this tool. ${NO_SHELL} Tell the user directly that web search is not enabled for this class session.`,
  web_search_rate_limited: `搜尋太頻繁，請稍後再試。Web search is temporarily rate limited: there were too many searches in the last minute, so no search was performed. Do not retry this tool now. ${NO_SHELL} Tell the user to wait about a minute and then ask again.`,
  web_search_unavailable: `網路搜尋服務目前無法使用。The classroom web search service is not available right now. This is a service problem, not a class setting, and no search was performed. Do not retry this tool. ${NO_SHELL} Tell the user that web search is currently out of service and that they can report it to their teacher.`,
};
export const SEARCH_FAILED = `搜尋失敗，沒有取得結果。The web search failed: the search service returned an error, so there are no results. This is not a class setting. You may retry this tool once; if it fails again, tell the user that the search failed and that they can try again later. ${NO_SHELL}`;

function unsupported(names: string[]): string {
  return `課堂模式的網路搜尋只支援以關鍵字搜尋。${names.length ? `These web commands are not supported in this classroom session and were not run: ${names.join(", ")}.` : "This request named no search_query, and nothing else is supported in this classroom session."} Only search_query (searching by query text) is supported; its results already include a text snippet of each page. Do not retry the unsupported commands. ${NO_SHELL} If that is not enough, tell the user this classroom session cannot do it.`;
}

function envelope(output: string, results: RouterResult[] = []): Response {
  return Response.json({ encrypted_output: null, output,
    results: results.map((result, index) => ({ type: "text_result", ref_id: `turn0search${index}`, url: result.url, title: result.title, snippet: result.text })) });
}

function text(value: unknown): string { return typeof value === "string" ? value : ""; }

function resultsText(queries: string[], results: RouterResult[]): string {
  if (results.length === 0) return `No web search results were found for: ${queries.join(" | ")}`;
  return [`Web search results for: ${queries.join(" | ")}`,
    ...results.map((result, index) => `[${index + 1}] ${result.title}\nURL: ${result.url}\n${result.text}`)].join("\n\n");
}

// Router relays its search provider's HTTP status (a provider 429 arrives as 429 with
// code null), so the error code alone tells a refusal from an upstream failure.
export async function routerErrorCode(response: Response): Promise<string> {
  try { return text((object(await response.json(), "search error").error as { code?: unknown } | null)?.code); } catch { return ""; }
}

async function failure(response: Response): Promise<string> {
  return EXPLANATIONS[await routerErrorCode(response)] ?? SEARCH_FAILED;
}

export async function codexSearch(upstream: UpstreamSend, baseUrl: string): Promise<Response> {
  let body: unknown; try { body = JSON.parse(upstream.body ?? ""); } catch { throw new AdapterError("請求正文必須是有效 JSON。"); }
  const commands = object(object(body, "request").commands ?? {}, "commands");
  const queries = (Array.isArray(commands.search_query) ? commands.search_query : [])
    .map(item => text((item as { q?: unknown } | null)?.q).trim().slice(0, MAX_QUERY_LENGTH)).filter(Boolean).slice(0, MAX_QUERIES);
  // response_length only shapes a search; every other key is a command Router does not run.
  const others = Object.keys(commands).filter(name => name !== "search_query" && name !== "response_length"
    && commands[name] != null && !(Array.isArray(commands[name]) && (commands[name] as unknown[]).length === 0));
  if (queries.length === 0) return envelope(unsupported(others));
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/v1/search`, {
      method: "POST", signal: upstream.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${upstream.apiKey ?? ""}` },
      body: JSON.stringify({ queries }),
    });
    if (!response.ok) return envelope(await failure(response));
    const results = list(object(await response.json(), "search response").results, "results").map(item => {
      const result = object(item, "search result");
      return { query: text(result.query), title: text(result.title), url: text(result.url), text: text(result.text) };
    });
    return envelope(resultsText(queries, results) + (others.length ? `\n\n${unsupported(others)}` : ""), results);
  } catch (error) {
    if (upstream.signal?.aborted) throw error;
    return envelope(SEARCH_FAILED);
  }
}

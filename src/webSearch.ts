import { list, object } from "./adapters/types";

// Web Search (CONTEXT.md) is Router's POST /v1/search: query strings in, the title, URL
// and a text excerpt of each result out (ADR-0007). Router knows no client's format, so
// Codex (codexWebSearch.ts) and Claude Code (claudeWebSearch.ts) each translate their
// own around this one call, and tell the model about a failure in the same words.

export type WebSearchResult = { query: string; title: string; url: string; text: string };

/** Router's result list, or the error code it refused with ("" for any other failure). */
export type WebSearchReply = { results: WebSearchResult[] } | { errorCode: string };

export const MAX_QUERY_LENGTH = 1000;

// Every explanation below is read verbatim by the model, hence the English half. None
// of them may hint at another route to the information: an earlier refusal did, and the
// model crawled sites from the shell for minutes (ADR-0007).
export const NO_SHELL = "Do not use shell commands (curl, wget, scripts) to fetch web pages.";
const ROUTER_REFUSALS: Record<string, string> = {
  web_search_disabled: `這堂課沒有開放網路搜尋。Web search is not enabled for this class session. This is a class setting, not a malfunction, and no search was performed. Do not retry this tool. ${NO_SHELL} Tell the user directly that web search is not enabled for this class session.`,
  web_search_rate_limited: `搜尋太頻繁，請稍後再試。Web search is temporarily rate limited: there were too many searches in the last minute, so no search was performed. Do not retry this tool now. ${NO_SHELL} Tell the user to wait about a minute and then ask again.`,
  web_search_unavailable: `網路搜尋服務目前無法使用。The classroom web search service is not available right now. This is a service problem, not a class setting, and no search was performed. Do not retry this tool. ${NO_SHELL} Tell the user that web search is currently out of service and that they can report it to their teacher.`,
};
const SEARCH_FAILED = `搜尋失敗，沒有取得結果。The web search failed: the search service returned an error, so there are no results. This is not a class setting. You may retry this tool once; if it fails again, tell the user that the search failed and that they can try again later. ${NO_SHELL}`;

/** What the model is told when a search failed with this Router error code. */
export function explainSearchFailure(errorCode: string): string {
  return ROUTER_REFUSALS[errorCode] ?? SEARCH_FAILED;
}

function textOf(value: unknown): string { return typeof value === "string" ? value : ""; }

// Router relays its search provider's HTTP status (a provider 429 arrives as 429 with
// code null), so the error code alone tells a refusal from an upstream failure.
async function routerErrorCode(response: Response): Promise<string> {
  try { return textOf((object(await response.json(), "search error").error as { code?: unknown } | null)?.code); } catch { return ""; }
}

// Only the query strings and the Classroom API Key leave. An unreachable Router or a
// reply that is not a result list is a failure like any other; an abort is the caller's.
export async function webSearch(queries: string[], routerBaseUrl: string, classroomApiKey: string, signal?: AbortSignal): Promise<WebSearchReply> {
  try {
    const response = await fetch(`${routerBaseUrl.replace(/\/+$/, "")}/v1/search`, {
      method: "POST", signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${classroomApiKey}` },
      body: JSON.stringify({ queries }),
    });
    if (!response.ok) return { errorCode: await routerErrorCode(response) };
    return { results: list(object(await response.json(), "search response").results, "results").map(item => {
      const result = object(item, "search result");
      return { query: textOf(result.query), title: textOf(result.title), url: textOf(result.url), text: textOf(result.text) };
    }) };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { errorCode: "" };
  }
}

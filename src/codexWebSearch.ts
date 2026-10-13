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

// open, click and find read a page Codex already knows the address of. That is not Web
// Search (CONTEXT.md): no Router call and no class switch, the agent fetches it itself.
const READ_COMMANDS = ["open", "click", "find"];

function readYourself(commands: Record<string, unknown>, names: string[]): string {
  const refs = names.flatMap(name => Array.isArray(commands[name]) ? commands[name] as unknown[] : [])
    .map(item => (item as { ref_id?: unknown } | null)?.ref_id)
    .filter((ref): ref is string => typeof ref === "string" && ref.length <= MAX_QUERY_LENGTH);
  const urls = [...new Set(refs.filter(ref => /^https?:\/\/\S+$/.test(ref)))];
  // The model reads only `output`, which lists each result's URL and never its ref_id.
  const id = refs.find(ref => /^\w+$/.test(ref));
  return [`課堂模式沒有開網頁的指令，要讀的網頁請自行讀取。The ${names.join(", ")} command${names.length > 1 ? "s are" : " is"} not run for you in this classroom session. To read a page, fetch it yourself.`,
    ...(urls.length ? [`Requested: ${urls.join(" ")}`] : []),
    "Fetch only the page you asked for, once, with a single shell command; keep the readable text rather than the full HTML, and truncate long output.",
    ...(id ? [`A reference id such as ${id} is not kept in this classroom session: use the URL listed for that result in the web search results, or the URL of the page you fetched.`] : []),
    ...(names.includes("click") ? ["For a numbered link, find the link in the page you fetched and fetch the URL that link points to."] : []),
    ...(names.includes("find") ? ["To find text in a page, fetch the page and search its text for the pattern yourself."] : []),
    "Do not follow links from a page on your own. To read another page, call open or click again and the same applies to that page."].join(" ");
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
  const otherCommands = Object.keys(commands).filter(name => name !== "search_query" && name !== "response_length"
    && commands[name] != null && !(Array.isArray(commands[name]) && (commands[name] as unknown[]).length === 0));
  const readCommands = otherCommands.filter(name => READ_COMMANDS.includes(name));
  const unsupportedCommands = otherCommands.filter(name => !READ_COMMANDS.includes(name));
  const notes = [...(readCommands.length ? [readYourself(commands, readCommands)] : []),
    ...(unsupportedCommands.length || (queries.length === 0 && readCommands.length === 0) ? [unsupported(unsupportedCommands)] : [])];
  if (queries.length === 0) return envelope(notes.join("\n\n"));
  const reply = await webSearch(queries, baseUrl, upstream.apiKey ?? "", upstream.signal);
  if ("errorCode" in reply) return envelope([explainSearchFailure(reply.errorCode), ...notes].join("\n\n"));
  return envelope([resultsText(queries, reply.results), ...notes].join("\n\n"), reply.results);
}

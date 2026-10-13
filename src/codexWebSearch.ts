import type { UpstreamSend } from "./classroomApp";
import { AdapterError, object } from "./adapters/types";
import { MAX_QUERY_LENGTH, explainSearchFailure, webSearch, type WebSearchResult } from "./webSearch";

// Codex's web__run tool posts every command to /alpha/search and reads the reply as
// codex-api's SearchResponse { encrypted_output, output, results }: `output` is the
// text handed to the model, `results` only feeds the client's own display.
// Router's POST /v1/search knows none of this (ADR-0007); the translation lives here.
// A failure is still a 200: Codex treats a non-2xx reply as fatal to the whole turn
// (and retries 5xx first), so the model would never get to tell the student why.

const MAX_QUERIES = 3;

// These commands have no stand-in at all, so the ban here is wider than NO_SHELL's: one
// curl to a weather or quote site is not a search, yet it is exactly what must not happen.
function unsupported(commands: string[]): string {
  return `課堂模式沒有這些網路指令。${commands.length ? `These web commands are not supported in this classroom session and were not run: ${commands.join(", ")}.` : "This request named no web command that this classroom session runs."} Searching is done with search_query (searching by query text); its results already include a text snippet of each page. Do not retry the unsupported commands. Do not use shell commands (curl, wget, scripts) to get that information some other way. If that is not enough, tell the user this classroom session cannot do it.`;
}

// open, click and find read a page Codex already knows the address of. That is not Web
// Search (CONTEXT.md): Router is not called, so whether the Class Session allows Web
// Search is never asked, and the Coding Agent fetches the page itself.
const READ_COMMANDS = ["open", "click", "find"];
// What is written back to the model; a longer ref_id is still answered, just not quoted.
const MAX_URL_LENGTH = 2000;

/** `afterRefusal`: the reply already carries a refusal this must not be read as part of. */
function readYourself(commands: Record<string, unknown>, names: string[], afterRefusal: boolean): string {
  const refs = names.flatMap(name => Array.isArray(commands[name]) ? commands[name] as unknown[] : [])
    .map(item => (item as { ref_id?: unknown } | null)?.ref_id)
    .filter((ref): ref is string => typeof ref === "string");
  const urls = [...new Set(refs.filter(ref => ref.length <= MAX_URL_LENGTH && /^https?:\/\/\S+$/i.test(ref)))];
  // The model reads only `output`, where resultsText numbers the results from 1 and
  // never prints the ref_id (turn0search0 is result [1]) that envelope gives the client.
  const referenceId = refs.find(ref => /^\w{1,64}$/.test(ref));
  const resultNumber = /^turn\d+search(\d+)$/.exec(referenceId ?? "");
  return [`課堂模式沒有開網頁的指令，要讀的網頁請自行讀取。The ${names.join(", ")} command${names.length > 1 ? "s are" : " is"} not run for you in this classroom session.`,
    ...(afterRefusal ? ["This is separate from the above: reading a page is not a web search, and asking to read a page is not retrying it."] : []),
    "To read a page, fetch it yourself.",
    ...(urls.length ? [`Requested: ${urls.join(" ")}`] : []),
    "Fetch only the page you asked for, once, with a single shell command; keep the readable text rather than the full HTML, and truncate long output.",
    ...(resultNumber ? [`Reference ids are not kept in this classroom session: ${referenceId} is result [${Number(resultNumber[1]) + 1}] of your latest web search results, so use the URL listed there.`]
      : referenceId ? [`A reference id such as ${referenceId} is not kept in this classroom session: use the URL of the page itself.`] : []),
    ...(names.includes("click") ? ["Link numbers are not kept either: for a numbered link, fetch the page, find the link you meant, and then fetch the URL it points to."] : []),
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
  const nothingToRun = queries.length === 0 && readCommands.length === 0;
  const reply = queries.length ? await webSearch(queries, baseUrl, upstream.apiKey ?? "", upstream.signal) : undefined;
  const failure = reply && "errorCode" in reply ? explainSearchFailure(reply.errorCode) : undefined;
  const refusals = [...(failure ? [failure] : []), ...(unsupportedCommands.length || nothingToRun ? [unsupported(unsupportedCommands)] : [])];
  // The permission to read a page comes last, after every refusal it is an exception to.
  const output = [...(reply && "results" in reply ? [resultsText(queries, reply.results)] : []), ...refusals,
    ...(readCommands.length ? [readYourself(commands, readCommands, refusals.length > 0)] : [])].join("\n\n");
  return envelope(output, reply && "results" in reply ? reply.results : []);
}

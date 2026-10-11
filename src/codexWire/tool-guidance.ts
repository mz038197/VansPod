import { list, object, type JsonObject } from "../adapters/types";

// Tool prompt contracts aligned with opencodex 2.81.0 (19bd34a), adapted
// to VansPod's reversible wire names. No runtime dependency on opencodex.
export const CODE_MODE_RESULT_ECHO_SENTENCE =
  "Nothing in the isolate is echoed automatically: a bare trailing `await tools.<name>(...)` or final expression value is DISCARDED, and the cell reports empty output. Pass anything you need to read to `text(...)` (or `notify(...)`) in the same cell — for example `text(JSON.stringify(await tools.exec_command({cmd: 'ls'})))` — and treat an empty result as your own missing `text(...)` call rather than a failed command or lost context.";

export const CODE_MODE_HOST_CONTRACT_SENTENCE =
  "Host contract for the nested helpers: `tools.apply_patch(patch)` takes exactly one string, never an object such as `{input: ...}`; the patch text opens with the bare marker line `*** Begin Patch` and closes with the bare marker line `*** End Patch`, written without a code fence, prose, or extra asterisks on those lines (blank lines or indentation around the markers are tolerated; a decorated or missing marker is rejected). The isolate has no `import`, `require`, or module loader; use the globals the exec tool description lists (for example `tools`, `text`, `notify`, `store`/`load`, `ALL_TOOLS`). For a command that may outlive `yield_time_ms`, let `tools.exec_command` return a `session_id` and poll it on later calls with `tools.write_stdin({session_id, chars: \"\"})` instead of blocking a shell in a sleep loop.";

const NEIGHBOR_AGENT_TOOL_NAMES = ["Read", "Grep", "Glob", "Bash", "LS"] as const;
function quoteNames(names: readonly string[]): string { return names.map(name => "`" + name + "`").join(", "); }
function uniqueNames(names: readonly string[]): string[] { return [...new Set(names.filter(name => name.trim().length > 0))]; }
function codeModeExecWireName(
  advertised: ReadonlySet<string>,
  verifiedName: string | undefined,
): string | undefined {
  if (!verifiedName) return undefined;
  return advertised.has(verifiedName) ? verifiedName : undefined;
}

function buildToolCatalogNudge(
  wireNames: readonly string[] | undefined,
  codeModeExecName?: string,
): string | undefined {
  const names = uniqueNames(wireNames ?? []);
  if (names.length === 0) return undefined;

  const advertised = new Set(names);
  const unavailableNeighborNames = NEIGHBOR_AGENT_TOOL_NAMES.filter(
    name => !advertised.has(name),
  );
  const verifiedCodeModeExecName = codeModeExecWireName(advertised, codeModeExecName);

  return [
    "Tool contract: use the current tool catalog as ground truth.",
    "Valid tool names for this turn are exactly " + quoteNames(names) + ".",
    "These listed names are the complete top-level tool-call surface for this turn.",
    "Call only listed names with their listed argument keys; do not invent, translate, or rename tools.",
    "Names mentioned only in instructions, tool descriptions, argument descriptions, or nested helper APIs are not additional top-level tools.",
    verifiedCodeModeExecName
      ? "`" + verifiedCodeModeExecName + "` is Codex code mode: its body is JavaScript evaluated in a V8 isolate. Nested helpers are called INSIDE that body as `await tools.<name>(...)`, for example `await tools.exec_command({cmd: \"ls\"})` or `await tools.codex_app__list_threads({})`. Absence from the top-level catalog or from `" + verifiedCodeModeExecName + "`'s description is not absence: deferred helpers stay callable on `tools.<name>`. Discover them from the isolate global `ALL_TOOLS`, not `tools.ALL_TOOLS`. Do not skip an available nested helper because it is omitted from the listed top-level names. " + CODE_MODE_RESULT_ECHO_SENTENCE + " Nested `tools.apply_patch(input)` is host-executed: the string must begin exactly with `*** Begin Patch` and end with `*** End Patch`, each marker line being three asterisks, one space, the two words, then end of line with no further asterisks. VansPod does not rewrite JavaScript inside exec, so extra asterisks on a marker line are rejected by Codex before the file is touched. " + CODE_MODE_HOST_CONTRACT_SENTENCE
      : "If a listed tool exposes nested helpers such as a tools.* API, call the listed parent tool and use those helpers only inside that tool's input.",
    unavailableNeighborNames.length > 0
      ? "Do not use neighboring-agent tool names " + quoteNames(unavailableNeighborNames) + " unless this turn's catalog lists those exact names."
      : undefined,
    "If you need shell, file search, file read, edit, or discovery behavior, choose the listed tool that provides that capability.",
    "Count a tool call only after its tool result returns; batch independent read-only calls when the runtime supports it.",
  ].filter((line): line is string => typeof line === "string").join(" ");
}


interface ToolIdentity { name: string; namespace?: string; custom: boolean; }
function identities(tools: unknown[], namespace?: string): ToolIdentity[] {
  return tools.flatMap(value => {
    const tool = object(value, "tool");
    if (tool.type === "namespace") return identities(list(tool.tools, "namespace tools"), String(tool.name));
    const fn = tool.function ? object(tool.function, "function") : tool;
    return [{ name: String(fn.name), namespace, custom: tool.type === "custom" }];
  });
}
function builtin(tool: ToolIdentity): boolean { return tool.namespace === undefined || tool.namespace === "functions"; }
function selected(tool: ToolIdentity, choice: unknown): boolean {
  if (choice === "none") return false;
  if (!choice || typeof choice === "string") return true;
  const selector = object(choice, "tool_choice");
  if (selector.type === "allowed_tools") return list(selector.tools, "allowed tools").some(value => selected(tool, value));
  const fn = selector.function ? object(selector.function, "tool choice function") : selector;
  return fn.name === tool.name && (fn.namespace === undefined ? builtin(tool) : fn.namespace === tool.namespace);
}
export function codexToolGuidance(body: JsonObject, wireNames?: readonly string[]): { catalog?: string; codeMode: boolean; execNames: ReadonlySet<string> } {
  const tools = body.tools === undefined ? [] : identities(list(body.tools, "tools"));
  const visible = tools.map((tool, index) => ({ tool, name: wireNames?.[index] ?? tool.name })).filter(({ tool }) => selected(tool, body.tool_choice));
  const exec = visible.find(({ tool }) => builtin(tool) && tool.name === "exec" && tool.custom);
  const codeMode = !!exec && !visible.some(({ tool }) => builtin(tool) && ["exec_command", "shell_command"].includes(tool.name));
  return { catalog: buildToolCatalogNudge(visible.map(value => value.name), codeMode ? exec?.name : undefined),
    codeMode, execNames: new Set(codeMode ? [exec!.name] : []) };
}
export function appendToolInstructions(instructions: string, sentences: readonly string[]): string {
  return sentences.reduce((acc, sentence) => acc.includes(sentence) ? acc : [acc, sentence].filter(Boolean).join("\n\n"), instructions);
}
export function codeModeInputDescription(existing?: string): string {
  return appendToolInstructions(existing ?? "", ["JavaScript source for unified exec; do not provide a bare shell command.", CODE_MODE_RESULT_ECHO_SENTENCE]);
}

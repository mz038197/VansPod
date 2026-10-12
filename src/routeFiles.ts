import { isDeepStrictEqual } from "node:util";
import { clientSettingsBackup, optionalText } from "./clientSettingsBackup";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

export const VS_CODE_ENV = "claudeCode.environmentVariables";

export function anthropicBaseValues(env: unknown): unknown[] {
  if (Array.isArray(env)) {
    return env
      .filter(isAnthropicBaseEntry)
      .map((entry) => (entry as { value?: unknown }).value);
  }
  if (env && typeof env === "object") {
    return [(env as Record<string, unknown>).ANTHROPIC_BASE_URL];
  }
  return [];
}

function withoutVsCodeBaseUrl(
  doc: Record<string, unknown>,
): Record<string, unknown> {
  const env = doc[VS_CODE_ENV];
  if (Array.isArray(env)) {
    return {
      ...doc,
      [VS_CODE_ENV]: env.filter((entry) => !isAnthropicBaseEntry(entry)),
    };
  }
  if (env && typeof env === "object") {
    return {
      ...doc,
      [VS_CODE_ENV]: withoutEnvKey(
        env as Record<string, unknown>,
        "ANTHROPIC_BASE_URL",
      ),
    };
  }
  return { ...doc };
}

function isAnthropicBaseEntry(entry: unknown): boolean {
  return (
    !!entry &&
    typeof entry === "object" &&
    (entry as { name?: unknown }).name === "ANTHROPIC_BASE_URL"
  );
}

function withoutManagedVsCodeBaseUrl(doc: Record<string, unknown>, proxy: string): Record<string, unknown> {
  const env = doc[VS_CODE_ENV];
  if (!Array.isArray(env)) return withoutVsCodeBaseUrl(doc);
  return { ...doc, [VS_CODE_ENV]: env.filter(entry => !isAnthropicBaseEntry(entry) || !isManagedUrl((entry as { value?: unknown }).value, proxy)) };
}

function withoutEnvKey(
  doc: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const next = { ...doc };
  delete next[key];
  return next;
}

export type RouteFilePaths = {
  codex: string;
  claude: string;
  vsCode: string;
};

export type CodexRouteOptions = {
  mode: "classroom";
  ids: string[];
  selectedModel: string;
  proxyBaseUrl: string;
  restart?: boolean;
} | { mode: "native"; proxyBaseUrl: string };

export function createRouteFiles(paths: RouteFilePaths) {
  const codexBackup = clientSettingsBackup(path.join(path.dirname(paths.codex), "classroom-codex-settings-backup.json"), {
    config: { file: paths.codex, restore: restoreTomlFields },
    cache: { file: path.join(path.dirname(paths.codex), "models_cache.json"), restore: current => current },
    catalog: { file: path.join(path.dirname(paths.codex), "classroom-catalog.json"), restore: current => current },
  });
  // Read-only compatibility journal. New writes use the route-specific journals below.
  const legacyClaudeBackup = clientSettingsBackup(path.join(path.dirname(paths.claude), "classroom-claude-settings-backup.json"), {
    config: { file: paths.claude, restore: restoreJsonFields },
    vscode: { file: paths.vsCode, restore: restoreJsonFields },
    gateway: { file: gatewayCachePath(paths.claude), restore: current => current },
  });
  const claudeCodeBackup = clientSettingsBackup(path.join(path.dirname(paths.claude), "classroom-claude-code-settings-backup.json"), {
    config: { file: paths.claude, restore: restoreJsonFields },
  });
  async function migrateLegacyRouteState(proxy: string) {
    // ADR-0005 wrote one Claude/VS Code journal. Restore it before the routes split;
    // this journal is never used for a new write.
    await legacyClaudeBackup.restore();
    const saved = await readDiskBackup(paths);
    const route = await optionalText(path.join(path.dirname(paths.codex), "classroom-codex-route-backup.json"));
    if (saved && (saved.clients?.codex ?? true) || route !== null) {
      let original = await readText(paths.codex);
      const keys: string[] = [];
      if (saved && (saved.clients?.codex ?? true)) {
        if (readRootTomlString(original, "model")?.startsWith("VCRouter/")) {
          original = setTomlField(original, "model", saved.codexModel);
          keys.push("model");
        }
        if (readRootTomlString(original, "model_catalog_json") === path.join(path.dirname(paths.codex), "classroom-catalog.json")) {
          original = setTomlField(original, "model_catalog_json", saved.catalogPath);
          keys.push("model_catalog_json");
        }
        const cache = parseJsonObject(await readText(path.join(path.dirname(paths.codex), "models_cache.json")));
        if (Array.isArray(cache?.models) && cache.models.length && cache.models.every(value => String(asRecord(value)?.slug).startsWith("VCRouter/"))) await codexBackup.seed("cache", saved.modelsCache ?? null, []);
      }
      if (route !== null) {
        const value = JSON.parse(route).baseUrl;
        if (value !== null && typeof value !== "string") throw new Error("Invalid Codex route backup");
        if (isManagedUrl(readRootTomlString(original, "openai_base_url"), proxy)) {
          original = setTomlField(original, "openai_base_url", isManagedUrl(value, proxy) ? undefined : value ?? undefined);
          keys.push("openai_base_url");
        }
      }
      await codexBackup.seed("config", original, keys);
    }
    if (saved && (saved.clients?.claude ?? true)) {
      const current = await readText(paths.claude);
      const doc = parseJsonObject(current);
      if (!doc) throw new Error("Invalid Claude settings");
      const gateway = parseJsonObject(await readText(gatewayCachePath(paths.claude)));
      const keys: string[] = [];
      if (isManagedUrl(asRecord(doc.env)?.ANTHROPIC_BASE_URL, proxy)) keys.push("env.ANTHROPIC_BASE_URL");
      if (isManagedUrl(doc.ANTHROPIC_BASE_URL, proxy)) keys.push("ANTHROPIC_BASE_URL");
      if (isManagedUrl(gateway?.baseUrl, proxy)) {
        if (Array.isArray(gateway?.models) && gateway.models.some(value => asRecord(value)?.id === doc.model)) keys.push("model");
        if (typeof saved.gateway === "string") {
          await writeText(gatewayCachePath(paths.claude), saved.gateway);
        } else {
          await fs.rm(gatewayCachePath(paths.claude), { force: true });
        }
      }
      const original = restoreJsonFields(current, personalClaudeText(saved.claudeFile ?? "", proxy), current, keys);
      await claudeCodeBackup.seed("config", original, keys);
    }
    // New durable journals exist before obsolete backup files are removed.
    if (saved) await fs.rm(backupFile(paths), { force: true });
    if (route !== null) await fs.rm(path.join(path.dirname(paths.codex), "classroom-codex-route-backup.json"), { force: true });
  }
  return {
    async migrateLegacyState(proxyBaseUrl: string): Promise<void> {
      await migrateLegacyRouteState(proxyBaseUrl);
      const text = await optionalText(paths.claude);
      if (text !== null) {
        let next = personalClaudeText(text, proxyBaseUrl);
        const gateway = parseJsonObject(await readText(gatewayCachePath(paths.claude)));
        if (isManagedUrl(gateway?.baseUrl, proxyBaseUrl)) {
          const doc = parseJsonObject(next)!;
          if (Array.isArray(gateway?.models) && gateway.models.some(value => asRecord(value)?.id === doc.model)) {
            delete doc.model;
            next = JSON.stringify(doc, null, 2) + "\n";
          }
        }
        if (next !== text) await writeText(paths.claude, next);
        if (isManagedUrl(gateway?.baseUrl, proxyBaseUrl)) await fs.rm(gatewayCachePath(paths.claude), { force: true });
      }
      const vscode = await optionalText(paths.vsCode);
      if (vscode !== null) {
        const doc = parseJsonObject(vscode);
        if (!doc) throw new Error("Invalid VS Code settings");
        if (anthropicBaseValues(doc[VS_CODE_ENV]).some(value => isManagedUrl(value, proxyBaseUrl))) {
          await writeText(paths.vsCode, JSON.stringify(withoutManagedVsCodeBaseUrl(doc, proxyBaseUrl), null, 2) + "\n");
        }
      }
    },
    async setCodexRoute(options: CodexRouteOptions): Promise<void> {
      const proxyBaseUrl = options.proxyBaseUrl;
      const text = await readText(paths.codex);
      if (options.mode === "classroom") {
        const original = isManagedUrl(readRootTomlString(text, "openai_base_url"), proxyBaseUrl) ? removeRootTomlKey(text, "openai_base_url") : text;
        const catalogPath = path.join(path.dirname(paths.codex), "classroom-catalog.json");
        const cachePath = path.join(path.dirname(paths.codex), "models_cache.json");
        const liveCache = await readOptional(cachePath);
        const models = catalogModels(options.ids, pickTemplate(liveCache));
        await codexBackup.write("catalog", `${JSON.stringify({ models }, null, 2)}\n`, []);
        await codexBackup.write("cache", `${JSON.stringify({ fetched_at: "2000-01-01T00:00:00Z", client_version: "0.0.0", models }, null, 2)}\n`, []);
        let next = upsertRootTomlString(text, "openai_base_url", proxyBaseUrl.replace(/\/$/, "") + "/v1");
        next = upsertRootTomlString(next, "model_catalog_json", catalogPath);
        next = upsertRootTomlString(next, "model", catalogSlug(options.selectedModel));
        await codexBackup.write("config", next, ["openai_base_url", "model", "model_catalog_json"], original === text ? undefined : original);
        if (options.restart) await restartCodexAppServers();
      } else {
        await codexBackup.restore();
        const current = await readText(paths.codex);
        let next = current;
        if (isManagedUrl(readRootTomlString(next, "openai_base_url"), proxyBaseUrl)) next = removeRootTomlKey(next, "openai_base_url");
        if (readRootTomlString(next, "model")?.startsWith("VCRouter/")) next = removeRootTomlKey(next, "model");
        if (readRootTomlString(next, "model_catalog_json") === path.join(path.dirname(paths.codex), "classroom-catalog.json")) next = removeRootTomlKey(next, "model_catalog_json");
        if (next !== current) await writeText(paths.codex, next);
        const cachePath = path.join(path.dirname(paths.codex), "models_cache.json");
        const cache = parseJsonObject(await readText(cachePath));
        if (cache?.fetched_at === "2000-01-01T00:00:00Z" && Array.isArray(cache.models) && cache.models.every(value => String(asRecord(value)?.slug).startsWith("VCRouter/"))) await fs.rm(cachePath, { force: true });
      }
    },
    async setClaudeCodeRoute(classroom: boolean, proxyBaseUrl: string): Promise<void> {
      if (!classroom) {
        await claudeCodeBackup.restore();
        const text = await optionalText(paths.claude);
        if (text !== null) {
          const next = personalClaudeText(text, proxyBaseUrl);
          if (next !== text) await writeText(paths.claude, next);
        }
        return;
      }
      const text = await readText(paths.claude);
      const doc = parseJsonObject(text);
      if (!doc) throw new Error("Invalid Claude settings");
      const env = { ...(asRecord(doc.env) ?? {}), ANTHROPIC_BASE_URL: proxyBaseUrl };
      const next = replaceJsonProperty(text, "env", env);
      const personal = personalClaudeText(text, proxyBaseUrl);
      await claudeCodeBackup.write("config", next, ["env.ANTHROPIC_BASE_URL"], personal === text ? undefined : personal);
    },
  };
}

type ModelBackup = {
  clients?: { codex: boolean; claude: boolean };
  codexModel?: string;
  catalogPath?: string;
  modelsCache?: string;
  claudeFile?: string;
  gateway?: string;
};

function isManagedUrl(value: unknown, proxy: string): boolean {
  if (typeof value !== "string") return false;
  try {
    const origin = new URL(value).origin;
    return origin === new URL(proxy).origin || origin === "http://127.0.0.1:47821";
  } catch { return false; }
}

function setTomlField(text: string, key: string, value: string | undefined): string {
  return value === undefined ? removeRootTomlKey(text, key) : upsertRootTomlString(text, key, value);
}

function restoreTomlFields(current: string, original: string, written: string, keys: string[]): string {
  return keys.reduce((text, key) => readRootTomlString(text, key) === readRootTomlString(written, key)
    ? setTomlField(text, key, readRootTomlString(original, key)) : text, current);
}

function personalClaudeText(text: string, proxy: string): string {
  const doc = parseJsonObject(text);
  if (!doc) throw new Error("Invalid Claude settings");
  const env = asRecord(doc.env);
  if (!isManagedUrl(env?.ANTHROPIC_BASE_URL, proxy) && !isManagedUrl(doc.ANTHROPIC_BASE_URL, proxy)) return text;
  if (env && isManagedUrl(env.ANTHROPIC_BASE_URL, proxy)) {
    delete env.ANTHROPIC_BASE_URL;
    if (!Object.keys(env).length) delete doc.env;
  }
  if (isManagedUrl(doc.ANTHROPIC_BASE_URL, proxy)) delete doc.ANTHROPIC_BASE_URL;
  return JSON.stringify(doc, null, 2) + "\n";
}

function restoreJsonFields(current: string, original: string, written: string, keys: string[]): string {
  const doc = parseJsonObject(current), before = parseJsonObject(original), managed = parseJsonObject(written);
  if (!doc || !before || !managed) throw new Error("Invalid client settings during restore");
  let changed = false;
  for (const key of keys) {
    if (key === "vscodeBase") {
      if (!isDeepStrictEqual(anthropicBaseValues(doc[VS_CODE_ENV]), anthropicBaseValues(managed[VS_CODE_ENV]))) continue;
      const env = doc[VS_CODE_ENV], previous = before[VS_CODE_ENV];
      if (Array.isArray(env)) {
        const bases = Array.isArray(previous) ? previous.filter(isAnthropicBaseEntry)
          : asRecord(previous)?.ANTHROPIC_BASE_URL === undefined ? [] : [{ name: "ANTHROPIC_BASE_URL", value: asRecord(previous)?.ANTHROPIC_BASE_URL }];
        doc[VS_CODE_ENV] = [...env.filter(entry => !isAnthropicBaseEntry(entry)), ...bases];
      } else if (asRecord(env)) {
        const value = Array.isArray(previous) ? (previous.find(isAnthropicBaseEntry) as { value?: unknown } | undefined)?.value : asRecord(previous)?.ANTHROPIC_BASE_URL;
        const next = { ...asRecord(env) };
        if (value === undefined) delete next.ANTHROPIC_BASE_URL;
        else next.ANTHROPIC_BASE_URL = value;
        doc[VS_CODE_ENV] = next;
      }
      changed = true;
    } else if (key === "env.ANTHROPIC_BASE_URL") {
      const env = asRecord(doc.env), old = asRecord(before.env), expected = asRecord(managed.env);
      if (!env || !isDeepStrictEqual(env.ANTHROPIC_BASE_URL, expected?.ANTHROPIC_BASE_URL)) continue;
      if (old?.ANTHROPIC_BASE_URL === undefined) delete env.ANTHROPIC_BASE_URL;
      else env.ANTHROPIC_BASE_URL = old.ANTHROPIC_BASE_URL;
      if (!Object.keys(env).length) delete doc.env;
      changed = true;
    } else if (isDeepStrictEqual(doc[key], managed[key])) {
      if (before[key] === undefined) delete doc[key]; else doc[key] = before[key];
      changed = true;
    }
  }
  return changed ? JSON.stringify(doc, null, 2) + "\n" : current;
}

function gatewayCachePath(claudeSettings: string): string {
  return path.join(path.dirname(claudeSettings), "cache", "gateway-models.json");
}

const ROUTED_PREFIX = "VCRouter/";

function catalogSlug(id: string): string {
  return id.startsWith(ROUTED_PREFIX) ? id : `${ROUTED_PREFIX}${id}`;
}

function pickTemplate(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const models = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { models?: unknown }).models)
      ? (parsed as { models: unknown[] }).models
      : [];
  const listed = models.find((model) => {
    if (!model || typeof model !== "object" || Array.isArray(model)) {
      return false;
    }
    return (model as Record<string, unknown>).visibility === "list";
  });
  if (!listed || typeof listed !== "object" || Array.isArray(listed)) {
    return undefined;
  }
  return structuredClone(listed as Record<string, unknown>);
}

function catalogModels(
  ids: string[],
  template: Record<string, unknown> | undefined,
): Record<string, unknown>[] {
  return ids.map((id, index) => {
    const slug = catalogSlug(id);
    const entry = template ? structuredClone(template) : {
      shell_type: "shell_command",
      visibility: "list",
      supported_in_api: true,
      default_reasoning_level: "medium",
      supported_reasoning_levels: [
        { effort: "low", description: "Fast responses with lighter reasoning" },
        { effort: "medium", description: "Balances speed and reasoning depth for everyday tasks" },
        { effort: "high", description: "Greater reasoning depth for complex problems" },
        { effort: "xhigh", description: "Extra high reasoning depth for complex problems" },
        { effort: "max", description: "Maximum reasoning depth for the hardest problems" },
        { effort: "ultra", description: "Maximum reasoning with automatic task delegation" },
      ],
      base_instructions: "You are a helpful coding assistant.",
      supports_parallel_tool_calls: true,
      context_window: 128000,
      max_context_window: 128000,
      input_modalities: ["text", "image"],
    };
    entry.slug = slug;
    entry.display_name = slug;
    entry.description = `Routed via classroom → VCRouter (${id}).`;
    entry.visibility = "list";
    entry.supported_in_api = true;
    entry.priority = index + 1;
    entry.upgrade = null;
    return entry;
  });
}

function rootTomlLines(text: string): { lines: string[]; rootEnd: number } {
  const lines = text.split("\n");
  const table = lines.findIndex((line) => /^\s*\[/.test(line));
  return { lines, rootEnd: table === -1 ? lines.length : table };
}

function readRootTomlString(text: string, key: string): string | undefined {
  const { lines, rootEnd } = rootTomlLines(text);
  const pattern = new RegExp(`^\\s*${key}\\s*=\\s*"((?:\\\\.|[^"\\\\])*)"`);
  for (let i = 0; i < rootEnd; i += 1) {
    const match = lines[i]?.match(pattern);
    if (match?.[1] !== undefined) {
      return match[1].replaceAll("\\\\", "\\").replaceAll('\\"', '"');
    }
  }
  return undefined;
}

function upsertRootTomlString(text: string, key: string, value: string): string {
  const { lines, rootEnd } = rootTomlLines(stripKeyOutsideRoot(text, key));
  const escaped = value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  const line = `${key} = "${escaped}"`;
  const pattern = new RegExp(`^\\s*${key}\\s*=`);
  for (let i = 0; i < rootEnd; i += 1) {
    if (pattern.test(lines[i] ?? "")) {
      lines[i] = line;
      return lines.join("\n");
    }
  }
  let insertAt = rootEnd;
  while (insertAt > 0 && (lines[insertAt - 1] ?? "").trim() === "") {
    insertAt -= 1;
  }
  lines.splice(insertAt, 0, line);
  return lines.join("\n");
}

function removeRootTomlKey(text: string, key: string): string {
  const { lines, rootEnd } = rootTomlLines(text);
  const pattern = new RegExp(`^\\s*${key}\\s*=`);
  return lines.filter((line, index) => index >= rootEnd || !pattern.test(line)).join("\n");
}

function stripKeyOutsideRoot(text: string, key: string): string {
  const { lines, rootEnd } = rootTomlLines(text);
  const pattern = new RegExp(`^\\s*${key}\\s*=`);
  return lines.filter((line, index) => index < rootEnd || !pattern.test(line)).join("\n");
}

function restartCodexAppServers(): Promise<void> {
  if (process.platform !== "win32") {
    return Promise.resolve();
  }
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    "Get-CimInstance Win32_Process | Where-Object {",
    "  $_.CommandLine -and $_.CommandLine -match '(?i)(^|\\\\|\\s)codex(\\.exe|\\.cmd)?(\\s|\").*\\bapp-server\\b'",
    "} | ForEach-Object { $_.ProcessId }",
  ].join("\n");
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NoLogo", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script],
      { timeout: 12_000, windowsHide: true },
      (_error, stdout) => {
        const pids = String(stdout)
          .split(/\r?\n/)
          .map((line) => Number(line.trim()))
          .filter((pid) => Number.isSafeInteger(pid) && pid > 1);
        if (pids.length === 0) {
          resolve();
          return;
        }
        let left = pids.length;
        for (const pid of pids) {
          execFile("taskkill", ["/PID", String(pid), "/T"], { windowsHide: true }, () => {
            left -= 1;
            if (left === 0) {
              resolve();
            }
          });
        }
      },
    );
  });
}

async function readOptional(file: string): Promise<string | undefined> {
  return (await optionalText(file)) ?? undefined;
}

function backupFile(paths: RouteFilePaths): string {
  return path.join(path.dirname(paths.codex), "classroom-model-backup.json");
}

async function readDiskBackup(
  paths: RouteFilePaths,
): Promise<ModelBackup | undefined> {
  const raw = await readOptional(backupFile(paths));
  if (!raw) {
    return undefined;
  }
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  return parsed as ModelBackup;
}

async function readText(file: string): Promise<string> {
  return (await optionalText(file)) ?? "";
}

async function writeText(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text, "utf8");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  if (text.trim() === "") {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(relaxJson(text));
    return asRecord(parsed);
  } catch {
    return undefined;
  }
}

// ponytail: trailing-comma removal can match inside strings. Upgrade path: a JSONC parser.
function relaxJson(text: string): string {
  return stripJsonComments(text).replace(/,\s*([}\]])/g, "$1");
}

function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    const next = text[i + 1];
    if (inString) {
      out += c;
      if (escape) {
        escape = false;
      } else if (c === "\\") {
        escape = true;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === "/" && next === "/") {
      i += 1;
      while (i + 1 < text.length && text[i + 1] !== "\n") {
        i += 1;
      }
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
        i += 1;
      }
      i += 1;
      continue;
    }
    out += c;
  }
  return out;
}

// ponytail: replaces the first property with this name. Upgrade path: a JSONC editor.
function replaceJsonProperty(text: string, key: string, value: unknown): string {
  const serialized = JSON.stringify(value);
  const needle = `"${key}"`;
  const at = text.indexOf(needle);
  if (at < 0) {
    return insertJsonProperty(text, key, serialized);
  }
  let i = at + needle.length;
  while (i < text.length && /\s/.test(text[i])) {
    i += 1;
  }
  if (text[i] !== ":") {
    return text;
  }
  i += 1;
  while (i < text.length && /\s/.test(text[i])) {
    i += 1;
  }
  const end = jsonValueEnd(text, i);
  if (end < 0) {
    return text;
  }
  return `${text.slice(0, i)}${serialized}${text.slice(end)}`;
}

function insertJsonProperty(text: string, key: string, serialized: string): string {
  if (text.trim() === "") {
    return `{\n  "${key}": ${serialized}\n}\n`;
  }
  const end = text.lastIndexOf("}");
  if (end < 0) {
    return text;
  }
  const before = text.slice(0, end).trimEnd();
  const comma = before.endsWith("{") || before.endsWith(",") ? "" : ",";
  return `${before}${comma}\n  "${key}": ${serialized}\n${text.slice(end)}`;
}

function jsonValueEnd(text: string, start: number): number {
  const c = text[start];
  if (c === '"') {
    let escape = false;
    for (let i = start + 1; i < text.length; i += 1) {
      if (escape) {
        escape = false;
        continue;
      }
      if (text[i] === "\\") {
        escape = true;
        continue;
      }
      if (text[i] === '"') {
        return i + 1;
      }
    }
    return -1;
  }
  if (c === "{" || c === "[") {
    const close = c === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];
      if (inString) {
        if (escape) {
          escape = false;
        } else if (ch === "\\") {
          escape = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === c) {
        depth += 1;
      } else if (ch === close) {
        depth -= 1;
        if (depth === 0) {
          return i + 1;
        }
      }
    }
    return -1;
  }
  let i = start;
  while (i < text.length && !/[\s,}\]]/.test(text[i])) {
    i += 1;
  }
  return i;
}

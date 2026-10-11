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

export function withVsCodeBaseUrl(
  doc: Record<string, unknown>,
  url: string,
): Record<string, unknown> {
  const env = doc[VS_CODE_ENV];
  if (Array.isArray(env)) {
    return {
      ...doc,
      [VS_CODE_ENV]: [
        ...env.filter((entry) => !isAnthropicBaseEntry(entry)),
        { name: "ANTHROPIC_BASE_URL", value: url },
      ],
    };
  }
  if (env && typeof env === "object") {
    return {
      ...doc,
      [VS_CODE_ENV]: {
        ...(env as Record<string, unknown>),
        ANTHROPIC_BASE_URL: url,
      },
    };
  }
  return {
    ...doc,
    [VS_CODE_ENV]: [{ name: "ANTHROPIC_BASE_URL", value: url }],
  };
}

export function withoutVsCodeBaseUrl(
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

export type ModelOptions = {
  ids: string[];
  codexModel: string;
  claudeModel: string;
  proxyBaseUrl: string;
  restartCodex?: boolean;
  clients?: { codex: boolean; claude: boolean };
  updateClient?: "codex" | "claude";
};

export function createRouteFiles(paths: RouteFilePaths) {
  let backup: ModelBackup | undefined;
  return {
    async setCodexRoute(classroom: boolean, proxyBaseUrl: string): Promise<void> {
      const routeBackup = path.join(path.dirname(paths.codex), "classroom-codex-route-backup.json");
      const text = await readText(paths.codex);
      const current = readRootTomlString(text, "openai_base_url");
      const managed = (value: string | undefined) => {
        if (!value) return false;
        try {
          return new URL(value).origin === new URL(proxyBaseUrl).origin;
        } catch {
          return false;
        }
      };
      const raw = await readOptional(routeBackup);
      let saved: { baseUrl: string | null } | undefined;
      if (raw !== undefined) {
        const parsed = JSON.parse(raw) as { baseUrl?: unknown };
        if (!parsed || (parsed.baseUrl !== null && typeof parsed.baseUrl !== "string")) {
          throw new Error("Invalid Codex route backup");
        }
        saved = { baseUrl: parsed.baseUrl };
      }
      let next: string;
      if (classroom) {
        if (!saved) {
          saved = { baseUrl: managed(current) ? null : current ?? null };
          await writeText(routeBackup, `${JSON.stringify(saved)}\n`);
        }
        const url = proxyBaseUrl.endsWith("/v1") ? proxyBaseUrl : `${proxyBaseUrl}/v1`;
        next = upsertRootTomlString(text, "openai_base_url", url);
      } else {
        if (!saved && !managed(current)) return;
        next = saved?.baseUrl && !managed(saved.baseUrl)
          ? upsertRootTomlString(text, "openai_base_url", saved.baseUrl)
          : removeRootTomlKey(text, "openai_base_url");
      }
      if (next !== text) await writeText(paths.codex, next);
      if (!classroom) await fs.rm(routeBackup, { force: true });
    },
    async readCodex(): Promise<Record<string, unknown>> {
      const url = readRootTomlString(await readText(paths.codex), "openai_base_url");
      return url === undefined ? {} : { openai_base_url: url };
    },
    async writeCodex(doc: Record<string, unknown>): Promise<void> {
      const text = await readText(paths.codex);
      const next =
        typeof doc.openai_base_url === "string"
          ? upsertRootTomlString(text, "openai_base_url", doc.openai_base_url)
          : removeRootTomlKey(text, "openai_base_url");
      await writeText(paths.codex, next);
    },
    async readClaudeTerminal(): Promise<Record<string, unknown>> {
      const current = parseJsonObject(await readText(paths.claude)) ?? {};
      const env = asRecord(current.env);
      const fromEnv = env?.ANTHROPIC_BASE_URL;
      if (typeof fromEnv === "string") {
        return { ...current, ANTHROPIC_BASE_URL: fromEnv };
      }
      return current;
    },
    async writeClaudeTerminal(doc: Record<string, unknown>): Promise<void> {
      const current = parseJsonObject(await readText(paths.claude));
      if (!current) {
        return;
      }
      const env = { ...(asRecord(current.env) ?? {}) };
      if (typeof doc.ANTHROPIC_BASE_URL === "string") {
        env.ANTHROPIC_BASE_URL = doc.ANTHROPIC_BASE_URL;
      } else {
        delete env.ANTHROPIC_BASE_URL;
      }
      if (Object.keys(env).length === 0) {
        delete current.env;
      } else {
        current.env = env;
      }
      delete current.ANTHROPIC_BASE_URL;
      await writeText(paths.claude, `${JSON.stringify(current, null, 2)}\n`);
    },
    async readVsCodeClaude(): Promise<Record<string, unknown>> {
      return parseJsonObject(await readText(paths.vsCode)) ?? {};
    },
    async writeVsCodeClaude(doc: Record<string, unknown>): Promise<void> {
      if (!Object.hasOwn(doc, "claudeCode.environmentVariables")) {
        return;
      }
      const text = await readText(paths.vsCode);
      const next = replaceJsonProperty(
        text,
        "claudeCode.environmentVariables",
        doc["claudeCode.environmentVariables"],
      );
      await writeText(paths.vsCode, next);
    },
    async setModelOptions(options: ModelOptions | null): Promise<void> {
      if (!options) {
        await restoreModelOptions(paths, backup);
        backup = undefined;
        return;
      }
      const clients = options.clients ?? { codex: true, claude: true };
      backup ??= await readDiskBackup(paths);
      const active = backup ? backup.clients ?? { codex: true, claude: true } : { codex: false, claude: false };
      const current = await captureModelBackup(paths);
      backup ??= { clients: { codex: false, claude: false } };
      if (clients.codex && !active.codex) {
        backup.codexModel = current.codexModel;
        backup.catalogPath = current.catalogPath;
        backup.modelsCache = current.modelsCache;
      }
      if (clients.claude && !active.claude) {
        backup.claudeFile = current.claudeFile;
        backup.gateway = current.gateway;
      }
      // Record newly managed files before touching them, so a partial write can be restored.
      backup.clients = { codex: active.codex || clients.codex, claude: active.claude || clients.claude };
      await writeText(backupFile(paths), `${JSON.stringify(backup)}\n`);
      await restoreModelOptions(paths, backup, { codex: active.codex && !clients.codex, claude: active.claude && !clients.claude });
      backup.clients = clients;
      await writeText(backupFile(paths), `${JSON.stringify(backup)}\n`);
      if (clients.codex && options.updateClient !== "claude") {
        const catalogPath = path.join(path.dirname(paths.codex), "classroom-catalog.json");
        const cachePath = path.join(path.dirname(paths.codex), "models_cache.json");
        const liveCache = await readOptional(cachePath);
        const template = pickTemplate(liveCache) ?? pickTemplate(backup.modelsCache);
        const models = catalogModels(options.ids, template);
        const selected = catalogSlug(options.codexModel);
        await writeText(catalogPath, `${JSON.stringify({ models }, null, 2)}\n`);
        await writeText(
          cachePath,
          `${JSON.stringify(
            {
              fetched_at: "2000-01-01T00:00:00Z",
              client_version: "0.0.0",
              models,
            },
            null,
            2,
          )}\n`,
        );
        let toml = await readText(paths.codex);
        toml = upsertRootTomlString(toml, "model_catalog_json", catalogPath);
        toml = upsertRootTomlString(toml, "model", selected);
        await writeText(paths.codex, toml);
      }
      if (clients.claude && options.updateClient !== "codex") {
        await writeClaudeModel(paths.claude, options.claudeModel);
        await writeText(
          gatewayCachePath(paths.claude),
          `${JSON.stringify({
            baseUrl: options.proxyBaseUrl,
            fetchedAt: 0,
            models: options.ids.map((id) => ({ id, display_name: id })),
          })}\n`,
        );
      }
      if (options.restartCodex && clients.codex && options.updateClient !== "claude") {
        await restartCodexAppServers();
      }
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
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return undefined;
  }
}

async function captureModelBackup(paths: RouteFilePaths): Promise<ModelBackup> {
  const toml = await readText(paths.codex);
  return {
    codexModel: readRootTomlString(toml, "model"),
    catalogPath: readRootTomlString(toml, "model_catalog_json"),
    modelsCache: await readOptional(
      path.join(path.dirname(paths.codex), "models_cache.json"),
    ),
    claudeFile: await readOptional(paths.claude),
    gateway: await readOptional(gatewayCachePath(paths.claude)),
  };
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

async function writeClaudeModel(file: string, model: string): Promise<void> {
  const text = await readText(file);
  const next =
    text.trim() === ""
      ? `${JSON.stringify({ model }, null, 2)}\n`
      : replaceJsonProperty(text, "model", model);
  await writeText(file, next.endsWith("\n") ? next : `${next}\n`);
}

async function restoreBackedFile(
  file: string,
  contents: string | undefined,
): Promise<void> {
  if (contents === undefined) {
    await fs.rm(file, { force: true });
    return;
  }
  await writeText(file, contents);
}

async function restoreModelOptions(
  paths: RouteFilePaths,
  backup: ModelBackup | undefined,
  clients?: { codex: boolean; claude: boolean },
): Promise<void> {
  const saved = backup ?? (await readDiskBackup(paths));
  if (!saved) {
    return;
  }
  const restore = clients ?? saved.clients ?? { codex: true, claude: true };
  if (restore.codex) {
    let toml = await readText(paths.codex);
    toml = saved.catalogPath
      ? upsertRootTomlString(toml, "model_catalog_json", saved.catalogPath)
      : removeRootTomlKey(toml, "model_catalog_json");
    toml = saved.codexModel
      ? upsertRootTomlString(toml, "model", saved.codexModel)
      : removeRootTomlKey(toml, "model");
    await writeText(paths.codex, toml);
    await restoreBackedFile(
      path.join(path.dirname(paths.codex), "models_cache.json"),
      saved.modelsCache,
    );
  }
  if (restore.claude) {
    await restoreBackedFile(paths.claude, saved.claudeFile);
    await restoreBackedFile(gatewayCachePath(paths.claude), saved.gateway);
  }
  if (!clients) await fs.rm(backupFile(paths), { force: true });
}

async function readText(file: string): Promise<string> {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return "";
  }
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

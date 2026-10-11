import { createPlatformConnectionStorage } from "./platformStorage";
import { readRuntimeOptions } from "./runtimeOptions";
import { AsyncLocalStorage } from "node:async_hooks";
import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import {
  ClassroomApp,
  ENVIRONMENT_TOOLS,
  type EnvironmentToolId,
  type NicknameRedeemResult,
  type ProxyClient,
  type UpstreamSend,
  type UpstreamTarget,
} from "./classroomApp";
import { renderPage } from "./page";
import { pickProjectFolder } from "./folderPicker";
import { collectOutput, shellLaunch, runCommand } from "./commandRunner";
import { isPrototypeVariant, renderPrototypePage } from "./pagePrototype";
import { createRouteFiles } from "./routeFiles";
import { decodeRequestBody } from "./responsesChat";
import { createAdapterSettingsStorage } from "./adapterSettings";
import { sendRouter, relayResponse } from "./modelProxy";

const runtimeOptions = readRuntimeOptions(process.env);
const port = runtimeOptions.port;
const pageUrl = `http://127.0.0.1:${port}/`;
const nodeRequire = createRequire(__filename);
const responseSlot = new AsyncLocalStorage<{
  response?: Response;
}>();
const activeRequests = new Set<AbortController>();
function abortRequests(): void { for (const controller of activeRequests) controller.abort(); }

function routerBaseUrl(): string {
  return (
    process.env.CLASSROOM_ROUTER_BASE_URL ?? "https://ai.vanscoding.com"
  ).replace(/\/+$/, "");
}

function routePaths() {
  const appData =
    process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  return {
    codex: path.join(os.homedir(), ".codex", "config.toml"),
    claude: path.join(os.homedir(), ".claude", "settings.json"),
    vsCode: path.join(appData, "Code", "User", "settings.json"),
  };
}

function storageFile(): string {
  return path.join(os.homedir(), ".vanspod", "connection.json");
}

function legacyStorageFile(): string {
  const root = process.env.LOCALAPPDATA || os.homedir();
  return path.join(root, "classroom-app", "connection.json");
}

function copilotModelsFile(): string {
  const roaming = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  return path.join(roaming, "Code", "User", "chatLanguageModels.json");
}

function isProviderRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

async function readCopilotProviders(): Promise<{
  providers: Array<Record<string, unknown>>;
}> {
  let raw: string;
  try {
    raw = await fs.readFile(copilotModelsFile(), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { providers: [] };
    }
    throw err;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return { providers: [] };
  }
  const parsed: unknown = JSON.parse(trimmed);
  if (Array.isArray(parsed)) {
    return { providers: parsed.filter(isProviderRecord) };
  }
  if (isProviderRecord(parsed) && Array.isArray(parsed.providers)) {
    return { providers: parsed.providers.filter(isProviderRecord) };
  }
  throw new Error("Copilot 設定格式無法辨識");
}

async function writeCopilotProviders(doc: {
  providers: Array<Record<string, unknown>>;
}): Promise<void> {
  const target = copilotModelsFile();
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(
    target,
    `${JSON.stringify(doc.providers, null, 2)}\n`,
    "utf8",
  );
}

function modelIdsInRouterOrder(payload: unknown): string[] {
  if (!Array.isArray(payload)) {
    // A successfully received response without a list is authoritative unavailability,
    // unlike a transport failure where an existing valid runtime list may be retained.
    return [];
  }
  const ids: string[] = [];
  for (const provider of payload) {
    if (!provider || typeof provider !== "object") {
      continue;
    }
    const models = (provider as { models?: unknown }).models;
    if (!Array.isArray(models)) {
      continue;
    }
    for (const model of models) {
      if (!model || typeof model !== "object") {
        continue;
      }
      const id = (model as { id?: unknown }).id;
      if (typeof id === "string" && id) {
        ids.push(id);
      }
    }
  }
  return ids;
}

async function fetchSessionModels(apiKey: string): Promise<string[]> {
  const root = routerBaseUrl();
  const response = await fetch(`${root}/extension/chat-language-models`, {
    signal: AbortSignal.timeout(5_000),
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
  });
  if (!response.ok) {
    throw new Error("session models failed");
  }
  return modelIdsInRouterOrder(await response.json());
}

function isRedeemResult(value: unknown): value is NicknameRedeemResult {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as { api_key?: unknown; session?: unknown };
  return (
    typeof record.api_key === "string" &&
    record.api_key.length > 0 &&
    !!record.session &&
    typeof record.session === "object" &&
    !Array.isArray(record.session) &&
    ["class_name", "name", "invite_code", "expires_at"].every(field => {
      const item = (record.session as Record<string, unknown>)[field];
      return item === undefined || typeof item === "string";
    })
  );
}

async function fetchCourseCatalog(
  apiKey: string,
): Promise<{ course_catalog_yaml?: unknown }> {
  const root = routerBaseUrl();
  const response = await fetch(`${root}/extension/course-catalog`, {
    signal: AbortSignal.timeout(5_000),
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
  });
  if (!response.ok) {
    throw new Error("course catalog failed");
  }
  const json: unknown = await response.json();
  if (!json || typeof json !== "object") {
    throw new Error("course catalog failed");
  }
  return json as { course_catalog_yaml?: unknown };
}

async function readClassroomInstalls(
  folder: string,
): Promise<string | undefined> {
  try {
    return await fs.readFile(
      path.join(folder, "classroom-installs.yaml"),
      "utf8",
    );
  } catch {
    return undefined;
  }
}

async function redeemNickname(body: {
  invite_code: string;
  nickname: string;
}): Promise<NicknameRedeemResult> {
  const root = routerBaseUrl();
  const response = await fetch(
    `${root}/extension/sessions/nickname-redeem`,
    {
      signal: AbortSignal.timeout(5_000),
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        invite_code: body.invite_code,
        nickname: body.nickname,
      }),
    },
  );
  if (!response.ok) {
    throw new Error("nickname redeem failed");
  }
  const json: unknown = await response.json();
  if (!isRedeemResult(json)) {
    throw new Error("nickname redeem failed");
  }
  return json;
}

function isEnvironmentTool(value: string): value is EnvironmentToolId {
  return (ENVIRONMENT_TOOLS as readonly string[]).includes(value);
}

const MAC_PWSH_PAGE =
  "https://learn.microsoft.com/powershell/scripting/install/installing-powershell-on-macos";

function probeEnvironment(
  tool: EnvironmentToolId,
): Promise<{ installed: boolean }> {
  return collectOutput(tool, ["--version"]).then((result) => {
    if (result.spawnError) {
      return { installed: false };
    }
    return { installed: result.exitCode === 0 || /\d/.test(result.output) };
  });
}

function installEnvironment(
  tool: EnvironmentToolId,
  cwd: string,
): Promise<{ exitCode: number | undefined; output: string }> {
  const launch =
    process.platform === "darwin" && tool === "pwsh"
      ? { command: "open", args: [MAC_PWSH_PAGE] }
      : shellLaunch(environmentInstallCommand(tool));
  return collectOutput(launch.command, launch.args, cwd).then((result) => {
    if (result.spawnError) {
      return { exitCode: 1, output: "安裝命令無法啟動。" };
    }
    return { exitCode: result.exitCode, output: result.output };
  });
}

function environmentInstallCommand(tool: EnvironmentToolId): string {
  if (process.platform === "darwin") {
    if (tool === "uv") {
      return "curl -LsSf https://astral.sh/uv/install.sh | sh";
    }
    if (tool === "git") {
      return "xcode-select --install";
    }
    if (tool === "node") {
      return 'curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/master/install.sh | bash && . "$HOME/.nvm/nvm.sh" && nvm install --lts && nvm alias default \'lts/*\'';
    }
    return "";
  }
  const quiet =
    "--source winget --disable-interactivity -h --accept-package-agreements --accept-source-agreements";
  if (tool === "uv") {
    return 'powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"';
  }
  if (tool === "git") {
    return `winget install --id Git.Git -e ${quiet}`;
  }
  if (tool === "node") {
    return `winget install --id OpenJS.NodeJS.LTS -e ${quiet}`;
  }
  return `winget install --id Microsoft.PowerShell -e ${quiet}`;
}

function writeClipboard(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "Set-Clipboard -Value ([Console]::In.ReadToEnd())",
      ],
      { stdio: ["pipe", "ignore", "pipe"], windowsHide: true },
    );
    let failed = false;
    child.on("error", () => {
      failed = true;
      reject(new Error("clipboard failed"));
    });
    child.stderr.on("data", () => {
      failed = true;
    });
    child.on("close", (code) => {
      if (!failed && code === 0) {
        resolve();
        return;
      }
      reject(new Error("clipboard failed"));
    });
    child.stdin.write(text);
    child.stdin.end();
  });
}

function readBody(req: http.IncomingMessage, max = 16_384): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const bytes = Buffer.concat(chunks);
        const encoding = req.headers["content-encoding"];
        const decoded = decodeRequestBody(
          bytes,
          Array.isArray(encoding) ? encoding.join(",") : encoding,
        );
        if (Buffer.byteLength(decoded, "utf8") > max) throw new Error("decoded body too large");
        resolve(decoded);
      } catch (error) { reject(error); }
    });
    req.on("error", reject);
  });
}

function redirect(res: http.ServerResponse, location = "/"): void {
  res.writeHead(303, { Location: location });
  res.end();
}

function openBrowser(url: string): void {
  if (process.platform === "darwin") {
    spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  if (process.platform === "win32") {
    spawn("cmd.exe", ["/d", "/c", "start", "", url], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    }).unref();
  }
}

type SeaApi = {
  isSea: () => boolean;
  getAsset: (key: string, encoding: string) => string;
};

function trayScriptPath(): string {
  try {
    const sea = nodeRequire("node:sea") as SeaApi;
    if (sea.isSea()) {
      const target = path.join(os.tmpdir(), "vanspod-tray.ps1");
      writeFileSync(target, sea.getAsset("tray.ps1", "utf8"));
      return target;
    }
  } catch {
    // 開發時 node:sea 不在，改讀旁邊的腳本。
  }
  return path.join(__dirname, "..", "scripts", "tray.ps1");
}

function openTray(url: string): ChildProcess {
  return spawn(
    "powershell.exe",
    [
      "-STA",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      trayScriptPath(),
      url,
    ],
    { stdio: "ignore", windowsHide: true },
  );
}

let proxyAccepting = false;

function createProxy() {
  return {
    start() {
      proxyAccepting = true;
    },
    stop() {
      proxyAccepting = false;
      abortRequests();
    },
    async receive(request: { provider: "VCRouter" }) {
      if (!proxyAccepting) {
        throw new Error("代理已停止。");
      }
      if (request.provider !== "VCRouter") {
        throw new Error("只有 VCRouter 會進入代理。");
      }
    },
  };
}

function clientOf(req: http.IncomingMessage, pathname: string): ProxyClient {
  if (pathname.endsWith("/messages") || req.headers["anthropic-version"]) {
    return "claude";
  }
  const agent = String(req.headers["user-agent"] ?? "");
  if (/copilot/i.test(agent)) {
    return "copilot";
  }
  return "codex";
}

function modelFromBody(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const model = (parsed as { model?: unknown }).model;
      if (typeof model === "string") {
        return model;
      }
    }
  } catch {
    return "";
  }
  return "";
}

function rewriteModel(body: string, model: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return JSON.stringify({ ...(parsed as Record<string, unknown>), model });
    }
  } catch {
    return body;
  }
  return body;
}

function upstreamOrigin(target: UpstreamTarget): string {
  if (target === "router") {
    return routerBaseUrl();
  }
  if (target === "chatgpt") {
    return "https://chatgpt.com";
  }
  return "https://claude.ai";
}

async function sendUpstream(upstream: UpstreamSend): Promise<void> {
  if (!proxyAccepting || !upstream.path) {
    return;
  }
  const slot = responseSlot.getStore();
  if (!slot) return;
  if (upstream.target === "router" && upstream.client !== "copilot") {
    slot.response = await sendRouter(upstream, routerBaseUrl());
    return;
  }
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (upstream.target === "router" && upstream.apiKey) {
      headers.Authorization = `Bearer ${upstream.apiKey}`;
    }
    const body = upstream.target === "router"
          ? rewriteModel(upstream.body ?? "", upstream.model)
          : upstream.body;
    const url = `${upstreamOrigin(upstream.target)}${upstream.path}`;
    const response = await fetch(url, {
      method: upstream.method ?? "POST",
      headers,
      body,
      signal: upstream.signal,
    });
    slot.response = response;
  } catch {
    slot.response = Response.json({ error: { message: "上游沒有回應。" } }, { status: 502 });
  }
}

async function main(): Promise<void> {
  const routeFiles = createRouteFiles(routePaths());
  const app = new ClassroomApp({
    adapterSettings: createAdapterSettingsStorage(path.join(os.homedir(), ".vanspod", "settings.json")),
    router: { redeemNickname, fetchSessionModels },
    catalog: { fetchCourseCatalog },
    projectFiles: { readClassroomInstalls },
    clipboard: { write: writeClipboard },
    commands: { run: runCommand },
    environment: {
      probe: probeEnvironment,
      install: installEnvironment,
    },
    files: {
      async write() {
        throw new Error("VansPod 不寫 MCP 設定");
      },
    },
    storage: createPlatformConnectionStorage(storageFile(), { legacyFilePath: legacyStorageFile() }),
    stopProcess() {
      // 關視窗不呼叫這裡。停止是頁面上的單獨動作。
    },
    proxyBaseUrl: pageUrl.replace(/\/$/, ""),
    routes: {
      ...routeFiles,
      setModelOptions: options => routeFiles.setModelOptions(options && {
        ...options, restartCodex: runtimeOptions.restartClients && options.restartCodex,
      }),
    },
    copilot: {
      read: readCopilotProviders,
      write: writeCopilotProviders,
    },
    proxy: createProxy(),
    send: sendUpstream,
  });
  await app.start();

  const server = http.createServer(async (req, res) => {
    const parsed = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    const pathname = parsed.pathname;
    const goHome = (params?: URLSearchParams) => {
      if (req.headers["x-classroom-settings"] === "1") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        res.end(renderPage(app.view()));
        return;
      }
      const variant = params?.get("prototype_variant") ?? "";
      if (process.env.NODE_ENV !== "production" && isPrototypeVariant(variant)) {
        redirect(res, `/?variant=${variant}`);
        return;
      }
      redirect(res);
    };
    try {
      if (req.method === "GET" && pathname === "/command-status") {
        const view = app.view();
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify({ running: view.commandRunning, output: view.commandOutput ?? "" }));
        return;
      }
      if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
        const variant = parsed.searchParams.get("variant") ?? "";
        const html =
          process.env.NODE_ENV !== "production" && isPrototypeVariant(variant)
            ? renderPrototypePage(app.view(), variant)
            : renderPage(app.view());
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(html);
        return;
      }
      if (req.method === "GET" && pathname === "/brand-logo.png") {
        const bytes = await fs.readFile(path.join(__dirname, "..", "media", "brand-logo.png"));
        res.writeHead(200, {
          "Content-Type": "image/png",
          "Cache-Control": "no-store",
        });
        res.end(bytes);
        return;
      }
      if (req.method === "POST" && pathname === "/redeem") {
        const params = new URLSearchParams(await readBody(req));
        await app.redeem(
          params.get("invite_code") ?? "",
          params.get("nickname") ?? "",
        );
        goHome(params);
        return;
      }
      if (req.method === "POST" && pathname === "/pick-folder") {
        const params = new URLSearchParams(await readBody(req));
        const picked = await pickProjectFolder();
        if (picked) await app.setProjectFolder(picked);
        goHome(params);
        return;
      }
      if (req.method === "POST" && pathname === "/project-folder") {
        const params = new URLSearchParams(await readBody(req));
        const raw = (params.get("project_folder") ?? "").trim();
        if (!raw || (await fs.stat(raw).then((info) => info.isDirectory()).catch(() => false))) {
          await app.setProjectFolder(raw);
        } else {
          app.rejectProjectFolder();
        }
        goHome(params);
        return;
      }
      if (req.method === "POST" && pathname === "/prepare") {
        const params = new URLSearchParams(await readBody(req));
        app.prepare(params.get("action_id") ?? "");
        if (req.headers["x-classroom-progress"] === "1") {
          const view = app.view();
          res.writeHead(view.pendingCommand ? 200 : 409, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
          res.end(renderPage(view));
          return;
        }
        goHome(params);
        return;
      }
      if (req.method === "POST" && pathname === "/confirm") {
        const params = new URLSearchParams(await readBody(req));
        await app.confirm();
        if (req.headers["x-classroom-progress"] === "1") {
          const view = app.view();
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
          res.end(JSON.stringify({ succeeded: view.commandSucceeded, output: view.commandOutput ?? "", installedActionIds: view.installedActionIds ?? [] }));
          return;
        }
        goHome(params);
        return;
      }
      if (req.method === "POST" && pathname === "/cancel") {
        const params = new URLSearchParams(await readBody(req));
        app.cancel();
        if (req.headers["x-classroom-progress"] === "1") {
          const canceled = !app.view().pendingCommand;
          res.writeHead(canceled ? 200 : 409, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
          res.end(JSON.stringify({ canceled }));
          return;
        }
        goHome(params);
        return;
      }
      if (req.method === "POST" && pathname === "/environment-check") {
        const params = new URLSearchParams(await readBody(req));
        await app.checkEnvironment();
        goHome(params);
        return;
      }
      if (req.method === "POST" && pathname === "/environment") {
        const params = new URLSearchParams(await readBody(req));
        const tools = params
          .getAll("tool")
          .filter((value): value is EnvironmentToolId => isEnvironmentTool(value));
        app.selectEnvironment(tools);
        await app.confirmEnvironment();
        goHome(params);
        return;
      }
      if (req.method === "POST" && pathname === "/copy") {
        const params = new URLSearchParams(await readBody(req));
        await app.copyKey();
        goHome(params);
        return;
      }
      if (req.method === "POST" && pathname === "/copy-snippet") {
        const params = new URLSearchParams(await readBody(req));
        const ok = await app.copySnippet(params.get("snippet_id") ?? "");
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ ok }));
        return;
      }
      if (req.method === "POST" && pathname === "/clear") {
        const params = new URLSearchParams(await readBody(req));
        await app.clearConnection();
        goHome(params);
        return;
      }
      if (req.method === "POST" && pathname === "/switch") {
        const params = new URLSearchParams(await readBody(req));
        const mode = params.get("mode");
        if (mode === "classroom" || mode === "native") {
          await app.setSwitch(mode);
        }
        goHome(params);
        return;
      }
      if (req.method === "POST" && pathname === "/adapter") {
        const params = new URLSearchParams(await readBody(req));
        const client = params.get("client");
        if (client !== "codex" && client !== "claude") {
          res.writeHead(400); res.end("無效的客戶端。"); return;
        }
        await app.setAdapter(client, params.get("adapter") ?? "");
        goHome(params); return;
      }
      if (req.method === "POST" && pathname === "/reload") {
        const params = new URLSearchParams(await readBody(req));
        await app.reloadCatalog();
        await app.reloadAllowlist();
        goHome(params);
        return;
      }
      if (
        (req.method === "POST" || req.method === "PUT") &&
        (pathname.startsWith("/v1/") || pathname.startsWith("/backend-api/"))
      ) {
        const controller = new AbortController(); activeRequests.add(controller);
        const aborted = () => controller.abort();
        req.once("aborted", aborted);
        const closed = () => { if (!res.writableFinished) controller.abort(); };
        res.once("close", closed);
        const client = clientOf(req, pathname);
        try {
          const body = await readBody(req, 20_971_520);
          const slot: { response?: Response } = {};
          const headers: Record<string, string> = {};
          for (const name of ["anthropic-version", "anthropic-beta"]) {
            const value = req.headers[name]; if (typeof value === "string") headers[name] = value;
          }
          await responseSlot.run(slot, () => app.forward({ client, model: modelFromBody(body), method: req.method, path: pathname, body, headers, signal: controller.signal }));
          if (!controller.signal.aborted) await relayResponse(slot.response ?? Response.json({ error: { message: "上游沒有回應。" } }, { status: 502 }), res, client === "claude" ? "claude" : "codex", controller.signal);
        } finally {
          controller.abort(); activeRequests.delete(controller);
          req.removeListener("aborted", aborted); res.removeListener("close", closed);
        }
        return;
      }
      if (req.method === "POST" && pathname === "/stop") {
        const params = new URLSearchParams(await readBody(req));
        await app.stop();
        goHome(params);
        return;
      }
      if (req.method === "POST" && pathname === "/close") {
        app.closeWindow();
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("找不到頁面");
    } catch {
      if (res.destroyed) return;
      if (res.headersSent) { res.destroy(); return; }
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("VansPod 暫時無法完成這個動作。");
    }
  });

  server.on("error", () => {
    process.stderr.write(`無法在 127.0.0.1:${port} 開啟 VansPod。\n`);
    process.exit(1);
  });
  server.listen(port, "127.0.0.1", () => {
    void app.start().catch(() => {
      process.stderr.write("無法寫入 VCRouter。\n");
    });
    const home = pageUrl;
    const tray = runtimeOptions.desktop && process.platform === "win32" ? openTray(home) : undefined;
    if (runtimeOptions.desktop) openBrowser(home);
    const shutdown = () => {
      abortRequests();
      tray?.kill();
      server.close();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    process.stdout.write(`VansPod: ${home}\n`);
  });
}

void main();

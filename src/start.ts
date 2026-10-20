import { createPlatformConnectionStorage } from "./platformStorage";
import { detectClient } from "./clientDetection";
import { readRuntimeOptions } from "./runtimeOptions";
import { AsyncLocalStorage } from "node:async_hooks";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {
  ClassroomApp,
  ENVIRONMENT_TOOLS,
  type EnvironmentToolId,
  type ToolReadiness,
  type NicknameRedeemResult,
  type ProxyClient,
  type UpstreamSend,
  type UpstreamTarget,
} from "./classroomApp";
import { environmentStatus, modelStatus, renderInspectorPage, renderPage } from "./page";
import { createPromptCapture } from "./promptCapture";
import { writeClipboard } from "./clipboard";
import { pickProjectFolder } from "./folderPicker";
import { collectOutput, shellLaunch, runCommand, type CommandResult } from "./commandRunner";
import { createWindowsEnvironment } from "./windowsEnvironment";
import { windowsEnvironmentSystem } from "./windowsEnvironmentSystem";
import { exitDecision, removalInterruptions } from "./exitGuard";
import { isPrototypeVariant, renderPrototypePage } from "./pagePrototype";
import { createRouteFiles } from "./routeFiles";
import { decodeRequestBody } from "./responsesChat";
import { createAdapterSettingsStorage } from "./adapterSettings";
import { createClientRouteSettingsStorage } from "./clientRoutes";
import { createClientRouteRuntime, type AcceptedClientRoute } from "./clientRouteRuntime";
import { createVsCodeRouteSettings, type VsCodeProvider } from "./vsCodeRouteSettings";
import { forwardRouter, sendRouter, relayResponse } from "./modelProxy";
import { fetchSessionModelProviders } from "./routerSessionModels";
import { createClientTraffic } from "./clientTraffic";
import { type Instance, saveInstance, releaseInstance, managementDirectory } from "./instance";
import { asset, materializeAsset, openBrowser } from "./desktop";
import { lifecyclePage } from "./lifecyclePage";
import { removalPreview, prepareRemoval } from "./removal";
import { detectInstallation } from "./installations";
import { createVersionUpdate, VERSION_PATTERN } from "./versionUpdate";
import { VERSION } from "./version";

const runtimeOptions = readRuntimeOptions(process.env);
const port = runtimeOptions.port;
const pageUrl = `http://127.0.0.1:${port}/`;
const responseSlot = new AsyncLocalStorage<{
  response?: Response;
}>();
const activeRequests = new Set<AbortController>();
function abortRequests(): void { for (const controller of activeRequests) controller.abort(); }
const traffic = createClientTraffic();
// 只存在記憶體；每次啟動錄製都是關閉（ADR-0009）。
const promptCapture = createPromptCapture();
const promptCaptureActions = new Map<string, () => void>([
  ["/prompt-capture/start", () => promptCapture.start()],
  ["/prompt-capture/pause", () => promptCapture.pause()],
  ["/prompt-capture/clear", () => promptCapture.clear()],
]);

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

async function fetchSessionModels(apiKey: string): Promise<VsCodeProvider[]> {
  return fetchSessionModelProviders({ root: routerBaseUrl(), apiKey });
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
// VS Code 的直接下載安裝只做 Windows；macOS 開啟官方下載頁，由學生自己安裝。
const MAC_VSCODE_PAGE = "https://code.visualstudio.com/download";

/** macOS 維持原本的偵測：找得到且有輸出版本就算已就緒（ADR-0008：第一版只完整支援 Windows）。 */
function probeMacEnvironment(tool: EnvironmentToolId): Promise<ToolReadiness> {
  return collectOutput(tool === "vscode" ? "code" : tool, ["--version"]).then((result) => {
    if (result.spawnError) {
      return { readiness: "missing" };
    }
    return { readiness: result.exitCode === 0 || /\d/.test(result.output) ? "ready" : "missing" };
  });
}

/** 開發工具與 Project Folder 無關，安裝一律在使用者家目錄執行。 */
function installMacEnvironment(
  tool: EnvironmentToolId,
  signal?: AbortSignal,
): Promise<CommandResult> {
  const launch = tool === "pwsh"
    ? { command: "open", args: [MAC_PWSH_PAGE] }
    : tool === "vscode"
      ? { command: "open", args: [MAC_VSCODE_PAGE] }
      : shellLaunch(macEnvironmentInstallCommand(tool));
  return collectOutput(launch.command, launch.args, os.homedir(), undefined, signal).then((result) => {
    if (result.aborted) return { exitCode: result.exitCode, output: result.output, aborted: true };
    if (result.spawnError) {
      return { exitCode: 1, output: "安裝命令無法啟動。" };
    }
    return { exitCode: result.exitCode, output: result.output };
  });
}

function macEnvironmentInstallCommand(tool: EnvironmentToolId): string {
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

async function openTray(url: string): Promise<ChildProcess> {
  const directory = path.join(managementDirectory(), "desktop-assets");
  await fs.mkdir(directory, { recursive: true });
  const script = await materializeAsset(directory, "tray.ps1");
  const icon = await materializeAsset(directory, "brand-icon.ico");
  return spawn(
    "powershell.exe",
    [
      "-STA",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      script,
      "-Url", url,
      "-IconPath", icon,
      "-StateFile", path.join(managementDirectory(), "runtime", "instance.json"),
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

function upstreamOrigin(target: UpstreamTarget): string {
  if (target === "chatgpt") {
    return "https://chatgpt.com";
  }
  return "https://claude.ai";
}

async function sendUpstream(upstream: UpstreamSend): Promise<{ ok: boolean }> {
  if (!proxyAccepting || !upstream.path) {
    return { ok: false };
  }
  const slot = responseSlot.getStore();
  if (!slot) return { ok: false };
  if (upstream.target === "router") {
    // VS Code Chat already speaks Router's protocol; Codex and Claude Code go through a Model API Adapter.
    slot.response = upstream.client === "copilot"
      ? await forwardRouter(upstream, routerBaseUrl(), promptCapture)
      : await sendRouter(upstream, routerBaseUrl(), promptCapture);
    return { ok: slot.response.ok };
  }
  try {
    const response = await fetch(`${upstreamOrigin(upstream.target)}${upstream.path}`, {
      method: upstream.method ?? "POST",
      headers: { "Content-Type": "application/json" },
      body: upstream.body,
      signal: upstream.signal,
    });
    slot.response = response;
  } catch {
    slot.response = Response.json({ error: { message: "上游沒有回應。" } }, { status: 502 });
  }
  return { ok: slot.response.ok };
}

export async function main(instance?: Instance): Promise<void> {
  const routeFiles = createRouteFiles(routePaths());
  const settingsFile = path.join(os.homedir(), ".vanspod", "settings.json");
  let dispatch!: (
    accepted: AcceptedClientRoute,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) => Promise<void>;
  let app!: ClassroomApp;
  let exitRequested = false;
  const exitWork = () => ({ installing: app.view().commandRunning, activeRequests: activeRequests.size });
  let launchVersion: string | undefined;
  /**
   * 結束、移除與版本更新共同的交接：中止安裝與模型回答、恢復客戶端設定，再啟動接手的工具。
   * 失敗時不結束；`restored` 表示客戶端設定是否已恢復。
   */
  const handOff = async (launchTool?: () => Promise<void>): Promise<{ ok: true } | { ok: false; restored: boolean; error: unknown }> => {
    exitRequested = true;
    await app.abortInstall();
    abortRequests();
    let restored = false;
    try { await app.stop(); restored = true; await launchTool?.(); return { ok: true }; }
    catch (error) { exitRequested = false; return { ok: false, restored, error }; }
  };
  const versionUpdate = createVersionUpdate({
    current: VERSION,
    source: (await detectInstallation()) ?? { kind: "source" },
    work: exitWork,
    async exit(launchTool) {
      if (exitRequested) throw new Error("正在結束 VansPod。");
      // 下載期間學生可能開始了安裝；更新不中止安裝。
      if (exitWork().installing) throw new Error("安裝進行中，更新已取消。");
      const handed = await handOff(launchTool);
      if (!handed.ok) {
        if (handed.restored) await app.start().catch(() => undefined);
        throw handed.error;
      }
      void exit();
    },
  });
  let ready = false;
  let startupError: string | undefined;
  let tray: ChildProcess | undefined;
  let trayError: string | undefined;
  const exit = async () => {
    tray?.kill();
    await clientRouteRuntime.stop();
    if (instance) await releaseInstance(instance.id);
    process.exit(0);
  };
  const storage = createPlatformConnectionStorage(storageFile(), { legacyFilePath: legacyStorageFile() });
  const clientRouteRuntime = createClientRouteRuntime({
    basePort: port,
    models(route) {
      if (route !== "claudeCode") return undefined;
      const view = app.view();
      const claude = view.clientRoutes?.claudeCode;
      return claude?.mode === "classroom" && claude.health !== "red" && claude.health !== "gray"
        ? view.allowedModels ?? []
        : [];
    },
    handle: (accepted, req, res) => dispatch(accepted, req, res),
  });
  app = new ClassroomApp({
    detectClient,
    adapterSettings: createAdapterSettingsStorage(settingsFile),
    clientRouteSettings: createClientRouteSettingsStorage(settingsFile),
    clientRouteRuntime,
    vsCodeRouteSettings: createVsCodeRouteSettings({
      settingsFile: copilotModelsFile(),
      journalFile: path.join(os.homedir(), ".vanspod", "vscode-route-journal.json"),
      legacyOrigins: [pageUrl.replace(/\/$/, ""), "http://127.0.0.1:47821"],
    }),
    router: { redeemNickname, fetchSessionModels },
    catalog: { fetchCourseCatalog },
    projectFiles: { readClassroomInstalls },
    clipboard: { write: writeClipboard },
    commands: { run: runCommand },
    environment: process.platform === "win32"
      ? createWindowsEnvironment(windowsEnvironmentSystem)
      : { probe: probeMacEnvironment, install: installMacEnvironment },
    files: {
      async write() {
        throw new Error("VansPod 不寫 MCP 設定");
      },
    },
    storage,
    stopProcess() {
      // 關視窗不呼叫這裡。停止是頁面上的單獨動作。
    },
    proxyBaseUrl: pageUrl.replace(/\/$/, ""),
    routes: routeFiles,
    copilot: {
      read: readCopilotProviders,
      write: writeCopilotProviders,
    },
    proxy: createProxy(),
    send: sendUpstream,
  });
  dispatch = async (accepted, req, res) => {
    if (!/^(127\.0\.0\.1|localhost):\d+$/.test(req.headers.host ?? "")) { res.writeHead(403); res.end("本機網址無效。"); return; }
    const parsed = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    const pathname = parsed.pathname;
    const goHome = (params?: URLSearchParams) => {
      if (req.headers["x-classroom-settings"] === "1") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        const html = renderPage(app.pageView());
        res.end(instance ? lifecyclePage(html, instance.token) : html);
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
      if (instance && pathname.startsWith("/_vanspod/")) {
        if (req.headers.authorization !== `Bearer ${instance.token}` || (req.headers.origin && req.headers.origin !== instance.origin)) {
          res.writeHead(403); res.end(JSON.stringify({ id: instance.id, ok: false })); return;
        }
        const reply = (value: object) => { res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify({ id: instance.id, ...value })); };
        if (req.method === "GET" && pathname === "/_vanspod/status") { reply({ running: true, ready, startupError, pid: process.pid, version: instance.version, origin: instance.origin, launchVersion, trayError, activeRequests: activeRequests.size, installing: app.view().commandRunning }); return; }
        if (req.method === "POST" && pathname === "/_vanspod/open") {
          const body = JSON.parse(await readBody(req)) as { version?: string };
          if (typeof body.version === "string" && VERSION_PATTERN.test(body.version)) launchVersion = body.version;
          reply({ ok: true }); return;
        }
        if (req.method === "GET" && pathname === "/_vanspod/update") { reply(await versionUpdate.status({ refresh: parsed.searchParams.get("refresh") === "1", takeResult: parsed.searchParams.get("result") === "1" })); return; }
        if (req.method === "POST" && pathname === "/_vanspod/update") { reply(await versionUpdate.run(JSON.parse(await readBody(req) || "{}") as { interruptConfirmed?: boolean })); return; }
        if (req.method === "GET" && pathname === "/_vanspod/uninstall-preview") {
          reply({ ok: true, message: `${await removalPreview()}${removalInterruptions(exitWork())}` }); return;
        }
        if (req.method === "POST" && (pathname === "/_vanspod/stop" || pathname === "/_vanspod/uninstall")) {
          const body = JSON.parse(await readBody(req)) as { confirmed?: boolean; interruptConfirmed?: boolean; waitForPid?: number };
          const uninstall = pathname === "/_vanspod/uninstall";
          if (uninstall && body.confirmed !== true) { reply({ ok: false, confirmation: true, message: "請先確認將刪除的內容，再完整移除 VansPod。" }); return; }
          const decision = exitDecision(uninstall ? "uninstall" : "stop", exitWork(), uninstall ? body.interruptConfirmed === true : body.confirmed === true);
          if (!decision.proceed) { reply({ ok: false, confirmation: true, message: decision.message }); return; }
          if (exitRequested) { reply({ ok: false, message: "正在結束 VansPod。" }); return; }
          const handed = await handOff(uninstall
            ? async () => (await prepareRemoval(Number.isSafeInteger(body.waitForPid) && body.waitForPid! > 0 ? body.waitForPid : undefined, instance.id))()
            : undefined);
          if (handed.ok) {
            reply({ ok: true, message: uninstall ? "完整移除已開始；結果會以 Windows 訊息顯示。未完成時會保留移除工具供重試。" : "VansPod 已結束，可關閉此分頁。" });
            res.once("finish", () => { void exit(); });
          }
          else reply({ ok: false, message: handed.restored ? `移除未完成：${handed.error instanceof Error ? handed.error.message : "移除工具啟動失敗"}。請重試移除。` : `客戶端設定恢復失敗（${Object.entries(app.view().clientRoutes ?? {}).filter(([, route]) => route.health === "red").map(([id]) => id).join("、")}），備份已保留，請重試結束。` });
          return;
        }
        reply({ ok: false, message: "管理操作無效。" }); return;
      }
      if (exitRequested && req.method !== "GET") { res.writeHead(409); res.end("正在結束 VansPod，請稍後再試。"); return; }
      if (req.method === "GET" && pathname === "/command-status") {
        const view = app.view();
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify({ running: view.commandRunning, output: view.commandOutput ?? "" }));
        return;
      }
      if (req.method === "GET" && pathname === "/environment-status") {
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify(environmentStatus(app.view())));
        return;
      }
      if (req.method === "GET" && pathname === "/model-status") {
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify({ ...modelStatus(app.view()), traffic: traffic.flowing() }));
        return;
      }
      const captureAction = req.method === "POST" ? promptCaptureActions.get(pathname) : undefined;
      if (captureAction) {
        await readBody(req);
        captureAction();
        if (!(req.headers.accept ?? "").includes("application/json")) { redirect(res, "/prompt-inspector"); return; }
      }
      if (captureAction || (req.method === "GET" && pathname === "/prompt-capture")) {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ recording: promptCapture.recording, ...promptCapture.list() }));
        return;
      }
      if (req.method === "GET" && pathname === "/prompt-inspector") {
        const html = renderInspectorPage({ recording: promptCapture.recording, ...promptCapture.list() });
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        res.end(instance ? lifecyclePage(html, instance.token) : html);
        return;
      }
      if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
        const variant = parsed.searchParams.get("variant") ?? "";
        const html =
          process.env.NODE_ENV !== "production" && isPrototypeVariant(variant)
            ? renderPrototypePage(app.pageView(), variant)
            : renderPage(app.pageView());
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(instance ? lifecyclePage(html, instance.token) : html);
        return;
      }
      if (req.method === "GET" && (pathname === "/brand-logo.png" || pathname === "/favicon.ico" || pathname === "/fadou-superhero.png" || pathname === "/fadou-superhero-blink.png")) {
        const bytes = await asset(pathname === "/favicon.ico" ? "brand-icon.ico" : pathname.slice(1));
        res.writeHead(200, {
          "Content-Type": pathname === "/favicon.ico" ? "image/x-icon" : "image/png",
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
          res.end(JSON.stringify({ succeeded: view.commandSucceeded, aborted: view.commandAborted === true, output: view.commandOutput ?? "", installedActionIds: view.installedActionIds ?? [] }));
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
      if (req.method === "POST" && pathname === "/abort-install") {
        const params = new URLSearchParams(await readBody(req));
        await app.abortInstall();
        if (req.headers["x-classroom-progress"] === "1") {
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
          res.end(JSON.stringify({ aborted: true }));
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
      if (req.method === "POST" && pathname === "/environment-log") {
        const params = new URLSearchParams(await readBody(req));
        await app.openEnvironmentLog();
        goHome(params);
        return;
      }
      if (req.method === "POST" && pathname === "/environment") {
        const params = new URLSearchParams(await readBody(req));
        const tools = params
          .getAll("tool")
          .filter((value): value is EnvironmentToolId => isEnvironmentTool(value));
        app.selectEnvironment(tools);
        // 背景安裝：請求立刻回來，頁面輪詢 /environment-status。commandRunning 在 confirmEnvironment 同步開頭就設好，
        // 轉回首頁時已顯示進行中，exit guard、版本更新與移除也照常看得到這次安裝。
        void app.confirmEnvironment().catch(() => {});
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
          const client = params.get("client");
          if (client !== null && client !== "codex" && client !== "claude" && client !== "vscode") {
            res.writeHead(400); res.end("無效的客戶端。"); return;
          }
          await app.setSwitch(mode, client ?? undefined);
        }
        goHome(params);
        return;
      }
      if (req.method === "POST" && pathname === "/adapter") {
        const params = new URLSearchParams(await readBody(req));
        const client = params.get("client");
        if (client !== "codex" && client !== "claude" && client !== "vscode") {
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
        if (accepted.route !== "codex" && accepted.route !== "claudeCode" && accepted.route !== "vsCodeChat") {
          res.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: { message: "Client Route 目前無法使用。" } }));
          return;
        }
        const controller = new AbortController(); activeRequests.add(controller);
        const aborted = () => controller.abort();
        req.once("aborted", aborted);
        const closed = () => { if (!res.writableFinished) controller.abort(); };
        res.once("close", closed);
        const client: ProxyClient = accepted.route === "claudeCode" ? "claude" : accepted.route === "vsCodeChat" ? "copilot" : "codex";
        const endTraffic = traffic.begin(client === "copilot" ? "vscode" : client);
        try {
          const body = await readBody(req, 20_971_520);
          const slot: { response?: Response } = {};
          const headers: Record<string, string> = {};
          for (const name of ["anthropic-version", "anthropic-beta"]) {
            const value = req.headers[name]; if (typeof value === "string") headers[name] = value;
          }
          try {
            await responseSlot.run(slot, () => app.forward({ client, model: modelFromBody(body), method: req.method, path: pathname, body, headers, signal: controller.signal }));
          } catch (error) {
            const message = error instanceof Error ? error.message : "";
            if (!message.includes("重開 Codex") && !message.includes("重開 Claude Code") && !message.includes("重開 VS Code") && !message.includes("不在課堂允許清單")) throw error;
            slot.response = Response.json({ error: { message } }, { status: 409 });
          }
          if (!controller.signal.aborted) await relayResponse(slot.response ?? Response.json({ error: { message: "上游沒有回應。" } }, { status: 502 }), res, client === "claude" ? "claude" : "codex", controller.signal);
        } finally {
          controller.abort(); activeRequests.delete(controller); endTraffic();
          req.removeListener("aborted", aborted); res.removeListener("close", closed);
        }
        return;
      }
      if (req.method === "POST" && pathname === "/stop") {
        if (instance) { res.writeHead(409); res.end("請使用畫面的結束 VansPod，確認後再結束。"); return; }
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
  };

  const ui = await clientRouteRuntime.startUi!();
  const home = `${ui.origin}/`;
  try { if (instance) { instance.pid = process.pid; instance.origin = ui.origin; await saveInstance(instance); } }
  catch (error) { await clientRouteRuntime.stop(); throw error; }
  try { await app.start(); ready = true; }
  catch {
    startupError = "客戶端初始化失敗，請檢查本機 Client Route 設定、備份格式與檔案權限。";
    await fs.writeFile(path.join(managementDirectory(), "startup-error.json"), JSON.stringify({message: startupError}), {mode: 0o600}).catch(() => undefined);
    let restored = false;
    try { await app.stop(); restored = true; } catch { /* Keep the UI and management API for a safe retry. */ }
    if (restored) {
      await clientRouteRuntime.stop();
      if (instance) await releaseInstance(instance.id);
      throw new Error(startupError);
    }
    startupError += " 設定恢復未完成，服務已保留；修復後請重試 vanspod stop。";
  }
  versionUpdate.start();
  // 系統匣起不來時 VansPod 仍要繼續；頁面會提示改用頁面上的「結束 VansPod」。
  if (runtimeOptions.desktop && process.platform === "win32" && instance) {
    tray = await openTray(home).catch((error: unknown) => {
      trayError = error instanceof Error ? error.message : "系統匣無法啟動";
      process.stderr.write(`系統匣圖示無法顯示：${trayError}\n`);
      return undefined;
    });
  }
  if (runtimeOptions.desktop && !process.env.VANSPOD_WORKER_TOKEN) openBrowser(home);
  const shutdown = () => {
    if (app.view().commandRunning && !exitRequested) process.stderr.write("安裝仍在執行，請在 VansPod 畫面停止安裝後再結束。\n");
    if (exitRequested || app.view().commandRunning || activeRequests.size) return;
    exitRequested = true;
    void app.stop().then(exit).catch(() => { exitRequested = false; process.stderr.write("客戶端設定恢復失敗，請重試結束。\n"); });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdout.write(`VansPod: ${home}\n`);
}

if (require.main === module) void main();

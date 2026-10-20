import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { collectOutput } from "./commandRunner";
import { envWithRegistryPath } from "./systemPath";
import { VERSION } from "./version";
import type { EnvironmentSystem, RunOptions, RunResult } from "./windowsEnvironment";

function envValue(env: NodeJS.ProcessEnv, name: string): string {
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name);
  return (key && env[key]) || "";
}

async function isFile(file: string): Promise<boolean> {
  try { return (await fs.stat(file)).isFile(); } catch { /* 可能是無法 stat 的應用程式執行別名 */ }
  // winget 是 WindowsApps 裡的應用程式執行別名：stat 會得到 EACCES，但 lstat 看得到、也能直接執行。
  try { return (await fs.lstat(file)).isSymbolicLink(); } catch { return false; }
}

/** 像 cmd.exe 一樣在 PATH × PATHEXT 找指令；找不到回傳 undefined。 */
async function resolveCommand(command: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  if (path.isAbsolute(command)) return (await isFile(command)) ? command : undefined;
  const extensions = (envValue(env, "PATHEXT") || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const candidates = path.extname(command) ? [command] : extensions.map((extension) => command + extension.toLowerCase());
  for (const folder of envValue(env, "PATH").split(";").filter(Boolean)) {
    for (const candidate of candidates) {
      const file = path.join(folder.replace(/^"|"$/g, ""), candidate);
      if (await isFile(file)) return file;
    }
  }
  return undefined;
}

function cmdQuote(value: string): string {
  return /[\s"&|<>^()%!,;=]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** .cmd／.bat 只能交給 cmd.exe；/v:off 讓路徑裡的驚嘆號保持原樣。 */
function launch(file: string, args: string[]): { command: string; args: string[] } {
  if (/\.(cmd|bat)$/i.test(file)) {
    return { command: "cmd.exe", args: ["/d", "/v:off", "/s", "/c", `"${[`"${file}"`, ...args.map(cmdQuote)].join(" ")}"`] };
  }
  return { command: file, args };
}

async function run(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  const env = await envWithRegistryPath();
  const file = await resolveCommand(command, env);
  if (!file) return { exitCode: undefined, output: "", notFound: true, timedOut: false, aborted: false };
  const controller = new AbortController();
  const stop = () => controller.abort();
  if (options.signal?.aborted) stop();
  else options.signal?.addEventListener("abort", stop, { once: true });
  let timedOut = false;
  const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs);
  try {
    const target = launch(file, args);
    // 開發工具與 Project Folder 無關：一律以使用者家目錄為工作目錄。
    const result = await collectOutput(target.command, target.args, os.homedir(), options.onOutput, controller.signal, env);
    return {
      exitCode: result.exitCode,
      output: result.output,
      notFound: result.spawnError,
      timedOut,
      aborted: result.aborted && !timedOut,
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", stop);
  }
}

async function download(url: string, destination: string, options: { signal?: AbortSignal; onProgress?: (received: number, total: number | undefined) => void } = {}): Promise<void> {
  const file = await fs.open(destination, "w");
  try {
    const response = await fetch(url, { signal: options.signal, headers: { "User-Agent": `VansPod/${VERSION}` } });
    if (!response.ok || !response.body) throw new Error(`下載失敗（HTTP ${response.status}）`);
    const length = Number(response.headers.get("content-length"));
    const total = Number.isFinite(length) && length > 0 ? length : undefined;
    let received = 0;
    for await (const chunk of response.body) {
      await file.write(chunk);
      received += chunk.byteLength;
      options.onProgress?.(received, total);
    }
    if (received === 0 || (total !== undefined && received !== total)) throw new Error("下載未完成");
    await file.close();
  } catch (error) {
    await file.close().catch(() => {});
    await fs.rm(destination, { force: true });
    throw error;
  }
}

/** 查詢官方最新版本資訊；30 秒沒有回應視為失敗。非 200 時不解析內容。 */
async function fetchJson(url: string, options: { signal?: AbortSignal } = {}): Promise<{ status: number; body: unknown }> {
  const timeout = AbortSignal.timeout(30_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const response = await fetch(url, { signal, headers: { "User-Agent": `VansPod/${VERSION}`, Accept: "application/json" } });
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => {});
    return { status: response.status, body: undefined };
  }
  return { status: response.status, body: await response.json() };
}

function signature(file: string): Promise<{ status: string; subject: string }> {
  const script = "[Console]::OutputEncoding = [Text.Encoding]::UTF8; $s = Get-AuthenticodeSignature -LiteralPath $env:VANSPOD_SIGNED_FILE; @{ status = [string]$s.Status; subject = [string]$s.SignerCertificate.Subject } | ConvertTo-Json -Compress";
  const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  // 路徑走環境變數，不必處理引號裡的中文、空白、驚嘆號、單引號。
  // 從 PowerShell 7 啟動時繼承的 PSModulePath 會讓 Windows PowerShell 載不到自己的 Security 模組。
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== "PSMODULEPATH"));
  env.VANSPOD_SIGNED_FILE = file;
  return new Promise((resolve) => {
    execFile(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", env, timeout: 30_000, windowsHide: true }, (error, stdout) => {
      try {
        if (error) throw error;
        const parsed = JSON.parse(stdout) as { status?: unknown; subject?: unknown };
        resolve({ status: String(parsed.status ?? ""), subject: String(parsed.subject ?? "") });
      } catch {
        resolve({ status: "UnknownError", subject: "" });
      }
    });
  });
}

/** 真正的 Windows 系統動作。 */
export const windowsEnvironmentSystem: EnvironmentSystem = {
  run,
  download,
  signature,
  fetchJson,
  async wingetAvailable() {
    return (await resolveCommand("winget", await envWithRegistryPath())) !== undefined;
  },
  async openFolder(folder) {
    if (process.env.CLASSROOM_APP_HEADLESS === "1") return;
    // explorer.exe 直接收路徑參數，中文、空白、驚嘆號都不必經過 cmd.exe 的引號規則。
    const explorer = path.join(process.env.SystemRoot ?? "C:\\Windows", "explorer.exe");
    const child = spawn(explorer, [folder], { detached: true, stdio: "ignore", windowsHide: false });
    child.on("error", () => {});
    child.unref();
  },
  async start(command, args) {
    if (process.env.CLASSROOM_APP_HEADLESS === "1") return;
    const env = await envWithRegistryPath();
    const file = await resolveCommand(command, env);
    if (!file) throw new Error(`找不到 ${command}`);
    const target = launch(file, args);
    // code.cmd 經由 cmd.exe 轉手：隱藏 cmd 視窗，VS Code 自己的視窗照常出現。
    const child = spawn(target.command, target.args, {
      cwd: os.homedir(),
      env,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      windowsVerbatimArguments: target.command === "cmd.exe",
    });
    child.on("error", () => {});
    child.unref();
  },
};

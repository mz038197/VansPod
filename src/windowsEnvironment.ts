import path from "node:path";
import {
  ENVIRONMENT_LABEL,
  type EnvironmentInstallLog,
  type EnvironmentInstallReport,
  type EnvironmentInstallResult,
  type EnvironmentToolId,
  type ToolReadiness,
} from "./classroomApp";
import { type InstallLogFile, startInstallLogFile } from "./environmentInstallLog";
import { managementDirectory } from "./instance";
import { lookupDownload, vsCodeInstaller, type WindowsArchitecture, type WingetTool, wingetToolInstaller } from "./officialDownloads";
import { abortedResult, failedResult, installOfficialInstaller, REBOOT_REQUIRED, runEntry } from "./officialInstaller";

export type RunOptions = { timeoutMs?: number; signal?: AbortSignal; onOutput?: (output: string) => void };

/** notFound：找不到指令；timedOut：超過 timeoutMs 被結束（程序樹已終止）。 */
export type RunResult = { exitCode: number | undefined; output: string; notFound: boolean; timedOut: boolean; aborted: boolean };

export type DownloadOptions = { signal?: AbortSignal; onProgress?: (received: number, total: number | undefined) => void };

export { DownloadHttpError } from "./officialInstaller";

/** Windows 環境安裝模組唯一依賴的系統動作；測試注入假的版本。 */
export type EnvironmentSystem = {
  /** 執行程序：每次都套用登錄檔最新的 PATH；可設逾時、可中止。 */
  run(command: string, args: string[], options?: RunOptions): Promise<RunResult>;
  /** 串流下載到 destination，可回報進度、可中止；伺服器回覆非 2xx 時丟出 DownloadHttpError。 */
  download(url: string, destination: string, options?: DownloadOptions): Promise<void>;
  /** Authenticode 簽章查詢：status 為 "Valid" 才有效；subject 是簽署者憑證主體。 */
  signature(file: string): Promise<{ status: string; subject: string }>;
  /** 查詢官方網站的最新版本資訊：回傳 HTTP 狀態與解析後的 JSON；連線失敗時丟出錯誤。 */
  fetchJson(url: string, options?: { signal?: AbortSignal }): Promise<{ status: number; body: unknown }>;
  wingetAvailable(): Promise<boolean>;
  /** 在檔案總管開啟資料夾。 */
  openFolder(folder: string): Promise<void>;
  /** 啟動視窗程式後立即返回，不等它結束；指令同樣依登錄檔最新的 PATH 尋找。 */
  start(command: string, args: string[]): Promise<void>;
};

export type WindowsEnvironmentOptions = {
  /** VansPod 管理資料夾；安裝紀錄寫在其下的 InstallLogs。 */
  managementDirectory?: string;
  now?: () => Date;
  /** 判斷 OS 架構用的環境變數；預設 process.env。 */
  env?: NodeJS.ProcessEnv;
  /** 下載暫時失敗後等多久再重試；預設 2 秒。 */
  retryDelayMs?: number;
};

const VERSION_CHECK: Record<EnvironmentToolId, { command: string; pattern: RegExp }> = {
  uv: { command: "uv", pattern: /^uv \d+\.\d+\.\d+/ },
  git: { command: "git", pattern: /^git version \d+\.\d+/ },
  node: { command: "node", pattern: /^v\d+\.\d+\.\d+$/ },
  pwsh: { command: "pwsh", pattern: /^PowerShell 7\.\d+\.\d+/ },
  // code --version 印出版本、commit 與架構三行；只看第一行。
  vscode: { command: "code", pattern: /^\d+\.\d+\.\d+(?:[-+]\S+)?(?:\r?\n|$)/ },
};

const CHECK_TIMEOUT_MS = 15_000;
const NODE_LTS_REASON = "需要 Node.js LTS，且 npm 必須可正常執行";

type Check = { ok: true; output: string } | { ok: false; readiness: "missing" | "needsRepair"; reason: string };

/** 一次檢查：結束碼必須為 0，且完整輸出符合格式；版本文字掩蓋不了非 0 結束碼。 */
async function check(system: EnvironmentSystem, command: string, args: string[], pattern: RegExp): Promise<Check> {
  const result = await system.run(command, args, { timeoutMs: CHECK_TIMEOUT_MS });
  const shown = [command, ...args].join(" ");
  if (result.notFound) return { ok: false, readiness: "missing", reason: `找不到 ${command}` };
  if (result.timedOut) {
    return { ok: false, readiness: "needsRepair", reason: `${shown} 檢查超過 ${CHECK_TIMEOUT_MS / 1000} 秒，建議修復此工具` };
  }
  if (result.exitCode !== 0) return { ok: false, readiness: "needsRepair", reason: `${shown} 失敗（結束碼 ${result.exitCode ?? "未知"}）` };
  const output = result.output.trim();
  if (!pattern.test(output)) return { ok: false, readiness: "needsRepair", reason: `${shown} 的輸出不是版本號` };
  return { ok: true, output };
}

const WINGET_ID: Record<WingetTool, string> = {
  git: "Git.Git",
  node: "OpenJS.NodeJS.LTS",
  pwsh: "Microsoft.PowerShell",
};

function isWingetTool(tool: EnvironmentToolId): tool is WingetTool {
  return tool in WINGET_ID;
}
const WINGET_QUIET = ["--source", "winget", "--disable-interactivity", "-h", "--accept-package-agreements", "--accept-source-agreements"];
// 0x8A15002B：winget 回報已安裝、沒有可用的升級；有號與無號兩種寫法都可能出現。
const WINGET_ALREADY_INSTALLED = [-1978335189, 2316632107];
const WINGET_ACCEPTED = [0, REBOOT_REQUIRED, ...WINGET_ALREADY_INSTALLED];

function installLaunch(tool: Exclude<EnvironmentToolId, "vscode">): { command: string; args: string[] } {
  if (tool === "uv") {
    return { command: "powershell.exe", args: ["-ExecutionPolicy", "ByPass", "-c", "irm https://astral.sh/uv/install.ps1 | iex"] };
  }
  return { command: "winget", args: ["install", "--id", WINGET_ID[tool], "-e", ...WINGET_QUIET] };
}

/** OS 的實際架構：32 位元行程看到的 PROCESSOR_ARCHITECTURE 是 x86，真正的架構在 PROCESSOR_ARCHITEW6432。 */
function windowsArchitecture(env: NodeJS.ProcessEnv): WindowsArchitecture | string {
  const value = (env.PROCESSOR_ARCHITEW6432 || env.PROCESSOR_ARCHITECTURE || "").toUpperCase();
  if (value === "AMD64") return "x64";
  if (value === "ARM64") return "arm64";
  return value || "未知";
}

function readinessText(readiness: ToolReadiness): string {
  const detail = (text: string | undefined) => (text ? `：${text}` : "");
  if (readiness.readiness === "ready") return `已就緒${readiness.version ? `（${readiness.version}）` : ""}`;
  return `${readiness.readiness === "needsRepair" ? "需要修復" : "未安裝"}${detail(readiness.reason)}`;
}

export function createWindowsEnvironment(system: EnvironmentSystem, options: WindowsEnvironmentOptions = {}) {
  // 目前這次 Environment Install 的紀錄；startLog() 開始新的一次。
  let currentLog: InstallLogFile | undefined;
  return {
    probe,
    /** 開始一次 Environment Install 的紀錄，之後每個工具的安裝都寫進同一個資料夾。 */
    async startLog(): Promise<EnvironmentInstallLog> {
      const now = options.now?.() ?? new Date();
      const log = await startInstallLogFile(options.managementDirectory ?? managementDirectory(), now);
      currentLog = log;
      await log.append(`VansPod Environment Install ${now.toISOString()}\r\n\r\n`);
      return {
        folder: log.folder,
        verified: (tool, readiness) => log.append(`驗證 ${ENVIRONMENT_LABEL[tool]}：${readinessText(readiness)}\r\n\r\n`),
        finish: (summary) => log.append(`結果：${summary}\r\n`),
      };
    },
    async openLogFolder(folder: string): Promise<void> {
      await system.openFolder(folder);
    },
    /** 「開啟 VS Code」：有資料夾就以它開啟。 */
    async openVsCode(folder?: string): Promise<void> {
      await system.start("code", folder ? [folder] : []);
    },
    /** 開發工具與 Project Folder 無關；程序在使用者家目錄執行（見 windowsEnvironmentSystem）。 */
    async install(
      tool: EnvironmentToolId,
      signal?: AbortSignal,
      onProgress?: (progress: EnvironmentInstallReport) => void,
    ): Promise<EnvironmentInstallResult> {
      if (tool === "vscode") return installVsCode(signal, onProgress);
      // 有 winget 時維持 winget，避免教室共用 IP 撞到 GitHub API 次數上限（ADR-0011）。
      if (isWingetTool(tool) && !(await system.wingetAvailable())) return installWithoutWinget(tool, signal, onProgress);
      const { command, args } = installLaunch(tool);
      onProgress?.({ stage: "installing" });
      // 安裝不設逾時（ADR-0008）：卡住時由學生 Abort Install。
      const result = await system.run(command, args, { signal });
      await currentLog?.append(runEntry(ENVIRONMENT_LABEL[tool], command, args, result));
      if (result.aborted) return abortedResult(result.output);
      if (result.notFound) return { output: "安裝命令無法啟動。", exitCode: undefined, exitAccepted: false };
      // 安裝程式結束後由 ClassroomApp 立刻驗證。
      onProgress?.({ stage: "verifying" });
      const exitAccepted = result.exitCode !== undefined && WINGET_ACCEPTED.includes(result.exitCode);
      return {
        output: result.output,
        exitCode: result.exitCode,
        exitAccepted,
        ...(result.exitCode === REBOOT_REQUIRED ? { rebootRequired: true } : {}),
      };
    },
  };

  async function probe(tool: EnvironmentToolId): Promise<ToolReadiness> {
    const { command, pattern } = VERSION_CHECK[tool];
    const result = await check(system, command, ["--version"], pattern);
    if (!result.ok) return { readiness: result.readiness, reason: result.reason };
    const version = result.output.split(/\r?\n/)[0];
    if (tool === "node") {
      // 課程套件只保證 LTS；npm 壞掉等於 Node.js 不能用。
      const lts = await check(system, "node", ["-p", "Boolean(process.release.lts)"], /^true$/);
      if (!lts.ok) return { readiness: "needsRepair", version, reason: NODE_LTS_REASON };
      const npm = await check(system, "npm", ["--version"], /^\d+\.\d+\.\d+$/);
      if (!npm.ok) return { readiness: "needsRepair", version, reason: `${NODE_LTS_REASON}（${npm.reason}）` };
    }
    return { readiness: "ready", version };
  }

  /** 直接下載官方安裝檔的共用設定：下載快取、紀錄、驗證通過才刪除安裝檔。 */
  function officialContext(tool: EnvironmentToolId, signal?: AbortSignal, onProgress?: (progress: EnvironmentInstallReport) => void) {
    return {
      system,
      cacheFolder: path.join(options.managementDirectory ?? managementDirectory(), "Downloads"),
      retryDelayMs: options.retryDelayMs ?? 2000,
      signal,
      onProgress,
      log: async (text: string) => { await currentLog?.append(text); },
      verify: () => probe(tool),
    };
  }

  async function failed(tool: EnvironmentToolId, failure: string): Promise<EnvironmentInstallResult> {
    await currentLog?.append(`== ${ENVIRONMENT_LABEL[tool]} ==\r\n${failure}\r\n\r\n`);
    return failedResult(failure);
  }

  /** 官方安裝檔只有 x64 與 arm64；回傳架構，無法判斷時回傳失敗原因。 */
  function officialArchitecture(tool: EnvironmentToolId): WindowsArchitecture | { failure: string } {
    const architecture = windowsArchitecture(options.env ?? process.env);
    if (architecture === "x64" || architecture === "arm64") return architecture;
    return { failure: `無法判斷 Windows 架構（${architecture}），${ENVIRONMENT_LABEL[tool]} 只提供 x64 與 arm64 安裝檔` };
  }

  /** 安裝器自己的 log 併入本次安裝紀錄；沒有紀錄時放在下載快取旁。 */
  function setupLogFile(tool: EnvironmentToolId, cacheFolder: string): string {
    return path.join(currentLog?.folder ?? cacheFolder, `${tool}-setup.log`);
  }

  async function installVsCode(signal?: AbortSignal, onProgress?: (progress: EnvironmentInstallReport) => void): Promise<EnvironmentInstallResult> {
    const context = officialContext("vscode", signal, onProgress);
    const architecture = officialArchitecture("vscode");
    if (typeof architecture !== "string") return failed("vscode", architecture.failure);
    return installOfficialInstaller(vsCodeInstaller(architecture, setupLogFile("vscode", context.cacheFolder)), context);
  }

  /** 沒有 winget：查官方最新穩定版，下載安裝檔、確認簽章後靜默安裝。 */
  async function installWithoutWinget(
    tool: WingetTool,
    signal?: AbortSignal,
    onProgress?: (progress: EnvironmentInstallReport) => void,
  ): Promise<EnvironmentInstallResult> {
    const context = officialContext(tool, signal, onProgress);
    await context.log(`找不到 winget，${ENVIRONMENT_LABEL[tool]} 改從官方網站下載安裝檔\r\n`);
    const architecture = officialArchitecture(tool);
    if (typeof architecture !== "string") return failed(tool, architecture.failure);
    const lookup = await lookupDownload(system, tool, architecture, signal);
    if ("aborted" in lookup) {
      await context.log(`${ENVIRONMENT_LABEL[tool]}：查詢最新版本時已中止\r\n\r\n`);
      return abortedResult();
    }
    if ("failure" in lookup) return failed(tool, lookup.failure);
    return installOfficialInstaller(wingetToolInstaller(tool, lookup.download, setupLogFile(tool, context.cacheFolder)), context);
  }
}

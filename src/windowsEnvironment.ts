import {
  ENVIRONMENT_LABEL,
  type EnvironmentInstallLog,
  type EnvironmentInstallResult,
  type EnvironmentToolId,
  type ToolReadiness,
} from "./classroomApp";
import { type InstallLogFile, startInstallLogFile } from "./environmentInstallLog";
import { managementDirectory } from "./instance";

export type RunOptions = { timeoutMs?: number; signal?: AbortSignal; onOutput?: (output: string) => void };

/** notFound：找不到指令；timedOut：超過 timeoutMs 被結束（程序樹已終止）。 */
export type RunResult = { exitCode: number | undefined; output: string; notFound: boolean; timedOut: boolean; aborted: boolean };

export type DownloadOptions = { signal?: AbortSignal; onProgress?: (received: number, total: number | undefined) => void };

/** Windows 環境安裝模組唯一依賴的系統動作；測試注入假的版本。 */
export type EnvironmentSystem = {
  /** 執行程序：每次都套用登錄檔最新的 PATH；可設逾時、可中止。 */
  run(command: string, args: string[], options?: RunOptions): Promise<RunResult>;
  /** 串流下載到 destination，可回報進度、可中止。 */
  download(url: string, destination: string, options?: DownloadOptions): Promise<void>;
  /** Authenticode 簽章查詢：status 為 "Valid" 才有效；subject 是簽署者憑證主體。 */
  signature(file: string): Promise<{ status: string; subject: string }>;
  wingetAvailable(): Promise<boolean>;
  /** 在檔案總管開啟資料夾。 */
  openFolder(folder: string): Promise<void>;
};

export type WindowsEnvironmentOptions = {
  /** VansPod 管理資料夾；安裝紀錄寫在其下的 InstallLogs。 */
  managementDirectory?: string;
  now?: () => Date;
};

const VERSION_CHECK: Record<EnvironmentToolId, { command: string; pattern: RegExp }> = {
  uv: { command: "uv", pattern: /^uv \d+\.\d+\.\d+/ },
  git: { command: "git", pattern: /^git version \d+\.\d+/ },
  node: { command: "node", pattern: /^v\d+\.\d+\.\d+$/ },
  pwsh: { command: "pwsh", pattern: /^PowerShell 7\.\d+\.\d+/ },
};

const CHECK_TIMEOUT_MS = 15_000;
const NODE_LTS_REASON = "需要 Node.js LTS，且 npm 必須可正常執行";

type Check ={ ok: true; output: string } | { ok: false; readiness: "missing" | "needsRepair"; reason: string };

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

const WINGET_ID: Record<Exclude<EnvironmentToolId, "uv">, string> = {
  git: "Git.Git",
  node: "OpenJS.NodeJS.LTS",
  pwsh: "Microsoft.PowerShell",
};
const WINGET_QUIET = ["--source", "winget", "--disable-interactivity", "-h", "--accept-package-agreements", "--accept-source-agreements"];
const REBOOT_REQUIRED = 3010;
// 0x8A15002B：winget 回報已安裝、沒有可用的升級；有號與無號兩種寫法都可能出現。
const WINGET_ALREADY_INSTALLED = [-1978335189, 2316632107];
const WINGET_ACCEPTED = [0, REBOOT_REQUIRED, ...WINGET_ALREADY_INSTALLED];

function installLaunch(tool: EnvironmentToolId): { command: string; args: string[] } {
  if (tool === "uv") {
    return { command: "powershell.exe", args: ["-ExecutionPolicy", "ByPass", "-c", "irm https://astral.sh/uv/install.ps1 | iex"] };
  }
  return { command: "winget", args: ["install", "--id", WINGET_ID[tool], "-e", ...WINGET_QUIET] };
}

function readinessText(readiness: ToolReadiness): string {
  const detail = (text: string | undefined) => (text ? `：${text}` : "");
  if (readiness.readiness === "ready") return `已就緒${readiness.version ? `（${readiness.version}）` : ""}`;
  return `${readiness.readiness === "needsRepair" ? "需要修復" : "未安裝"}${detail(readiness.reason)}`;
}

function quoteForLog(value: string): string {
  return /[\s"]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

function installEntry(tool: EnvironmentToolId, command: string, args: string[], result: RunResult): string {
  const outcome = result.aborted ? "已中止" : result.notFound ? "無法啟動" : `${result.exitCode ?? "未知"}`;
  return [
    `== ${ENVIRONMENT_LABEL[tool]} ==`,
    `指令：${[command, ...args].map(quoteForLog).join(" ")}`,
    `結束碼：${outcome}`,
    "輸出：",
    result.output.trimEnd(),
    "",
  ].join("\r\n");
}

export function createWindowsEnvironment(system: EnvironmentSystem, options: WindowsEnvironmentOptions = {}) {
  // 目前這次 Environment Install 的紀錄；startLog() 開始新的一次。
  let currentLog: InstallLogFile | undefined;
  return {
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
    /** 開發工具與 Project Folder 無關；程序在使用者家目錄執行（見 windowsEnvironmentSystem）。 */
    async install(tool: EnvironmentToolId, signal?: AbortSignal): Promise<EnvironmentInstallResult> {
      const { command, args } = installLaunch(tool);
      // 安裝不設逾時（ADR-0008）：卡住時由學生 Abort Install。
      const result = await system.run(command, args, { signal });
      await currentLog?.append(installEntry(tool, command, args, result));
      if (result.aborted) return { output: result.output, exitCode: result.exitCode, aborted: true, exitAccepted: false };
      if (result.notFound) return { output: "安裝命令無法啟動。", exitCode: undefined, exitAccepted: false };
      const exitAccepted = result.exitCode !== undefined && WINGET_ACCEPTED.includes(result.exitCode);
      return {
        output: result.output,
        exitCode: result.exitCode,
        exitAccepted,
        ...(result.exitCode === REBOOT_REQUIRED ? { rebootRequired: true } : {}),
      };
    },
    async probe(tool: EnvironmentToolId): Promise<ToolReadiness> {
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
    },
  };
}

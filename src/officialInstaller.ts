import fs from "node:fs/promises";
import path from "node:path";
import type { EnvironmentInstallReport, EnvironmentInstallResult, ToolReadiness } from "./classroomApp";
import type { EnvironmentSystem, RunResult } from "./windowsEnvironment";

/** 一個官方安裝檔：從哪裡下載、在下載快取裡叫什麼、預期誰簽署、怎麼靜默執行。 */
export type OfficialInstaller = {
  /** 畫面與紀錄上的工具名稱。 */
  label: string;
  url: string;
  /** 下載快取裡的檔名；同一個檔名在重試時沿用。 */
  fileName: string;
  /** Authenticode 簽署者憑證主體必須符合，例如 /(?:^|,\s*)O=Microsoft Corporation(?:,|$)/。 */
  signer: RegExp;
  /** 靜默安裝的指令；installer 是下載快取裡安裝檔的完整路徑。 */
  launch(installer: string): { command: string; args: string[] };
};

export type OfficialInstallContext = {
  system: EnvironmentSystem;
  /** VansPod 管理資料夾下的下載快取。 */
  cacheFolder: string;
  /** 下載暫時失敗後等多久再重試。 */
  retryDelayMs: number;
  signal?: AbortSignal;
  onProgress?: (progress: EnvironmentInstallReport) => void;
  /** 寫入本次安裝紀錄。 */
  log(text: string): Promise<void>;
  /** 安裝程式結束後驗證工具；已就緒才刪除安裝檔，否則保留給重試沿用。結果放進 verified，ClassroomApp 不再重驗。 */
  verify(): Promise<ToolReadiness>;
};

/** 安裝程式的結束碼：0 成功、3010 需要重新開機（Inno Setup 與 msiexec 相同）；成敗仍以驗證為準。 */
export const REBOOT_REQUIRED = 3010;
const ACCEPTED_EXIT = [0, REBOOT_REQUIRED];

/** Abort Install 停下的安裝：之後由 ClassroomApp 重新檢查全部工具。 */
export function abortedResult(output = ""): EnvironmentInstallResult {
  return { output, exitCode: undefined, aborted: true, exitAccepted: false };
}

/** 安裝程式沒有執行（例如下載失敗、簽章不符）：failure 是給學生看的原因。 */
export function failedResult(failure: string): EnvironmentInstallResult {
  return { output: failure, exitCode: undefined, exitAccepted: false, failure };
}

export function runEntry(label: string, command: string, args: string[], result: RunResult): string {
  const quote = (value: string) => (/[\s"]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value);
  const outcome = result.aborted ? "已中止" : result.notFound ? "無法啟動" : `${result.exitCode ?? "未知"}`;
  return [`== ${label} ==`, `指令：${[command, ...args].map(quote).join(" ")}`, `結束碼：${outcome}`, "輸出：", result.output.trimEnd(), ""].join("\r\n");
}

/** 下載最多嘗試 3 次；中止不重試。 */
const DOWNLOAD_ATTEMPTS = 3;

async function exists(file: string): Promise<boolean> {
  return fs.stat(file).then((stat) => stat.isFile(), () => false);
}

/** Authenticode 必須為 Valid 且簽署者符合；通過回傳 undefined，否則回傳原因。 */
async function checkSignature(system: EnvironmentSystem, file: string, signer: RegExp): Promise<string | undefined> {
  const { status, subject } = await system.signature(file).catch(() => ({ status: "UnknownError", subject: "" }));
  if (status === "Valid" && signer.test(subject)) return undefined;
  return `安裝檔簽章驗證失敗（${status || "未知"}${subject ? `，簽署者 ${subject}` : ""}），為了安全不執行`;
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** 下載時伺服器回覆非 2xx：帶著 HTTP 狀態，讓重試只針對暫時性的失敗。 */
export class DownloadHttpError extends Error {
  constructor(readonly status: number) {
    super(`下載失敗（HTTP ${status}）`);
  }
}

/** 值得重試的下載失敗：連線錯誤、下載不完整、5xx、408、429；其他 4xx（例如 404）重試也不會好。 */
function isTemporary(error: unknown): boolean {
  if (!(error instanceof DownloadHttpError)) return true;
  return error.status >= 500 || error.status === 408 || error.status === 429;
}

/** 串流下載並回報進度；暫時失敗等一下再試。成功或中止回傳 undefined，失敗回傳最後的錯誤訊息。 */
async function downloadWithRetry(installer: OfficialInstaller, file: string, context: OfficialInstallContext): Promise<{ error: string; attempts: number } | undefined> {
  const { system, signal, onProgress } = context;
  let lastError = "";
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
    if (signal?.aborted) return undefined;
    try {
      await system.download(installer.url, file, {
        signal,
        onProgress: (downloaded, total) => onProgress?.({ stage: "downloading", downloaded, ...(total === undefined ? {} : { total }) }),
      });
      return undefined;
    } catch (error) {
      // 系統動作已刪除下載一半的檔案；這裡再確認一次。
      await fs.rm(file, { force: true }).catch(() => {});
      if (signal?.aborted) return undefined;
      lastError = error instanceof Error ? error.message : String(error);
      await context.log(`第 ${attempt} 次下載失敗：${lastError}\r\n`);
      if (!isTemporary(error)) return { error: lastError, attempts: attempt };
      if (attempt < DOWNLOAD_ATTEMPTS) await wait(context.retryDelayMs, signal);
    }
  }
  return { error: lastError, attempts: DOWNLOAD_ATTEMPTS };
}

/**
 * 直接下載官方安裝檔並靜默安裝（ADR-0011）：串流下載到下載快取並回報進度，執行前確認簽章，
 * 結束後驗證工具，驗證通過才刪除安裝檔。
 */
export async function installOfficialInstaller(installer: OfficialInstaller, context: OfficialInstallContext): Promise<EnvironmentInstallResult> {
  const { system, signal, onProgress } = context;
  const file = path.join(context.cacheFolder, installer.fileName);
  const remove = () => fs.rm(file, { force: true }).catch(() => {});
  const aborted = async (output = ""): Promise<EnvironmentInstallResult> => {
    // 中止時立即刪除安裝檔，下次重新下載（ADR-0008 補充）。
    await remove();
    await context.log(`${installer.label}：已中止，已刪除安裝檔\r\n\r\n`);
    return abortedResult(output);
  };
  const failed = async (failure: string): Promise<EnvironmentInstallResult> => {
    await context.log(`${installer.label}：${failure}\r\n\r\n`);
    return failedResult(failure);
  };

  await fs.mkdir(context.cacheFolder, { recursive: true });
  // 上次驗證沒過而保留的安裝檔：簽章仍然正確才沿用，否則重新下載。
  let reused = false;
  if (await exists(file)) {
    reused = (await checkSignature(system, file, installer.signer)) === undefined;
    await context.log(reused ? `沿用下載快取裡的安裝檔：${file}\r\n` : `下載快取裡的安裝檔簽章不符，重新下載\r\n`);
    if (!reused) await remove();
  }
  if (!reused) {
    await context.log(`== ${installer.label} 下載 ==\r\n網址：${installer.url}\r\n存放：${file}\r\n`);
    const failure = await downloadWithRetry(installer, file, context);
    if (signal?.aborted) return aborted();
    if (failure !== undefined) return failed(`下載失敗：${failure.error}（已嘗試 ${failure.attempts} 次）`);
    // 執行前確認簽章：不是預期發行者簽署的檔案一律不執行，也不留下。
    const rejected = await checkSignature(system, file, installer.signer);
    if (rejected !== undefined) {
      await remove();
      return failed(rejected);
    }
  }
  if (signal?.aborted) return aborted();

  const { command, args } = installer.launch(file);
  onProgress?.({ stage: "installing" });
  // 安裝不設逾時（ADR-0008）：卡住時由學生 Abort Install，結束整個程序樹。
  const result = await system.run(command, args, { signal });
  await context.log(runEntry(installer.label, command, args, result));
  if (result.aborted) return aborted(result.output);
  if (result.notFound) return failed("安裝檔無法啟動");
  onProgress?.({ stage: "verifying" });
  // 驗證通過才刪除安裝檔；沒過就保留，重試時重新驗證簽章後沿用。
  const verified = await context.verify().catch((): ToolReadiness => ({ readiness: "missing" }));
  if (verified.readiness === "ready") await remove();
  return {
    output: result.output,
    exitCode: result.exitCode,
    exitAccepted: result.exitCode !== undefined && ACCEPTED_EXIT.includes(result.exitCode),
    ...(result.exitCode === REBOOT_REQUIRED ? { rebootRequired: true } : {}),
    verified,
  };
}

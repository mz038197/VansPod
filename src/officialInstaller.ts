import fs from "node:fs/promises";
import path from "node:path";
import type { EnvironmentInstallReport, EnvironmentInstallResult } from "./classroomApp";
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
  /** 安裝程式結束後驗證工具；通過才刪除安裝檔，否則保留給重試沿用。 */
  verify(): Promise<boolean>;
};

/** 安裝程式的結束碼：0 成功、3010 需要重新開機（Inno Setup 與 msiexec 相同）；成敗仍以驗證為準。 */
const REBOOT_REQUIRED = 3010;
const ACCEPTED_EXIT = [0, REBOOT_REQUIRED];

export function runEntry(label: string, command: string, args: string[], result: RunResult): string {
  const quote = (value: string) => (/[\s"]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value);
  const outcome = result.aborted ? "已中止" : result.notFound ? "無法啟動" : `${result.exitCode ?? "未知"}`;
  return [`== ${label} ==`, `指令：${[command, ...args].map(quote).join(" ")}`, `結束碼：${outcome}`, "輸出：", result.output.trimEnd(), ""].join("\r\n");
}

/**
 * 直接下載官方安裝檔並靜默安裝（ADR-0011）：串流下載到下載快取並回報進度，執行前確認簽章，
 * 結束後驗證工具，驗證通過才刪除安裝檔。
 */
export async function installOfficialInstaller(installer: OfficialInstaller, context: OfficialInstallContext): Promise<EnvironmentInstallResult> {
  const { system, signal, onProgress } = context;
  const file = path.join(context.cacheFolder, installer.fileName);
  await fs.mkdir(context.cacheFolder, { recursive: true });
  await context.log(`== ${installer.label} 下載 ==\r\n網址：${installer.url}\r\n存放：${file}\r\n`);
  await system.download(installer.url, file, {
    signal,
    onProgress: (downloaded, total) => onProgress?.({ stage: "downloading", downloaded, ...(total === undefined ? {} : { total }) }),
  });
  const { command, args } = installer.launch(file);
  onProgress?.({ stage: "installing" });
  // 安裝不設逾時（ADR-0008）：卡住時由學生 Abort Install，結束整個程序樹。
  const result = await system.run(command, args, { signal });
  await context.log(runEntry(installer.label, command, args, result));
  onProgress?.({ stage: "verifying" });
  if (await context.verify()) await fs.rm(file, { force: true });
  return {
    output: result.output,
    exitCode: result.exitCode,
    exitAccepted: result.exitCode !== undefined && ACCEPTED_EXIT.includes(result.exitCode),
    ...(result.exitCode === REBOOT_REQUIRED ? { rebootRequired: true } : {}),
  };
}

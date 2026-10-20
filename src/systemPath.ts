import { execFile } from "node:child_process";
import path from "node:path";

/** 登錄檔裡 Machine 與 User 的 PATH，已展開變數；讀不到時回傳空陣列，沿用目前的 PATH。 */
export function readSystemPath(): Promise<string[]> {
  // 走 PowerShell 而不是 reg.exe：reg.exe 以系統字碼頁輸出，中文使用者資料夾會變成亂碼。
  const script = "[Console]::OutputEncoding = [Text.Encoding]::UTF8; [Environment]::GetEnvironmentVariable('Path', 'Machine'); [Environment]::GetEnvironmentVariable('Path', 'User')";
  // 用完整路徑：要修的正是可能過時的 PATH。
  const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return new Promise(resolve => {
    execFile(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout: 8000, windowsHide: true }, (error, stdout) => {
      resolve(error ? [] : stdout.split(/[;\r\n]+/).map(entry => entry.trim()).filter(Boolean));
    });
  });
}

/** 同時發出的呼叫共用同一次執行；執行結束後的下一次呼叫會重新執行，剛裝好的工具仍找得到。 */
export function sharedWhileRunning<T>(run: () => Promise<T>): () => Promise<T> {
  let running: Promise<T> | undefined;
  return () => running ??= run().finally(() => { running = undefined; });
}

// 啟動時客戶端偵測與開發工具檢查會同時要 PATH；共用一個 PowerShell，避免一次開很多個拖慢啟動。
const readSharedSystemPath = sharedWhileRunning(readSystemPath);

/** 子程序要用的環境：Windows 上補進登錄檔裡最新的 PATH（同時的呼叫共用一次 PowerShell）。 */
export async function envWithRegistryPath(): Promise<NodeJS.ProcessEnv> {
  return process.platform === "win32" ? withSystemPath(process.env, await readSharedSystemPath()) : process.env;
}

/**
 * 安裝程式（例如 winget 裝 Node.js）只改登錄檔裡的 PATH；已經在執行的背景服務還留著啟動時的舊 PATH。
 * 保留舊 PATH 的順序，把登錄檔裡多出來的資料夾補在後面，剛裝好的工具不必重新啟動 VansPod 就找得到。
 */
export function withSystemPath(env: NodeJS.ProcessEnv, systemPath: readonly string[]): NodeJS.ProcessEnv {
  const key = Object.keys(env).find(name => name.toUpperCase() === "PATH") ?? "Path";
  const lookup = new Map(Object.entries(env).map(([name, value]) => [name.toUpperCase(), value]));
  const expand = (entry: string) => entry.replace(/%([^%]+)%/g, (whole, name: string) => lookup.get(name.toUpperCase()) ?? whole);
  const normalize = (entry: string) => entry.replace(/[\\/]+$/, "").toLowerCase();
  const entries = (env[key] ?? "").split(";").filter(Boolean);
  const seen = new Set(entries.map(normalize));
  for (const entry of systemPath.map(expand)) {
    if (!entry || seen.has(normalize(entry))) continue;
    seen.add(normalize(entry));
    entries.push(entry);
  }
  return { ...env, [key]: entries.join(";") };
}

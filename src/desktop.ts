import { spawn } from "node:child_process";
import { isSea, getAsset } from "node:sea";
import fs from "node:fs/promises";
import path from "node:path";

export function openBrowser(url: string): void {
  if (process.env.CLASSROOM_APP_HEADLESS === "1") return;
  const child = process.platform === "win32"
    ? spawn("cmd.exe", ["/d", "/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true })
    : spawn("open", [url], { detached: true, stdio: "ignore" });
  child.on("error", () => process.stderr.write("請用瀏覽器開啟顯示的本機網址。\n"));
  child.unref();
}

export function asset(name: string): Promise<Buffer> {
  return isSea()
    ? Promise.resolve(Buffer.from(getAsset(name)))
    : fs.readFile(path.join(__dirname, "..", name.startsWith("brand-") || name.startsWith("fadou-superhero") ? "media" : "scripts", name));
}

/** 把內嵌的 PowerShell 工具寫到磁碟；Windows PowerShell 5.1 需要 BOM 才會以 UTF-8 讀中文。 */
export async function writeTool(file: string, name: string): Promise<void> {
  await fs.writeFile(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), await asset(name)]));
}

/** 啟動一個在 VansPod 結束後仍會繼續執行的 PowerShell 工具，等它寫出 ready 檔才返回。 */
export async function startHiddenTool(script: string, plan: string, ready: string, name: string): Promise<void> {
  await fs.rm(ready, { force: true });
  // Start-Process gives the helper its own hidden console. A PowerShell child
  // attached to the worker's console would die when that worker exits.
  const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const command = `Start-Process -FilePath powershell.exe -WindowStyle Hidden -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ${literal(`"${script}"`)}, '-Plan', ${literal(`"${plan}"`)})`;
  const child = spawn("powershell.exe", ["-NoProfile", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")], { windowsHide: true, stdio: "ignore" });
  await new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("exit", code => code === 0 ? resolve() : reject(new Error(`無法啟動${name}。`))); });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await fs.stat(ready).catch(() => undefined)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`${name}未回應，請重試。`);
}

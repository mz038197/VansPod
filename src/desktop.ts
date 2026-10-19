import { createHash } from "node:crypto";
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

/** 內嵌資產寫到磁碟時的內容；Windows PowerShell 5.1 需要 BOM 才會以 UTF-8 讀中文。 */
async function assetBytes(name: string): Promise<Buffer> {
  const bytes = await asset(name);
  return name.endsWith(".ps1") ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]) : bytes;
}

/** 把內嵌的 PowerShell 工具寫到指定位置。 */
export async function writeTool(file: string, name: string): Promise<void> {
  await fs.writeFile(file, await assetBytes(name));
}

/**
 * 把內嵌資產寫到 directory，檔名帶內容雜湊；同名檔已存在就直接沿用。
 * 檔案總管的縮圖程序（COM Surrogate）會把 .ico 對應進記憶體，之後這個檔案就無法覆寫。
 */
export async function materializeAsset(directory: string, name: string): Promise<string> {
  const bytes = await assetBytes(name);
  const extension = path.extname(name);
  const file = path.join(directory, `${path.basename(name, extension)}-${createHash("sha256").update(bytes).digest("hex").slice(0, 12)}${extension}`);
  if (await fs.stat(file).catch(() => undefined)) return file;
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, bytes);
  try { await fs.rename(temporary, file); }
  catch (error) {
    await fs.rm(temporary, { force: true });
    // 另一個 VansPod 剛好同時寫好了同一份內容。
    if (!await fs.stat(file).catch(() => undefined)) throw error;
  }
  return file;
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

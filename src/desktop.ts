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
    : fs.readFile(path.join(__dirname, "..", name.startsWith("brand-") ? "media" : "scripts", name));
}

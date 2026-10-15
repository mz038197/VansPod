import { spawn } from "node:child_process";
import path from "node:path";

// clip.exe starts in ~25ms versus ~700ms for PowerShell, and reads UTF-16LE input without a BOM
// as Unicode. It normalizes LF to CRLF, which Windows editors and terminals expect anyway.
const CLIP = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "clip.exe");

export function writeClipboard(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(CLIP, [], { stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
    let failed = false;
    child.on("error", () => {
      failed = true;
      reject(new Error("clipboard failed"));
    });
    child.stderr.on("data", () => {
      failed = true;
    });
    child.on("close", (code) => {
      if (!failed && code === 0) {
        resolve();
        return;
      }
      reject(new Error("clipboard failed"));
    });
    child.stdin.end(Buffer.from(text, "utf16le"));
  });
}

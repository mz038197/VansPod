import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import type { AdapterClient } from "./adapters";
import { envWithRegistryPath } from "./systemPath";

async function succeeds(command: string, args: string[]): Promise<boolean> {
  const env = await envWithRegistryPath();
  return new Promise(resolve => {
    execFile(command, args, { env, timeout: 8000, windowsHide: true, maxBuffer: 64 * 1024 }, error => resolve(!error));
  });
}

/** Detect a usable CLI, or a running/installed Codex desktop app; no model API call. */
export async function detectClient(client: AdapterClient | "vsCodeChat"): Promise<boolean> {
  const cli = client === "codex" ? "codex" : client === "claude" ? "claude" : "code";
  const cliFound = process.platform === "win32"
    ? await succeeds("cmd.exe", ["/d", "/s", "/c", `${cli} --version`])
    : await succeeds(cli, ["--version"]);
  if (cliFound || client !== "codex") return cliFound;
  if (process.platform === "win32") {
    return succeeds("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "if ((Get-Process -Name Codex -ErrorAction SilentlyContinue) -or (Get-AppxPackage -Name '*Codex*' -ErrorAction SilentlyContinue)) { exit 0 } else { exit 1 }"]);
  }
  if (process.platform === "darwin") {
    try { return (await fs.stat("/Applications/Codex.app")).isDirectory(); } catch { return false; }
  }
  return false;
}

import { spawn, type ChildProcess } from "node:child_process";

export type CommandResult = { output: string; exitCode: number | undefined; aborted?: boolean };

const ABORTED_NOTICE = "\n已中止。\n";
const ABORT_GRACE_MS = 5000;

export function collectOutput(
  command: string,
  args: string[],
  cwd?: string,
  onOutput?: (output: string) => void,
  signal?: AbortSignal,
): Promise<{ exitCode: number | undefined; output: string; spawnError: boolean; aborted: boolean }> {
  return new Promise((resolve) => {
    let settled = false;
    let aborted = false;
    const finish = (result: {
      exitCode: number | undefined;
      output: string;
      spawnError: boolean;
    }) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      resolve({ ...result, aborted });
    };
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
      windowsHide: process.platform === "win32",
      // A process group lets abort reach grandchildren such as servers started by uv.
      detached: process.platform !== "win32",
      // cmd.exe parses the complete command itself; Node's CRT escaping would
      // turn embedded quotes into literal characters passed to tools like uv.
      windowsVerbatimArguments: process.platform === "win32" && command === "cmd.exe",
    });
    const abort = () => {
      if (settled || aborted) return;
      aborted = true;
      // An escaped descendant may hold the output pipe open, so an aborted
      // command ends when its own process exits rather than on "close".
      const abandon = () => finish({
        exitCode: child.exitCode ?? undefined, output: Buffer.concat(chunks).toString("utf8"), spawnError: false,
      });
      if (child.exitCode !== null || child.signalCode !== null) { abandon(); return; }
      child.once("exit", abandon);
      setTimeout(() => { child.kill(); abandon(); }, ABORT_GRACE_MS).unref();
      killTree(child);
    };
    const chunks: Buffer[] = [];
    const receive = (chunk: Buffer) => {
      chunks.push(chunk);
      onOutput?.(Buffer.concat(chunks).toString("utf8"));
    };
    child.stdout?.on("data", receive);
    child.stderr?.on("data", receive);
    child.on("error", () => finish({
      exitCode: 1, output: Buffer.concat(chunks).toString("utf8"), spawnError: true,
    }));
    child.on("close", (code) => finish({
      exitCode: code ?? undefined, output: Buffer.concat(chunks).toString("utf8"), spawnError: false,
    }));
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true })
      .on("error", () => child.kill())
      .on("exit", (code) => { if (code) child.kill(); });
    return;
  }
  try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
}

export function shellLaunch(command: string): { command: string; args: string[] } {
  if (process.platform === "win32") {
    return { command: "cmd.exe", args: ["/d", "/s", "/c", `"${command}"`] };
  }
  return { command: "sh", args: ["-c", command] };
}

export async function runCommand(
  cwd: string,
  command: string,
  onOutput?: (output: string) => void,
  signal?: AbortSignal,
): Promise<CommandResult> {
  const launch = shellLaunch(command);
  const result = await collectOutput(launch.command, launch.args, cwd, onOutput, signal);
  if (result.aborted) return { output: `${result.output}${ABORTED_NOTICE}`, exitCode: result.exitCode, aborted: true };
  if (result.spawnError) throw new Error("command failed");
  if (result.exitCode !== 0) {
    return { output: `${result.output}\n指令執行失敗（結束碼：${result.exitCode ?? "未知"}）。\n`, exitCode: result.exitCode };
  }
  return { output: result.output, exitCode: result.exitCode };
}

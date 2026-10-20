import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { runCommand } from "../commandRunner";

it("preserves quoted Git dependencies, paths with spaces, and chained commands", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "classroom command runner "));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const script = path.join(root, "argument probe.cjs");
  await fs.writeFile(script, "console.log(JSON.stringify(process.argv.slice(2)));", "utf8");
  const dependency = "peas-agent-tools @ git+https://github.com/mz038197/peas-agent-tools.git";
  const command = `"${process.execPath}" "${script}" "${dependency}" && "${process.execPath}" "${script}" "second step"`;
  const { output, exitCode } = await runCommand(root, command);
  assert.equal(exitCode, 0);
  const lines = output.trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.deepEqual(lines, [[dependency], ["second step"]]);
});

it("shows a failed exit code with the original output and stops subsequent chained steps", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "classroom command failure "));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const failing = path.join(root, "fail.cjs");
  const next = path.join(root, "next.cjs");
  await fs.writeFile(failing, "console.error('dependency failed'); process.exitCode = 7;", "utf8");
  await fs.writeFile(next, "console.log('should not run');", "utf8");
  const { output, exitCode } = await runCommand(root, `"${process.execPath}" "${failing}" && "${process.execPath}" "${next}"`);
  assert.equal(exitCode, 7);
  assert.match(output, /dependency failed/);
  assert.match(output, /指令執行失敗（結束碼：7）/);
  assert.doesNotMatch(output, /should not run/);
});

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

it("aborting a never-ending command ends its whole process tree and reports aborted", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "classroom command abort "));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const pids = path.join(root, "pids.json");
  const server = path.join(root, "server.cjs");
  await fs.writeFile(server, `
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
require("node:fs").writeFileSync(${JSON.stringify(pids)}, JSON.stringify([process.pid, child.pid]));
console.log("serving");
setInterval(() => {}, 1000);
`, "utf8");
  const controller = new AbortController();
  const running = runCommand(root, `"${process.execPath}" "${server}"`, undefined, controller.signal);
  let started: number[] | undefined;
  for (let attempt = 0; attempt < 200 && !started; attempt++) {
    started = await fs.readFile(pids, "utf8").then((text) => JSON.parse(text) as number[], () => undefined);
    if (!started) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(started, "server did not start");
  t.after(() => { for (const pid of started ?? []) try { process.kill(pid); } catch { /* already ended */ } });
  controller.abort();
  const result = await running;
  assert.equal(result.aborted, true);
  assert.match(result.output, /serving/);
  assert.match(result.output, /已中止/);
  for (let attempt = 0; attempt < 100 && started.some(alive); attempt++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(started.filter(alive), []);
});

it("abort still finishes when an escaped descendant keeps the output pipe open", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "classroom command escape "));
  let escaped: number | undefined;
  t.after(async () => {
    try { if (escaped) process.kill(escaped); } catch { /* already ended */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
    await fs.rm(root, { recursive: true, force: true });
  });
  const pidFile = path.join(root, "pid.txt");
  const launcher = path.join(root, "launcher.cjs");
  await fs.writeFile(launcher, `
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "inherit", "inherit"], detached: true });
require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
child.unref();
`, "utf8");
  const controller = new AbortController();
  const running = runCommand(root, `"${process.execPath}" "${launcher}"`, undefined, controller.signal);
  for (let attempt = 0; attempt < 200 && !escaped; attempt++) {
    escaped = await fs.readFile(pidFile, "utf8").then(Number, () => undefined);
    if (!escaped) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(escaped, "descendant did not start");
  await new Promise((resolve) => setTimeout(resolve, 300));
  controller.abort();
  const result = await Promise.race([running, new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 8000))]);
  assert.notEqual(result, "hung");
  assert.equal((result as { aborted?: boolean }).aborted, true);
});

it("does not start the command when the student aborts before it launches", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "classroom command early abort "));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const marker = path.join(root, "ran.txt");
  const controller = new AbortController();
  const running = runCommand(root, `"${process.execPath}" -e "require('fs').writeFileSync(process.argv[1], '')" "${marker}"`, undefined, controller.signal);
  controller.abort();
  const result = await running;
  assert.equal(result.aborted, true);
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(await fs.stat(marker).then(() => true, () => false), false);
});

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { windowsEnvironmentSystem } from "../windowsEnvironmentSystem";

async function trickyFolder(t: { after(fn: () => Promise<void>): void }): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vanspod env "));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const folder = path.join(root, "學生 !O'Neil");
  await fs.mkdir(folder);
  return folder;
}

it("runs a .cmd tool found on PATH inside a folder with Chinese, spaces, ! and '", async (t) => {
  const folder = await trickyFolder(t);
  await fs.writeFile(path.join(folder, "vanspodprobe.cmd"), "@echo off\r\necho 1.2.3 %1\r\n", "utf8");
  const saved = process.env.PATH;
  process.env.PATH = `${folder};${saved ?? ""}`;
  t.after(() => { process.env.PATH = saved; });
  const result = await windowsEnvironmentSystem.run("vanspodprobe", ["--version"], { timeoutMs: 15_000 });
  assert.equal(result.notFound, false);
  assert.equal(result.exitCode, 0);
  assert.equal(result.output.trim(), "1.2.3 --version");
});

it("passes arguments to an .exe tool unchanged", async () => {
  const result = await windowsEnvironmentSystem.run(process.execPath, ["-p", "Boolean(process.release.lts)"], { timeoutMs: 15_000 });
  assert.equal(result.exitCode, 0);
  assert.equal(result.output.trim(), String(Boolean(process.release.lts)));
});

it("reports a command that is not on PATH as not found", async () => {
  const result = await windowsEnvironmentSystem.run("vanspod-no-such-tool-xyz", ["--version"]);
  assert.equal(result.notFound, true);
});

it("ends a hung check after the timeout and reports it as timed out", async (t) => {
  const folder = await trickyFolder(t);
  const script = path.join(folder, "hang.cjs");
  await fs.writeFile(script, "setInterval(() => {}, 1000);", "utf8");
  const started = Date.now();
  const result = await windowsEnvironmentSystem.run(process.execPath, [script], { timeoutMs: 500 });
  assert.equal(result.timedOut, true);
  assert.equal(result.aborted, false);
  assert.ok(Date.now() - started < 10_000);
});

it("reads the Authenticode signature of a signed file", async () => {
  const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const signature = await windowsEnvironmentSystem.signature(powershell);
  assert.equal(signature.status, "Valid");
  assert.match(signature.subject, /O=Microsoft Corporation/);
});

it("streams a download to the destination with progress and leaves no partial file on abort", async (t) => {
  const folder = await trickyFolder(t);
  const body = Buffer.alloc(64 * 1024, 7);
  const server = http.createServer((req, res) => {
    if (req.url === "/hang") { res.writeHead(200, { "Content-Length": String(body.length * 2) }); res.write(body); return; }
    res.writeHead(200, { "Content-Length": String(body.length) });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const destination = path.join(folder, "setup.exe");
  const progress: Array<[number, number | undefined]> = [];
  await windowsEnvironmentSystem.download(`${base}/file`, destination, { onProgress: (received, total) => progress.push([received, total]) });
  assert.deepEqual(await fs.readFile(destination), body);
  assert.deepEqual(progress.at(-1), [body.length, body.length]);
  const controller = new AbortController();
  const partial = path.join(folder, "partial.exe");
  const downloading = windowsEnvironmentSystem.download(`${base}/hang`, partial, {
    signal: controller.signal,
    onProgress: () => controller.abort(),
  });
  await assert.rejects(downloading);
  await assert.rejects(fs.stat(partial));
});

it("reports Abort Install as aborted, not timed out", async (t) => {
  const folder = await trickyFolder(t);
  const script = path.join(folder, "hang.cjs");
  await fs.writeFile(script, "setInterval(() => {}, 1000);", "utf8");
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 300);
  const result = await windowsEnvironmentSystem.run(process.execPath, [script], { signal: controller.signal });
  assert.equal(result.aborted, true);
  assert.equal(result.timedOut, false);
});

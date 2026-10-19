import { strict as assert } from "node:assert";
import { test } from "node:test";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const { freeBasePort }: { freeBasePort(): Promise<number> } = require("../../scripts/test-ports.cjs");
const execute = promisify(execFile);
const entry = path.join(__dirname, "..", "entry.js");

type UpdateStatus = { current: string; latest?: string; available: boolean; source: string; block?: string; action?: string; checkError?: string; phase: string; lastResult?: { ok: boolean; target: string; message?: string } };

/** 假的 npm registry：回應目前設定的 latest；undefined 表示 registry 掛了。 */
async function fakeRegistry() {
  const registry = { latest: "9.9.9" as string | undefined };
  const server = http.createServer((_req, res) => {
    if (!registry.latest) { res.writeHead(503); res.end(); return; }
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ name: "vanspod", version: registry.latest }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { registry, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/vanspod/latest`, close: () => new Promise(resolve => server.close(resolve)) };
}

/** 啟動一個 headless VansPod，回傳帶授權的管理 API。 */
async function startVansPod(t: { after(fn: () => Promise<void>): void }, extraEnv: Record<string, string>) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "vanspod-update-"));
  const env = { ...process.env, USERPROFILE: home, HOME: home, APPDATA: path.join(home, "roaming"), LOCALAPPDATA: path.join(home, "local"), CLASSROOM_APP_HEADLESS: "1", CLASSROOM_APP_PORT: String(await freeBasePort()), ...extraEnv };
  t.after(async () => {
    await execute(process.execPath, [entry, "stop"], { env, timeout: 20000 }).catch(() => undefined);
    await fs.rm(home, { recursive: true, force: true });
  });
  const management = () => path.join(home, "local", "VansPod");
  await fs.mkdir(management(), { recursive: true });
  const start = () => execute(process.execPath, [entry, "start"], { env, timeout: 20000 });
  const runtime = async () => JSON.parse(await fs.readFile(path.join(management(), "runtime", "instance.json"), "utf8")) as { origin: string; token: string };
  const call = async <T>(action: string, body?: object): Promise<T> => {
    const { origin, token } = await runtime();
    const response = await fetch(`${origin}/_vanspod/${action}`, { method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
    assert.equal(response.status, 200);
    return await response.json() as T;
  };
  return { home, management, start, call };
}

test("pressing the update button checks npm for a newer version; a source checkout is offered nothing to run", async t => {
  const registry = await fakeRegistry();
  t.after(registry.close);
  const vanspod = await startVansPod(t, { VANSPOD_UPDATE_REGISTRY: registry.url });
  await vanspod.start();

  const fresh = await vanspod.call<UpdateStatus>("update?refresh=1");
  assert.equal(fresh.latest, "9.9.9");
  assert.equal(fresh.available, true);
  assert.equal(fresh.source, "source");
  assert.match(fresh.block ?? "", /原始碼/);
  assert.equal(fresh.phase, "idle");

  const refused = await vanspod.call<{ ok: boolean; message?: string }>("update", {});
  assert.equal(refused.ok, false);
  assert.match(refused.message ?? "", /原始碼/);

  registry.registry.latest = undefined;
  const offline = await vanspod.call<UpdateStatus>("update?refresh=1");
  assert.equal(offline.latest, "9.9.9", "a failed check keeps the last known version");
  assert.ok(offline.checkError);
});

/**
 * 在假的 %LOCALAPPDATA% 裡跑更新工具。「exe」只是文字檔，啟動指令是一個 node 腳本：
 * 讀 exe 內容決定扮演哪個版本，寫出 instance.json 後以 0 結束；內容是 broken 時以 1 結束（啟動失敗）；
 * 內容是 unready 時留下一個沒有就緒的背景服務並以 1 結束（啟動逾時）。
 * 工具由 VansPod 的背景 worker 啟動，所以環境裡帶著那個 worker 的 VANSPOD_WORKER_TOKEN。
 */
async function runUpdateTool(t: { after(fn: () => Promise<void>): void }, setup: { exe?: { old: string; downloaded?: string }; npm?: { installExit: number; installs?: string } }) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "vanspod-update-tool-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const local = path.join(home, "local");
  const root = path.join(local, "VansPod");
  const folder = path.join(home, "Documents", "VansPod");
  await fs.mkdir(path.join(root, "runtime"), { recursive: true });
  await fs.mkdir(folder, { recursive: true });
  const file = path.join(folder, "VansPod.exe");
  const starter = path.join(home, "fake-start.js");
  const started = path.join(home, "started.log");
  await fs.writeFile(starter, `
    const fs = require("node:fs"), path = require("node:path");
    const [file, root, log] = process.argv.slice(2);
    const content = fs.readFileSync(file, "utf8").trim();
    fs.appendFileSync(log, content + "|" + process.env.VANSPOD_RESTART + "\\n");
    // 跟真的 launcher 一樣：帶著舊 worker 的 token 啟動會被拒絕。
    if (content === "broken" || process.env.VANSPOD_WORKER_TOKEN) process.exit(1);
    const version = content.split(" ")[1];
    if (content.startsWith("unready")) {
      const stray = require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { detached: true, stdio: "ignore", windowsHide: true });
      stray.unref();
      fs.appendFileSync(path.join(path.dirname(log), "stray.pid"), stray.pid + "\\n");
      fs.writeFileSync(path.join(root, "runtime", "instance.json"), JSON.stringify({ pid: stray.pid, version }));
      process.exit(1);
    }
    fs.writeFileSync(path.join(root, "runtime", "instance.json"), JSON.stringify({ pid: process.pid, version }));
  `);
  const worker = spawn(process.execPath, ["-e", "setTimeout(() => {}, 1500)"], { stdio: "ignore", windowsHide: true });
  await new Promise<void>((resolve, reject) => { worker.once("spawn", resolve); worker.once("error", reject); });
  let plan: object;
  if (setup.exe) {
    await fs.writeFile(file, setup.exe.old);
    if (setup.exe.downloaded !== undefined) await fs.writeFile(`${file}.new`, setup.exe.downloaded);
    plan = { installation: { kind: "exe", file, sha256: "0".repeat(64) }, download: `${file}.new`, start: { file: process.execPath, args: [starter, file, root, started] } };
  } else {
    // 假的 npm-cli：記下參數；成功時把「套件」換成新版。
    const npmCli = path.join(home, "npm-cli.js");
    await fs.writeFile(file, "vanspod 0.2.0");
    await fs.writeFile(npmCli, `require("node:fs").appendFileSync(${JSON.stringify(path.join(home, "npm.log"))}, process.argv.slice(2).join(" ") + "\\n"); if (${setup.npm!.installExit} === 0) require("node:fs").writeFileSync(${JSON.stringify(file)}, ${JSON.stringify(setup.npm!.installs ?? "vanspod 0.3.0")}); process.exit(${setup.npm!.installExit});`);
    plan = { installation: { kind: "npm", root: folder, prefix: home, node: process.execPath, npmCli }, start: { file: process.execPath, args: [starter, file, root, started] } };
  }
  await fs.writeFile(path.join(root, "update-plan.json"), JSON.stringify({ version: 1, root, pid: worker.pid, from: "0.2.0", target: "0.3.0", headless: true, ...plan }));
  const tool = path.join(root, "update-tool.ps1");
  await fs.writeFile(tool, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), await fs.readFile(path.join(__dirname, "..", "..", "scripts", "update.ps1"))]));
  const helper = await execute("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", tool], { env: { ...process.env, USERPROFILE: home, LOCALAPPDATA: local, VANSPOD_WORKER_TOKEN: "a".repeat(64) }, timeout: 60000 }).then(() => 0, (error: { code?: number }) => error.code ?? -1);
  const read = (name: string) => fs.readFile(name, "utf8").catch(() => undefined);
  const strays = ((await read(path.join(home, "stray.pid")))?.trim().split("\n") ?? []).map(Number);
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  t.after(async () => { for (const pid of strays) { try { process.kill(pid); } catch {} } });
  return {
    straysAlive: strays.filter(alive),
    helper, workerGone: worker.exitCode !== null,
    exe: await read(file), old: await read(`${file}.old`), downloaded: await read(`${file}.new`),
    starts: (await read(started))?.trim().split("\n") ?? [],
    npm: (await read(path.join(home, "npm.log")))?.trim(),
    result: JSON.parse((await read(path.join(root, "update-result.json")))?.replace(/^﻿/, "") ?? "null") as { ok: boolean; from: string; target: string; message?: string } | null,
    leftovers: (await fs.readdir(root)).filter(name => name.startsWith("update-")),
  };
}

test("the update tool swaps in the verified exe after VansPod exits and restarts it without a new browser tab", async t => {
  const run = await runUpdateTool(t, { exe: { old: "vanspod 0.2.0", downloaded: "vanspod 0.3.0" } });
  assert.equal(run.helper, 0);
  assert.ok(run.workerGone, "the tool waits for the old VansPod to exit");
  assert.equal(run.exe, "vanspod 0.3.0");
  assert.equal(run.old, undefined, "the old exe is removed once the new one is ready");
  assert.equal(run.downloaded, undefined);
  assert.deepEqual(run.starts, ["vanspod 0.3.0|1"]);
  assert.deepEqual(run.result, { ok: true, from: "0.2.0", target: "0.3.0" });
});

test("when the new exe cannot start, the tool puts the old exe back, restarts it and reports why", async t => {
  const run = await runUpdateTool(t, { exe: { old: "vanspod 0.2.0", downloaded: "broken" } });
  assert.equal(run.helper, 1);
  assert.equal(run.exe, "vanspod 0.2.0");
  assert.equal(run.old, undefined);
  assert.deepEqual(run.starts, ["broken|1", "vanspod 0.2.0|1"]);
  assert.equal(run.result?.ok, false);
  assert.match(run.result?.message ?? "", /0\.3\.0.*換回 v0\.2\.0/);
  assert.deepEqual(run.leftovers, ["update-result.json"], "plan, ready marker and tool are cleaned up");
});

test("npm install failure keeps and restarts the old version and suggests the manual command", async t => {
  const run = await runUpdateTool(t, { npm: { installExit: 1 } });
  assert.equal(run.helper, 1);
  assert.match(run.npm ?? "", /^install --global --prefix .+ vanspod@0\.3\.0$/);
  assert.deepEqual(run.starts, ["vanspod 0.2.0|1"]);
  assert.match(run.result?.message ?? "", /npm install -g vanspod@0\.3\.0/);
});

test("npm install of the exact version, then restart on it", async t => {
  const run = await runUpdateTool(t, { npm: { installExit: 0 } });
  assert.equal(run.helper, 0);
  assert.deepEqual(run.starts, ["vanspod 0.3.0|1"]);
  assert.deepEqual(run.result, { ok: true, from: "0.2.0", target: "0.3.0" });
});

test("the new exe is downloaded next to the old one and kept only when SHA256SUMS matches", async t => {
  const { downloadExe } = await import("../versionUpdate");
  const { createHash } = await import("node:crypto");
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "vanspod-download-"));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const file = path.join(folder, "VansPod.exe");
  const exe = Buffer.alloc(300_000, 7);
  const requested: string[] = [];
  const release = (sums: string): typeof fetch => async input => {
    const url = String(input);
    requested.push(url);
    return url.endsWith("/SHA256SUMS.txt") ? new Response(sums) : new Response(exe, { headers: { "content-length": String(exe.length) } });
  };
  const progress: number[] = [];
  const good = await downloadExe("0.3.0", file, percent => progress.push(percent), release(`${createHash("sha256").update(exe).digest("hex")}  VansPod.exe\n`));
  assert.equal(good, `${file}.new`);
  assert.deepEqual(await fs.readFile(good), exe);
  assert.equal(progress.at(-1), 100);
  assert.ok(requested.every(url => url.startsWith("https://github.com/mz038197/VansPod/releases/download/v0.3.0/")));
  await fs.rm(good);

  await assert.rejects(downloadExe("0.3.0", file, () => {}, release(`${"0".repeat(64)}  VansPod.exe\n`)), /驗證失敗/);
  assert.deepEqual(await fs.readdir(folder), [], "a mismatching download is deleted");
});

test("after the restart the page can read how the last update ended, once", async t => {
  const registry = await fakeRegistry();
  t.after(registry.close);
  const vanspod = await startVansPod(t, { VANSPOD_UPDATE_REGISTRY: registry.url });
  await vanspod.start();
  // 更新工具要等 VansPod 回報就緒後才寫出結果，所以結果檔一定比 VansPod 晚出現。
  assert.equal((await vanspod.call<UpdateStatus>("update")).lastResult, undefined);
  await fs.writeFile(path.join(vanspod.management(), "update-result.json"), "﻿" + JSON.stringify({ ok: false, from: "0.2.0", target: "0.3.0", message: "v0.3.0 無法啟動，已換回 v0.2.0。" }));
  // 背景輪詢或別的分頁不會讀走結果；只有剛重新載入、要顯示結果的頁面會。
  assert.equal((await vanspod.call<UpdateStatus>("update")).lastResult, undefined);
  const first = await vanspod.call<UpdateStatus>("update?result=1");
  assert.deepEqual(first.lastResult, { ok: false, from: "0.2.0", target: "0.3.0", message: "v0.3.0 無法啟動，已換回 v0.2.0。" });
  await assert.rejects(fs.stat(path.join(vanspod.management(), "update-result.json")), "the result file is consumed");
  const second = await vanspod.call<UpdateStatus>("update?result=1");
  assert.equal(second.lastResult, undefined);
});

test("if the new exe cannot be moved into place, the old exe is put back and restarted", async t => {
  const run = await runUpdateTool(t, { exe: { old: "vanspod 0.2.0" } });
  assert.equal(run.helper, 1);
  assert.equal(run.exe, "vanspod 0.2.0", "the student never loses VansPod.exe");
  assert.equal(run.old, undefined);
  assert.deepEqual(run.starts, ["vanspod 0.2.0|1"]);
  assert.equal(run.result?.ok, false);
});

test("a new version that never gets ready is stopped before the old exe goes back", async t => {
  const run = await runUpdateTool(t, { exe: { old: "vanspod 0.2.0", downloaded: "unready 0.3.0" } });
  assert.equal(run.helper, 1);
  assert.equal(run.exe, "vanspod 0.2.0");
  assert.deepEqual(run.straysAlive, [], "the unready new service does not keep running");
});

test("npm: a new version that never gets ready is stopped and the manual command is shown", async t => {
  const run = await runUpdateTool(t, { npm: { installExit: 0, installs: "unready 0.3.0" } });
  assert.equal(run.helper, 1);
  assert.deepEqual(run.straysAlive, []);
  assert.match(run.result?.message ?? "", /npm install -g vanspod@0\.2\.0/);
});

test("versions compare by number, and a prerelease is older than its release", async () => {
  const { compareVersions } = await import("../versionUpdate");
  assert.equal(compareVersions("0.10.0", "0.9.9"), 1, "numeric, not alphabetical");
  assert.equal(compareVersions("0.2.0", "0.2.0"), 0);
  assert.equal(compareVersions("0.2.0", "0.3.0"), -1);
  assert.equal(compareVersions("1.0.0-beta.2", "1.0.0"), -1);
  assert.equal(compareVersions("1.0.0-beta.10", "1.0.0-beta.2"), 1);
});

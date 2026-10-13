import { strict as assert } from "node:assert";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const { freeBasePort }: { freeBasePort(): Promise<number> } = require("../../scripts/test-ports.cjs");
const execute = promisify(execFile);
const entry = path.join(__dirname, "..", "entry.js");
const expectedVersion = JSON.parse(readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8")).version;

test("failed client initialization reports a useful error and leaves no unmanageable worker", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "vanspod-start-failure-"));
  const bin = path.join(home, "bin");
  const env = {...process.env, USERPROFILE: home, HOME: home, APPDATA: path.join(home, "roaming"), LOCALAPPDATA: path.join(home, "local"), PATH: bin + path.delimiter + process.env.PATH, CLASSROOM_APP_HEADLESS: "1", CLASSROOM_APP_PORT: String(await freeBasePort())};
  try {
    await fs.mkdir(bin); await fs.mkdir(path.join(home, ".codex"));
    await fs.writeFile(path.join(bin, "codex.cmd"), "@exit /b 0\r\n");
    await fs.writeFile(path.join(home, ".codex", "classroom-model-backup.json"), "{broken");
    await assert.rejects(execute(process.execPath, [entry, "start"], {env, timeout: 8000}), /初始化失敗|備份/);
    const status = JSON.parse((await execute(process.execPath, [entry, "status", "--json"], {env})).stdout);
    if (status.running) {
      assert.equal(status.ready, false);
      assert.match(status.startupError, /初始化失敗/);
    }
    await fs.rm(path.join(home, ".codex", "classroom-model-backup.json"));
    await execute(process.execPath, [entry, "stop"], {env, timeout: 10000});
  } finally {
    const state = await fs.readFile(path.join(home, "local", "VansPod", "runtime", "instance.json"), "utf8").then(raw => JSON.parse(raw) as {pid: number}).catch(() => undefined);
    if (state) { try { process.kill(state.pid); } catch {} }
    await fs.rm(home, {recursive: true, force: true});
  }
});

test("start returns while one background service survives and repeated starts share it", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "vanspod-background-"));
  const env = { ...process.env, USERPROFILE: home, HOME: home, APPDATA: path.join(home, "roaming"), LOCALAPPDATA: path.join(home, "local"), CLASSROOM_APP_HEADLESS: "1", CLASSROOM_APP_PORT: String(await freeBasePort()) };
  try {
    await Promise.all([execute(process.execPath, [entry, "start"], { env, timeout: 20000 }), execute(process.execPath, [entry, "start"], { env, timeout: 20000 })]);
    const first = JSON.parse((await execute(process.execPath, [entry, "status", "--json"], { env })).stdout);
    assert.equal(first.running, true);
    await execute(process.execPath, [entry, "start"], { env, timeout: 20000 });
    const second = JSON.parse((await execute(process.execPath, [entry, "status", "--json"], { env })).stdout);
    assert.equal(first.pid, second.pid);
    assert.equal(second.version, expectedVersion);
    const response = await fetch(`${second.origin}/`);
    const html = await response.text();
    assert.match(html, /rel="icon"/);
    assert.match(html, /<button[^>]+data-lifecycle="uninstall"/);
    assert.equal((await fetch(`${second.origin}/brand-logo.png`)).status, 200);
    assert.equal((await fetch(`${second.origin}/favicon.ico`)).status, 200);
    assert.equal((await fetch(`${second.origin}/_vanspod/status`)).status, 403);
    const runtime = JSON.parse(await fs.readFile(path.join(home, "local", "VansPod", "runtime", "instance.json"), "utf8"));
    await fetch(`${second.origin}/_vanspod/open`, { method: "POST", headers: {Authorization: `Bearer ${runtime.token}`}, body: JSON.stringify({version: "0.0.9"}) });
    const mismatch = await (await fetch(`${second.origin}/_vanspod/status`, {headers: {Authorization: `Bearer ${runtime.token}`}})).json() as { launchVersion: string; version: string };
    assert.equal(mismatch.version, expectedVersion);
    assert.equal(mismatch.launchVersion, "0.0.9");
    const marker = path.join(home, "local", "VansPod", "uninstall-ready");
    await fs.writeFile(marker, JSON.stringify({pid: process.pid}));
    await assert.rejects(execute(process.execPath, [entry, "start"], {env}), /完整移除中/);
    assert.equal(JSON.parse((await execute(process.execPath, [entry, "status", "--json"], {env})).stdout).pid, first.pid);
    await fs.rm(marker);
    const recordFile = path.join(home, "local", "VansPod", "runtime", "instance.json");
    await fs.writeFile(recordFile, JSON.stringify({...runtime, token: "0".repeat(64)}));
    try { await assert.rejects(execute(process.execPath, [entry, "status", "--json"], {env}), /授權|身分/); }
    finally { await fs.writeFile(recordFile, JSON.stringify(runtime)); }
    const denied = await fetch(`${second.origin}/_vanspod/stop`, { method: "POST", headers: { Authorization: `Bearer ${runtime.token}`, Origin: "https://unrelated.example" }, body: "{}" });
    assert.equal(denied.status, 403);
    await execute(process.execPath, [entry, "stop"], { env, timeout: 20000 });
    const stopped = JSON.parse((await execute(process.execPath, [entry, "status", "--json"], { env })).stdout);
    assert.equal(stopped.running, false);
  } finally {
    await execute(process.execPath, [entry, "stop"], { env }).catch(() => undefined);
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("confirmed full removal clears VansPod data and preserves student projects and tools", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "vanspod-removal-"));
  const env = { ...process.env, USERPROFILE: home, HOME: home, APPDATA: path.join(home, "roaming"), LOCALAPPDATA: path.join(home, "local"), CLASSROOM_APP_HEADLESS: "1", CLASSROOM_APP_PORT: String(await freeBasePort()) };
  try {
    await fs.mkdir(path.join(home, "student-project"));
    await fs.writeFile(path.join(home, "student-project", "main.js"), "student work");
    await execute(process.execPath, [entry, "start"], { env, timeout: 20000 });
    const runtime = JSON.parse(await fs.readFile(path.join(home, "local", "VansPod", "runtime", "instance.json"), "utf8"));
    const request = async (action: string, body?: object) => (await fetch(`${runtime.origin}/_vanspod/${action}`, { method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${runtime.token}` }, body: body ? JSON.stringify(body) : undefined })).json() as Promise<{ ok: boolean; message: string }>;
    await fs.mkdir(path.join(home, "local", "classroom-app"), {recursive: true});
    await fs.writeFile(path.join(home, "local", "classroom-app", "connection.json"), "legacy owned data");
    await fs.writeFile(path.join(home, "local", "classroom-app", "student.txt"), "student work");
    assert.equal((await request("uninstall-preview")).ok, true);
    assert.equal((await request("uninstall", {})).ok, false);
    const removing = await request("uninstall", { confirmed: true });
    const helperOutput = await fs.readFile(path.join(home, "local", "VansPod", "logs", "removal.log"), "utf8").catch(() => "");
    assert.equal(removing.ok, true, removing.message + helperOutput);
    for (let attempt = 0; attempt < 200; attempt++) {
      if (!(await fs.stat(path.join(home, "local", "VansPod")).catch(() => undefined))) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const removalResult = await fs.readFile(path.join(home, "local", "VansPod", "removal-result.json"), "utf8").catch(() => fs.readFile(path.join(home, "local", "VansPod", "logs", "removal.log"), "utf8").catch(() => "No removal result: " + home));
    assert.equal(await fs.stat(path.join(home, ".vanspod")).catch(() => undefined), undefined, removalResult);
    assert.equal(await fs.stat(path.join(home, "local", "VansPod")).catch(() => undefined), undefined, removalResult);
    assert.equal(await fs.readFile(path.join(home, "student-project", "main.js"), "utf8"), "student work");
    assert.equal(await fs.stat(path.join(home, "local", "classroom-app", "connection.json")).catch(() => undefined), undefined);
    assert.equal(await fs.readFile(path.join(home, "local", "classroom-app", "student.txt"), "utf8"), "student work");
  } finally {
    await execute(process.execPath, [entry, "stop"], { env }).catch(() => undefined);
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("version and help work without starting a service or creating student data", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "vanspod-cli-"));
  try {
    const env = { ...process.env, USERPROFILE: home, HOME: home, CLASSROOM_APP_PORT: "invalid-port" };
    const version = await execute(process.execPath, [entry, "--version"], { env });
    assert.equal(version.stdout.trim(), expectedVersion);
    const help = await execute(process.execPath, [entry, "--help"], { env });
    assert.match(help.stdout, /start.*status.*stop.*uninstall/s);
    assert.doesNotMatch(help.stdout, /vanspod open/);
    assert.deepEqual(await fs.readdir(home), []);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

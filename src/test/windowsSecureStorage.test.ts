import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { it } from "node:test";
import { createConnectionStorage } from "../secureStorage";
import { createWindowsSecureStorage, createWindowsDataProtector, protectedFiles, StorageError } from "../windowsSecureStorage";
import { createPersistentConnectionStorage } from "../platformStorage";

const CONNECTION = {
  version: 1 as const, apiKey: "synthetic-classroom-key", session: { class_name: "測試課堂", name: "星期日🙂" },
  nickname: "測試學生", mode: "native" as const,
};

it("Windows storage protects the entire Unicode connection and restores in a new adapter", { skip: process.platform !== "win32" }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "classroom-dpapi-"));
  const file = path.join(root, "connection.json");
  try {
    const first = createConnectionStorage(createWindowsSecureStorage(file));
    assert.deepEqual(await first.setConnection(CONNECTION), { persistence: "persistent" });
    const raw = await fs.readFile(file, "utf8");
    for (const secret of [CONNECTION.apiKey, CONNECTION.nickname, CONNECTION.session.class_name, CONNECTION.session.name]) {
      assert.equal(raw.includes(secret), false);
    }
    const restarted = createConnectionStorage(createWindowsSecureStorage(file));
    assert.deepEqual(await restarted.getConnection(), CONNECTION);
    await restarted.clearConnection();
    assert.equal(await first.getConnection(), undefined);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

it("the process bridge uses stdin and hides child errors, oversized output and timeouts", async () => {
  const input = "synthetic-private-input";
  let executable = "";
  let argumentsSeen: readonly string[] = [];
  const launch: typeof spawn = ((file: string, args: readonly string[], options: Parameters<typeof spawn>[2]) => {
    executable = file;
    argumentsSeen = args;
    return spawn(process.execPath, ["-e", "process.stdin.setEncoding('utf8'); let text=''; process.stdin.on('data',d=>text+=d); process.stdin.on('end',()=>process.stdout.write(text))"], options);
  }) as typeof spawn;
  const bridge = createWindowsDataProtector({ launch });
  assert.equal(await bridge.protect(input), input);
  assert.equal(argumentsSeen.join(" ").includes(input), false);
  assert.equal(path.win32.isAbsolute(executable), true);
  assert.equal(path.win32.basename(executable), "powershell.exe");
  for (const script of [
    "process.stdin.resume(); process.stdin.on('end',()=> { process.stderr.write('synthetic-private-input'); process.exit(1); })",
    "process.stdout.write('x'.repeat(1024)); setInterval(()=>{},1000)",
    "process.stdin.resume(); setInterval(()=>{},1000)",
  ]) {
    const failing = createWindowsDataProtector({
      launch: ((file: string, args: readonly string[], options: Parameters<typeof spawn>[2]) => spawn(process.execPath, ["-e", script], options)) as typeof spawn,
      timeoutMs: 100, maxBytes: 128,
    });
    await assert.rejects(failing.protect(input), error => error instanceof StorageError && !error.message.includes(input));
  }
});

it("failed replacement preserves the old protected record and removes only encrypted temporary data", { skip: process.platform !== "win32" }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "classroom-replace-failure-"));
  const file = path.join(root, "connection.json");
  try {
    const original = createConnectionStorage(createWindowsSecureStorage(file));
    await original.setConnection(CONNECTION);
    const failing = createConnectionStorage(createWindowsSecureStorage(file, { files: { ...protectedFiles, async replace() { throw new Error(CONNECTION.apiKey); } } }));
    await assert.rejects(failing.setConnection({ ...CONNECTION, nickname: "Next" }), error => error instanceof StorageError && !error.message.includes(CONNECTION.apiKey));
    assert.deepEqual(await original.getConnection(), CONNECTION);
    assert.deepEqual(await fs.readdir(root), ["connection.json"]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it("a failed persistent clear refuses memory fallback and retains the previous usable connection", async () => {
  const storage = createPersistentConnectionStorage({
    async getConnection() { return CONNECTION; },
    async setConnection() { throw new Error(CONNECTION.apiKey); },
    async clearConnection() { throw new Error(CONNECTION.apiKey); },
  });
  assert.deepEqual(await storage.getConnection(), CONNECTION);
  await assert.rejects(storage.setConnection({ ...CONNECTION, nickname: "Next" }, { allowTemporary: true }), error => error instanceof StorageError && error.code === "clear-failed" && !error.message.includes(CONNECTION.apiKey));
  assert.deepEqual(await storage.getConnection(), CONNECTION);
});

it("unreadable protected records remain on disk and cannot be used as a connection", { skip: process.platform !== "win32" }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "classroom-invalid-record-"));
  const file = path.join(root, "connection.json");
  try {
    const secure = createWindowsSecureStorage(file);
    await secure.set("classroom-connection", JSON.stringify({ apiKey: CONNECTION.apiKey }));
    const before = await fs.readFile(file, "utf8");
    await assert.rejects(createConnectionStorage(secure).getConnection(), error => error instanceof StorageError && error.code === "unreadable");
    assert.equal(await fs.readFile(file, "utf8"), before);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it("new redeem can use memory after unavailable storage is safely cleared, while mode saves are strict", async () => {
  const persistent = {
    async getConnection() { return undefined; },
    async setConnection() { throw new Error(CONNECTION.apiKey); },
    async clearConnection() {},
  };
  const storage = createPersistentConnectionStorage(persistent);
  await assert.rejects(storage.setConnection(CONNECTION), error => error instanceof Error && !error.message.includes(CONNECTION.apiKey));
  assert.equal(await storage.getConnection(), undefined);
  assert.deepEqual(await storage.setConnection(CONNECTION, { allowTemporary: true }), { persistence: "temporary" });
  assert.deepEqual(await storage.getConnection(), CONNECTION);
});

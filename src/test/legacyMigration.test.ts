import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { createPlatformConnectionStorage } from "../platformStorage";
import { StorageError } from "../storageErrors";
import { createWindowsDataProtector, protectedFiles, type WindowsStorageOptions } from "../windowsSecureStorage";

const LEGACY_KEY = "synthetic-legacy-private-key";

it("startup migrates a key-only legacy file once without inventing identity", { skip: process.platform !== "win32" }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "classroom-legacy-"));
  const file = path.join(root, "connection.json");
  try {
    await fs.writeFile(file, JSON.stringify({ apiKey: LEGACY_KEY }));
    const storage = createPlatformConnectionStorage(file);
    const expected = { version: 1, apiKey: LEGACY_KEY, session: {}, mode: "native" };
    const results = await Promise.all([storage.getConnection(), storage.getConnection(), storage.getConnection()]);
    for (const connection of results) assert.deepEqual(connection, expected);
    assert.equal((await fs.readFile(file, "utf8")).includes(LEGACY_KEY), false);
    assert.deepEqual(await fs.readdir(root), ["connection.json"]);
    assert.deepEqual(await createPlatformConnectionStorage(file).getConnection(), expected);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

for (const phase of ["protect", "verify", "replace"] as const) {
  it(`failed legacy ${phase} removes plaintext and refuses the old credential`, { skip: process.platform !== "win32" }, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "classroom-legacy-failure-"));
    const file = path.join(root, "connection.json");
    try {
      await fs.writeFile(file, JSON.stringify({ apiKey: LEGACY_KEY }));
      const protector = createWindowsDataProtector();
      const options: WindowsStorageOptions = phase === "replace"
        ? { files: { ...protectedFiles, async replace() { throw new Error(LEGACY_KEY); } } }
        : { protector: { ...protector,
            ...(phase === "protect" ? { async protect(): Promise<string> { throw new Error(LEGACY_KEY); } }
              : { async unprotect(): Promise<string> { return "wrong plaintext"; } }),
          } };
      const storage = createPlatformConnectionStorage(file, options);
      await assert.rejects(storage.getConnection(), error => error instanceof StorageError && error.code === "migration-failed" && !error.message.includes(LEGACY_KEY));
      assert.deepEqual(await fs.readdir(root), []);
      await assert.rejects(storage.getConnection(), error => error instanceof StorageError && error.code === "migration-failed");
      assert.equal(await createPlatformConnectionStorage(file).getConnection(), undefined);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
}

it("failed legacy deletion blocks the key and gives controlled manual cleanup guidance", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "classroom-legacy-locked-"));
  const file = path.join(root, "connection.json");
  try {
    const plaintext = JSON.stringify({ apiKey: LEGACY_KEY });
    await fs.writeFile(file, plaintext);
    const storage = createPlatformConnectionStorage(file, {
      platform: "darwin",
      files: { ...protectedFiles, async remove(target) {
        if (target === file) throw new Error(LEGACY_KEY);
        return protectedFiles.remove(target);
      } },
    });
    await assert.rejects(storage.getConnection(), error => error instanceof StorageError && error.code === "legacy-cleanup-failed" && error.message.includes("手動") && !error.message.includes(LEGACY_KEY));
    assert.equal(await fs.readFile(file, "utf8"), plaintext);
    await assert.rejects(storage.getConnection(), error => error instanceof StorageError && error.code === "legacy-cleanup-failed");
    await assert.rejects(storage.setConnection({ version: 1, apiKey: "synthetic-next-key", session: {}, mode: "native" }, { allowTemporary: true }), error => error instanceof StorageError && error.code === "clear-failed");
    assert.equal(await fs.readFile(file, "utf8"), plaintext);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it("unsupported platforms remove legacy plaintext and require a new redeem before using memory", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "classroom-legacy-linux-"));
  const file = path.join(root, "connection.json");
  try {
    await fs.writeFile(file, JSON.stringify({ apiKey: LEGACY_KEY }));
    const storage = createPlatformConnectionStorage(file, { platform: "linux" });
    await assert.rejects(storage.getConnection(), error => error instanceof StorageError && error.code === "migration-failed");
    assert.deepEqual(await fs.readdir(root), []);
    const replacement = { version: 1 as const, apiKey: "synthetic-new-key", session: {}, mode: "native" as const };
    assert.deepEqual(await storage.setConnection(replacement, { allowTemporary: true }), { persistence: "temporary" });
    assert.deepEqual(await storage.getConnection(), replacement);
    assert.equal(await createPlatformConnectionStorage(file, { platform: "linux" }).getConnection(), undefined);
    assert.deepEqual(await fs.readdir(root), []);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

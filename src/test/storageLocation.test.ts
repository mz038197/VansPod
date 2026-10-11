import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { createPlatformConnectionStorage } from "../platformStorage";

const connection = { version: 1 as const, apiKey: "synthetic-location-key", session: { class_name: "Test" }, mode: "native" as const };

for (const scenario of ["encrypted", "plaintext", "existing-target"] as const) {
  it(`relocates ${scenario} credentials to .vanspod and never restores the old file after clearing`, { skip: process.platform !== "win32" }, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "classroom-location-"));
    const legacyFilePath = path.join(root, "local", "classroom-app", "connection.json");
    const target = path.join(root, "home", ".vanspod", "connection.json");
    try {
      if (scenario === "plaintext") {
        await fs.mkdir(path.dirname(legacyFilePath), { recursive: true });
        await fs.writeFile(legacyFilePath, JSON.stringify(connection));
      } else {
        await createPlatformConnectionStorage(legacyFilePath).setConnection(connection);
      }
      const expected = scenario === "existing-target" ? { ...connection, apiKey: "synthetic-newer-key" } : connection;
      if (scenario === "existing-target") await createPlatformConnectionStorage(target).setConnection(expected);
      const storage = createPlatformConnectionStorage(target, { legacyFilePath });
      const restored = await Promise.all([storage.getConnection(), storage.getConnection()]);
      restored.forEach(value => assert.deepEqual(value, expected));
      await assert.rejects(fs.access(legacyFilePath), { code: "ENOENT" });
      const envelope = await fs.readFile(target, "utf8");
      assert.equal(envelope.includes(expected.apiKey), false);
      assert.deepEqual(await createPlatformConnectionStorage(target, { legacyFilePath }).getConnection(), expected);
      await storage.clearConnection();
      await assert.rejects(fs.access(target), { code: "ENOENT" });
      assert.equal(await createPlatformConnectionStorage(target, { legacyFilePath }).getConnection(), undefined);
    } finally {
      const resolved = path.resolve(root);
      assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith("classroom-location-"));
      await fs.rm(resolved, { recursive: true, force: true });
    }
  });
}

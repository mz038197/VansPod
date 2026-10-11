import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAdapterSettingsStorage } from "../adapterSettings";

test("adapter preferences persist independently on disk and reject corrupt settings", async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "vanspod-adapters-"));
  const filename = path.join(folder, "settings.json");
  try {
    const store = createAdapterSettingsStorage(filename);
    assert.deepEqual(await store.load(), { codex: "responses", claude: "responses" });
    await store.save({ codex: "chat", claude: "messages" });
    assert.deepEqual(await createAdapterSettingsStorage(filename).load(), { codex: "chat", claude: "messages" });
    await store.save({ codex: "responses", claude: "chat" });
    assert.deepEqual(await store.load(), { codex: "responses", claude: "chat" });
    assert.deepEqual(await fs.readdir(folder), ["settings.json"]);
    await fs.writeFile(filename, JSON.stringify({ version: 1, adapters: { codex: "messages", claude: "chat" } }));
    await assert.rejects(store.load(), /格式/);
  } finally { await fs.rm(folder, { recursive: true, force: true }); }
});

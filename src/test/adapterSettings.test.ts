import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAdapterSettingsStorage } from "../adapterSettings";
import {
  createClientRouteSettingsStorage,
  defaultClientRoutes,
  isClientRouteAdapter,
  supportedClientRouteAdapters,
} from "../clientRoutes";

test("client routes have independent Native and Responses defaults with route-specific adapters", () => {
  assert.deepEqual(defaultClientRoutes(), {
    codex: { id: "codex", mode: "native", adapter: "responses", health: "gray", restart: "ready" },
    claudeCode: { id: "claudeCode", mode: "native", adapter: "responses", health: "gray", restart: "ready" },
    vsCodeChat: { id: "vsCodeChat", mode: "native", adapter: "responses", health: "gray", restart: "ready" },
  });
  assert.equal(isClientRouteAdapter("codex", "messages"), false);
  assert.equal(isClientRouteAdapter("claudeCode", "messages"), true);
  assert.equal(isClientRouteAdapter("vsCodeChat", "messages"), false);
  assert.deepEqual(supportedClientRouteAdapters("codex"), ["responses", "chat"]);
  assert.deepEqual(supportedClientRouteAdapters("claudeCode"), ["responses", "chat", "messages"]);
  assert.deepEqual(supportedClientRouteAdapters("vsCodeChat"), ["responses", "chat"]);
});

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
    assert.deepEqual(JSON.parse(await fs.readFile(filename, "utf8")), {
      version: 2,
      routes: {
        codex: { mode: "native", adapter: "responses" },
        claudeCode: { mode: "native", adapter: "chat" },
        vsCodeChat: { mode: "native", adapter: "responses" },
      },
    });
    assert.deepEqual(await fs.readdir(folder), ["settings.json"]);
    await fs.writeFile(filename, JSON.stringify({ version: 1, adapters: { codex: "messages", claude: "chat" } }));
    await assert.rejects(store.load(), /格式/);
  } finally { await fs.rm(folder, { recursive: true, force: true }); }
});

test("legacy adapter settings migrate to independent Native client routes", async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "vanspod-client-routes-"));
  const filename = path.join(folder, "settings.json");
  try {
    await fs.writeFile(filename, JSON.stringify({
      version: 1,
      adapters: { codex: "chat", claude: "messages" },
    }));

    const routes = await createClientRouteSettingsStorage(filename).load();

    assert.deepEqual(routes, {
      codex: { mode: "native", adapter: "chat" },
      claudeCode: { mode: "native", adapter: "messages" },
      vsCodeChat: { mode: "native", adapter: "responses" },
    });
  } finally { await fs.rm(folder, { recursive: true, force: true }); }
});

test("versioned client route settings persist each route independently", async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "vanspod-client-routes-"));
  const filename = path.join(folder, "settings.json");
  try {
    const store = createClientRouteSettingsStorage(filename);
    await store.save({
      codex: { mode: "classroom", adapter: "chat" },
      claudeCode: { mode: "native", adapter: "messages" },
      vsCodeChat: { mode: "classroom", adapter: "chat" },
    });

    assert.deepEqual(await createClientRouteSettingsStorage(filename).load(), {
      codex: { mode: "classroom", adapter: "chat" },
      claudeCode: { mode: "native", adapter: "messages" },
      vsCodeChat: { mode: "classroom", adapter: "chat" },
    });
    assert.equal(JSON.parse(await fs.readFile(filename, "utf8")).version, 2);
  } finally { await fs.rm(folder, { recursive: true, force: true }); }
});

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { renderPage } from "../page";
import { createPersistentConnectionStorage } from "../platformStorage";
import { createConnectionStorage, createMemorySecureStorage, type ConnectionStorage } from "../secureStorage";
import { createRouteFiles, type CodexRouteOptions } from "../routeFiles";
import type { AdapterSettingsStorage } from "../adapterSettings";
import type { ClientRouteSettingsStorage } from "../clientRoutes";
import type { ClientRouteRuntime, ClientRouteStart } from "../clientRouteRuntime";
import type { VsCodeRouteSettings } from "../vsCodeRouteSettings";
import {
  ClassroomApp,
  type EnvironmentToolId,
  type UpstreamSend,
} from "../classroomApp";

type ModelOptions = {
  ids: string[];
  codexModel: string;
  claudeModel: string;
  proxyBaseUrl: string;
  clients?: { codex: boolean; claude: boolean };
  updateClient?: "codex" | "claude";
};

const KEY = "vcr_sk_nick";
const PROXY = "http://127.0.0.1:47821";

function persistentStorageFake(): ConnectionStorage {
  const records = createConnectionStorage(createMemorySecureStorage());
  return {
    getConnection: () => records.getConnection(),
    clearConnection: () => records.clearConnection(),
    async setConnection(connection) {
      await records.setConnection(connection);
      return { persistence: "persistent" };
    },
  };
}

it("a committed replacement keeps the new identity and key when Native route restoration fails", async () => {
  const disk = persistentStorageFake();
  await disk.setConnection({ version: 1, apiKey: "old-key", session: { class_name: "Old" }, nickname: "Old student", mode: "native" });
  let failRoutes = false;
  const h = harness(undefined, {
    storage: createPersistentConnectionStorage(disk),
    async setModelOptions() { if (failRoutes) throw new Error(`route failed ${KEY}`); },
  });
  await h.app.start();
  await h.app.setSwitch("classroom");
  failRoutes = true;
  await assert.doesNotReject(h.app.redeem("NEW", "New student"));
  assert.equal(h.app.view().classLabel, "Demo · Week 1");
  assert.equal(h.app.view().nickname, "New student");
  assert.equal(h.app.view().mode, "native");
  assert.equal(h.app.view().catalog, undefined);
  assert.match(h.app.view().notice ?? "", /模型設定/);
  assert.doesNotMatch(renderPage(h.app.view()), /old-key|vcr_sk_nick/);
  await h.app.copyKey();
  assert.equal(h.clipboard(), KEY);
  await h.app.forward({ client: "codex", model: "later" });
  assert.equal(h.sent()[0]?.target, "chatgpt");
  await assert.rejects(h.app.forward({ client: "copilot", model: "later" }), /沒有上課模型/);
  const restarted = harness(undefined, { storage: createPersistentConnectionStorage(disk) });
  await restarted.app.start();
  assert.equal(restarted.app.view().nickname, "New student");
  await restarted.app.copyKey();
  assert.equal(restarted.clipboard(), KEY);
});

it("a new session stays safely Native when publishing its Classroom model options fails", async () => {
  const disk = persistentStorageFake();
  await disk.setConnection({ version: 1, apiKey: "old-key", session: { class_name: "Old" }, mode: "native" });
  let failPublish = false;
  const h = harness(undefined, {
    storage: createPersistentConnectionStorage(disk),
    async setModelOptions(value) { if (failPublish && value) throw new Error(KEY); },
  });
  await h.app.start();
  await h.app.setSwitch("classroom");
  failPublish = true;
  await assert.doesNotReject(h.app.redeem("NEW", "New student"));
  assert.equal(h.app.view().classLabel, "Demo · Week 1");
  assert.equal(h.app.view().nickname, "New student");
  assert.equal(h.app.view().mode, "native");
  assert.match(h.app.view().notice ?? "", /模型設定/);
  assert.doesNotMatch(renderPage(h.app.view()), /old-key|vcr_sk_nick/);
  await h.app.forward({ client: "codex", model: "later" });
  assert.equal(h.sent()[0]?.target, "chatgpt");
  await assert.rejects(h.app.forward({ client: "copilot", model: "later" }), /沒有上課模型/);
  await h.app.copyKey();
  assert.equal(h.clipboard(), KEY);
});

it("clear during startup waits for restoration and leaves both memory and persistent storage empty", async () => {
  const disk = persistentStorageFake();
  await disk.setConnection({ version: 1, apiKey: "old-key", session: { class_name: "Old" }, mode: "native" });
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const h = harness(undefined, { storage: {
    async getConnection() {
      const snapshot = await disk.getConnection();
      entered();
      await gate;
      return snapshot;
    },
    setConnection: connection => disk.setConnection(connection),
    clearConnection: () => disk.clearConnection(),
  } });
  const start = h.app.start();
  await started;
  const clear = h.app.clearConnection();
  release();
  await Promise.all([start, clear]);
  assert.equal(h.app.view().connected, false);
  assert.equal(await disk.getConnection(), undefined);
  await h.app.start();
  assert.equal(h.app.view().connected, false);
});

it("a request arriving during replacement is validated against the new allowlist", async () => {
  const disk = persistentStorageFake();
  await disk.setConnection({ version: 1, apiKey: "old-key", session: { class_name: "Old" }, mode: "native" });
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const h = harness(undefined, {
    storage: {
      getConnection: () => disk.getConnection(),
      clearConnection: () => disk.clearConnection(),
      async setConnection(connection) {
        const result = await disk.setConnection(connection);
        if (connection.apiKey === KEY) { entered(); await gate; }
        return result;
      },
    },
    sessionModels: async key => key === KEY ? ["new-only-model"] : ["old-only-model"],
  });
  await h.app.start();
  await h.app.setSwitch("classroom");
  const redeem = h.app.redeem("NEW", "New student");
  await started;
  const forward = h.app.forward({ client: "codex", model: "old-only-model" });
  release();
  await redeem;
  await assert.rejects(forward, /old-only-model.*不在課堂允許清單/);
  assert.deepEqual(h.sent(), []);
});

it("an in-flight Router response does not block clear or authorize later requests", async () => {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const sending = new Promise<void>(resolve => { entered = resolve; });
  const h = harness(undefined, { send: async () => { entered(); await gate; } });
  await h.app.redeem("NEW", "New student");
  await h.app.start();
  await h.app.setSwitch("classroom");
  const forward = h.app.forward({ client: "codex", model: "later" });
  await sending;
  const clear = h.app.clearConnection();
  try {
    assert.equal(await Promise.race([clear.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 100))]), true);
    await assert.rejects(h.app.forward({ client: "copilot", model: "later" }), /沒有上課模型/);
  } finally {
    release();
    await Promise.all([forward, clear]);
  }
  assert.equal(h.sent().length, 1);
});

it("clear requested during a redeem runs after its commit and cannot leave a resurrected class", async () => {
  const memory = createConnectionStorage(createMemorySecureStorage());
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const h = harness(undefined, { storage: {
    getConnection: () => memory.getConnection(),
    clearConnection: () => memory.clearConnection(),
    async setConnection(connection) {
      entered();
      await gate;
      return memory.setConnection(connection);
    },
  } });
  const redeem = h.app.redeem("NEW", "New student");
  await started;
  const clear = h.app.clearConnection();
  release();
  await Promise.all([redeem, clear]);
  assert.equal(h.app.view().connected, false);
  assert.equal(h.app.view().mode, "native");
  assert.equal(await memory.getConnection(), undefined);
});

it("committed replacement never reuses the old allowlist or catalog while the new Router is offline", async () => {
  const disk = persistentStorageFake();
  await disk.setConnection({ version: 1, apiKey: "old-key", session: { class_name: "Old" }, mode: "native" });
  const h = harness(undefined, {
    storage: createPersistentConnectionStorage(disk),
    sessionModels: async key => {
      if (key === KEY) throw new Error("offline");
      return ["old-only-model"];
    },
    catalogFetch: async key => {
      if (key === KEY) throw new Error("offline");
      return { course_catalog_yaml: REMOTE_YAML };
    },
  });
  await h.app.start();
  await h.app.setSwitch("classroom");
  await h.app.redeem("NEW", "New student");
  assert.equal(h.app.view().classLabel, "Demo · Week 1");
  assert.equal(h.app.view().mode, "native");
  assert.equal(h.app.view().catalog, undefined);
  await assert.rejects(h.app.forward({ client: "copilot", model: "old-only-model" }), /沒有上課模型/);
  assert.equal(h.sent().length, 0);
  const restarted = harness(undefined, { storage: createPersistentConnectionStorage(disk) });
  await restarted.app.start();
  assert.equal(restarted.app.view().nickname, "New student");
  await restarted.app.copyKey();
  assert.equal(restarted.clipboard(), KEY);
});

it("refuses a session replacement when saving and deleting fail, keeping the usable class", async () => {
  const disk = persistentStorageFake();
  const old = { version: 1 as const, apiKey: "old-key", session: { class_name: "Old", name: "Lesson" }, nickname: "Old student", mode: "native" as const };
  await disk.setConnection(old);
  let refuseWrites = false;
  const storage = createPersistentConnectionStorage({
    getConnection: () => disk.getConnection(),
    async setConnection(connection) {
      if (refuseWrites) throw new Error(KEY);
      return disk.setConnection(connection);
    },
    async clearConnection() { throw new Error("old-key"); },
  });
  const h = harness(undefined, { storage });
  await h.app.start();
  await h.app.setSwitch("classroom");
  refuseWrites = true;
  const previous = h.app.view();
  await h.app.redeem("NEW", "New student");
  assert.equal(h.app.view().classLabel, previous.classLabel);
  assert.equal(h.app.view().nickname, previous.nickname);
  assert.deepEqual(h.app.view().catalog, previous.catalog);
  assert.equal(h.app.view().mode, previous.mode);
  assert.match(h.app.view().notice ?? "", /換堂|連線/);
  assert.doesNotMatch(renderPage(h.app.view()), /old-key|vcr_sk_nick/);
  await h.app.copyKey();
  assert.equal(h.clipboard(), "old-key");
  await h.app.forward({ client: "codex", model: "later" });
  assert.deepEqual(h.sent(), [{ client: "codex", target: "router", model: "later", apiKey: "old-key", adapter: "responses" }]);
  assert.deepEqual(await disk.getConnection(), { ...old, mode: "classroom", clientModes: { codex: "classroom", claude: "classroom" } });
});

it("replacement can be temporary only after persistent clearing, and restart never returns to the old class", async () => {
  const disk = persistentStorageFake();
  await disk.setConnection({ version: 1, apiKey: "old-key", session: { class_name: "Old" }, nickname: "Old student", mode: "native" });
  const storage = createPersistentConnectionStorage({
    getConnection: () => disk.getConnection(),
    async setConnection() { throw new Error("secure storage unavailable"); },
    clearConnection: () => disk.clearConnection(),
  });
  const h = harness(undefined, { storage });
  await h.app.start();
  await h.app.redeem("NEW", "New student");
  assert.equal(h.app.view().classLabel, "Demo · Week 1");
  await h.app.copyKey();
  assert.equal(h.clipboard(), KEY);
  await h.app.setSwitch("classroom");
  await h.app.forward({ client: "codex", model: "later" });
  assert.equal(h.sent()[0]?.apiKey, KEY);
  assert.equal(await disk.getConnection(), undefined);
  const restarted = harness(undefined, { storage: createPersistentConnectionStorage(disk) });
  await restarted.app.start();
  assert.equal(restarted.app.view().connected, false);
  assert.equal(restarted.app.view().canCopyKey, false);
});

it("an unreadable stored connection cannot be displaced by a failed redeem commit", async () => {
  let retained = true;
  const persistent: ConnectionStorage = {
    async getConnection() { throw new Error("ciphertext cannot decrypt"); },
    async setConnection() { throw new Error(KEY); },
    async clearConnection() { if (retained) throw new Error(KEY); },
  };
  const h = harness(undefined, { storage: createPersistentConnectionStorage(persistent) });
  await h.app.start();
  await h.app.redeem("NEW", "New student");
  assert.equal(h.app.view().connected, false);
  assert.equal(h.app.view().canCopyKey, false);
  assert.match(h.app.view().notice ?? "", /換堂未完成/);
  assert.equal(h.modelKeys.length, 0);
  assert.doesNotMatch(renderPage(h.app.view()), /vcr_sk_nick/);
  retained = false;
  await h.app.redeem("NEW", "New student");
  assert.equal(h.app.view().connected, true);
});

it("temporary connections retain the whole record only in the current process storage", async () => {
  const storage = createConnectionStorage(createMemorySecureStorage());
  const connection = { version: 1 as const, apiKey: KEY, session: { class_name: "Demo", name: "Week 1" }, nickname: "Student", mode: "native" as const };
  assert.deepEqual(await storage.setConnection(connection), { persistence: "temporary" });
  assert.deepEqual(await storage.getConnection(), connection);
  assert.equal(await createConnectionStorage(createMemorySecureStorage()).getConnection(), undefined);
  await storage.clearConnection();
  assert.equal(await storage.getConnection(), undefined);
});

const REMOTE_YAML = `
actions:
  - id: demo
    title: 安裝 demo
    kind: package
    description: 從課堂清單安裝
    command: uv add demo
snippets:
  - id: stub
    title: 骨架
    paste_hint: main.py
    body: "print(1)\\n"
`;

function harness(
  session?: { class_name?: string; name?: string },
  options?: {
    detectClient?: (client: "codex" | "claude" | "vsCodeChat") => Promise<boolean>;
    adapterSettings?: AdapterSettingsStorage;
    clientRouteSettings?: ClientRouteSettingsStorage;
    clientRouteRuntime?: ClientRouteRuntime;
    storage?: ConnectionStorage;
    send?: (upstream: UpstreamSend) => Promise<void>;
    redeemError?: Error;
    catalogYaml?: unknown;
    catalogBody?: { course_catalog_yaml?: unknown };
    catalogError?: Error;
    catalogFetch?: (key: string) => Promise<{ course_catalog_yaml?: unknown }>;
    files?: Record<string, string | undefined>;
    run?: (cwd: string, command: string, onOutput?: (output: string) => void) => Promise<string>;
    runExitCode?: number;
    write?: (path: string, contents: string) => Promise<void>;
    sessionModels?: (apiKey: string) => Promise<string[] | Array<Record<string, unknown>>>;
    codex?: Record<string, unknown>;
    claudeTerminal?: Record<string, unknown>;
    vsCode?: Record<string, unknown>;
    probe?: (tool: EnvironmentToolId) => Promise<{ installed: boolean }>;
    install?: (
      tool: EnvironmentToolId,
      cwd: string,
    ) => Promise<{ exitCode: number | undefined; output: string }>;
    providers?: Array<Record<string, unknown>>;
    setModelOptions?: (value: ModelOptions | null) => Promise<void>;
    vsCodeRouteSettings?: VsCodeRouteSettings;
    setClaudeCodeRoute?: (classroom: boolean, proxyBaseUrl: string) => Promise<void>;
    migrateLegacyState?: (proxyBaseUrl: string, clients?: { codex: boolean; claude: boolean; vsCodeChat: boolean }) => Promise<void>;
  },
) {
  const redeemCalls: { invite_code: string; nickname: string }[] = [];
  const catalogKeys: string[] = [];
  const fileReads: string[] = [];
  const runCalls: { cwd: string; command: string }[] = [];
  const probeCalls: EnvironmentToolId[] = [];
  const installCalls: { tool: EnvironmentToolId; cwd: string }[] = [];
  const modelKeys: string[] = [];
  let providers = structuredClone(options?.providers ?? []);
  const copilotWrites: { providers: Array<Record<string, unknown>> }[] = [];
  const proxyReceived: string[] = [];
  const sent: UpstreamSend[] = [];
  const storage = options?.storage ?? createConnectionStorage(createMemorySecureStorage());
  let clipboard = "";
  let clipboardWrites = 0;
  let clipboardError: Error | undefined;
  let stops = 0;
  let proxyStops = 0;
  let proxyStarts = 0;
  const docs = {
    codex: { ...(options?.codex ?? {}) },
    claudeTerminal: { ...(options?.claudeTerminal ?? {}) },
    vsCode: { ...(options?.vsCode ?? {}) },
  };
  const routeWrites = { codex: 0, claudeTerminal: 0, vsCode: 0 };
  let codexRouteBackup: { url?: unknown } | undefined;
  let claudeRouteBackup: { terminal?: unknown; vscode?: unknown } | undefined;
  let modelOptions: ModelOptions | null = null;
  const resolvedSession = session ?? { class_name: "Demo", name: "Week 1" };
  const app = new ClassroomApp({
    detectClient: options?.detectClient,
    adapterSettings: options?.adapterSettings,
    clientRouteSettings: options?.clientRouteSettings,
    clientRouteRuntime: options?.clientRouteRuntime,
    vsCodeRouteSettings: options?.vsCodeRouteSettings,
    router: {
      async redeemNickname(body) {
        redeemCalls.push(body);
        if (options?.redeemError) {
          throw options.redeemError;
        }
        return {
          api_key: KEY,
          session: resolvedSession,
        };
      },
      async fetchSessionModels(apiKey: string) {
        modelKeys.push(apiKey);
        if (options?.sessionModels) {
          return options.sessionModels(apiKey);
        }
        return ["second-looking-but-first", "later"];
      },
    },
    catalog: {
      async fetchCourseCatalog(apiKey) {
        catalogKeys.push(apiKey);
        if (options?.catalogFetch) return options.catalogFetch(apiKey);
        if (options?.catalogError) {
          throw options.catalogError;
        }
        if (options?.catalogBody) {
          return options.catalogBody;
        }
        return {
          course_catalog_yaml:
            options?.catalogYaml === undefined
              ? REMOTE_YAML
              : options.catalogYaml,
        };
      },
    },
    projectFiles: {
      async readClassroomInstalls(folder) {
        fileReads.push(folder);
        return options?.files?.[folder];
      },
    },
    clipboard: {
      async write(text: string) {
        if (clipboardError) {
          throw clipboardError;
        }
        clipboard = text;
        clipboardWrites += 1;
      },
    },
    storage,
    commands: {
      async run(cwd, command, onOutput) {
        runCalls.push({ cwd, command });
        if (options?.run) {
          return { output: await options.run(cwd, command, onOutput), exitCode: options.runExitCode ?? 0 };
        }
        return { output: "ok", exitCode: options?.runExitCode ?? 0 };
      },
    },
    files: {
      async write(path, contents) {
        await options?.write?.(path, contents);
      },
    },
    environment: {
      async probe(tool) {
        probeCalls.push(tool);
        if (options?.probe) {
          return options.probe(tool);
        }
        return { installed: false };
      },
      async install(tool, cwd) {
        installCalls.push({ tool, cwd });
        if (options?.install) {
          return options.install(tool, cwd);
        }
        return { exitCode: 0, output: "" };
      },
    },
    stopProcess() {
      stops += 1;
    },
    proxyBaseUrl: PROXY,
    routes: {
      async migrateLegacyState(proxyBaseUrl, clients) { await options?.migrateLegacyState?.(proxyBaseUrl, clients); },
      async setClaudeCodeRoute(classroom, proxyBaseUrl) {
        await options?.setClaudeCodeRoute?.(classroom, proxyBaseUrl);
        if (classroom) {
          claudeRouteBackup ??= { terminal: docs.claudeTerminal.ANTHROPIC_BASE_URL, vscode: undefined };
          docs.claudeTerminal.ANTHROPIC_BASE_URL = proxyBaseUrl;
          routeWrites.claudeTerminal += 1;
        } else if (docs.claudeTerminal.ANTHROPIC_BASE_URL === proxyBaseUrl) {
          if (claudeRouteBackup?.terminal !== undefined) docs.claudeTerminal.ANTHROPIC_BASE_URL = claudeRouteBackup.terminal;
          else delete docs.claudeTerminal.ANTHROPIC_BASE_URL;
          routeWrites.claudeTerminal += 1;
          claudeRouteBackup = undefined;
        }
      },
      async setCodexRoute(routeOptions: CodexRouteOptions) {
        const classroom = routeOptions.mode === "classroom";
        const proxyBaseUrl = routeOptions.proxyBaseUrl;
        modelOptions = routeOptions.mode === "classroom" ? {
          ids: [...routeOptions.ids],
          codexModel: routeOptions.selectedModel,
          claudeModel: routeOptions.selectedModel,
          proxyBaseUrl: routeOptions.proxyBaseUrl,
          clients: { codex: true, claude: false },
          updateClient: "codex",
        } : null;
        await options?.setModelOptions?.(modelOptions);
        const current = docs.codex.openai_base_url;
        const managed = current === proxyBaseUrl || current === `${proxyBaseUrl}/v1`;
        if (classroom) {
          codexRouteBackup ??= { url: managed ? undefined : current };
          docs.codex.openai_base_url = `${proxyBaseUrl}/v1`;
        } else {
          if (!codexRouteBackup && !managed) return;
          if (codexRouteBackup?.url !== undefined) docs.codex.openai_base_url = codexRouteBackup.url;
          else delete docs.codex.openai_base_url;
          codexRouteBackup = undefined;
        }
        routeWrites.codex += 1;
      },
    },
    copilot: {
      async read() {
        return { providers: structuredClone(providers) };
      },
      async write(doc) {
        copilotWrites.push(structuredClone(doc));
        providers = structuredClone(doc.providers);
      },
    },
    proxy: {
      start() {
        proxyStarts += 1;
      },
      stop() {
        proxyStops += 1;
      },
      async receive(request) {
        proxyReceived.push(request.provider);
      },
    },
    async send(upstream) {
      sent.push({ ...upstream });
      await options?.send?.(upstream);
    },
  });
  return {
    app,
    redeemCalls,
    modelKeys,
    clipboard: () => clipboard,
    clipboardWrites: () => clipboardWrites,
    storedKey: async () => (await storage.getConnection())?.apiKey,
    storedConnection: () => storage.getConnection(),
    stops: () => stops,
    proxyStops: () => proxyStops,
    proxyStarts: () => proxyStarts,
    docs,
    routeWrites,
    modelOptions: () => modelOptions,
    catalogKeys,
    fileReads,
    copilotWrites: () => copilotWrites,
    copilotProviders: () => structuredClone(providers),
    proxyReceived: () => [...proxyReceived],
    sent: () => sent.map((item) => ({ ...item })),
    runCalls,
    probeCalls,
    installCalls,
    failClipboard(error: Error) {
      clipboardError = error;
    },
  };
}

describe("copy lesson snippets", () => {
  it("copies the complete selected snippet including lines beyond the visible region", async () => {
    const body = Array.from({ length: 50 }, (_,index) => `print('第 ${index + 1} 行')`).join("\n") + "\n";
    const { app, clipboard, clipboardWrites } = harness(undefined, {
      catalogYaml: `actions: []\nsnippets:\n  - id: full\n    title: 完整程式\n    body: ${JSON.stringify(body)}\n  - id: other\n    title: 其他片段\n    body: other\n`,
    });
    await app.redeem("ABC12345", "Ada");
    assert.equal(await app.copySnippet("full"), true);
    assert.equal(clipboard(), body);
    assert.equal(clipboardWrites(), 1);
    assert.equal(await app.copySnippet("missing"), false);
    assert.equal(clipboardWrites(), 1);
  });

  it("reports a clipboard failure without changing the snippet", async () => {
    const { app, failClipboard } = harness();
    await app.redeem("ABC12345", "Ada");
    failClipboard(new Error("clipboard unavailable"));
    assert.equal(await app.copySnippet("stub"), false);
    assert.equal(app.view().catalog?.snippets?.[0].body, "print(1)\n");
  });
});

it("adapter selections default to Responses, remain independent, and survive redeem, clear, and restart", async () => {
  let saved: { codex: "chat" | "responses"; claude: "chat" | "responses" | "messages" } = { codex: "responses", claude: "responses" };
  const adapterSettings: AdapterSettingsStorage = { async load() { return { ...saved }; }, async save(next) { saved = { ...next }; } };
  const h = harness(undefined, { adapterSettings });
  await h.app.start();
  assert.deepEqual(h.app.view().adapters, { codex: "responses", claude: "responses" });
  await h.app.redeem("DEMO", "Student"); await h.app.setSwitch("classroom");
  await h.app.setAdapter("codex", "chat"); await h.app.setAdapter("claude", "messages");
  await h.app.forward({ client: "codex", model: "later" }); await h.app.forward({ client: "claude", model: "later" });
  assert.equal(h.sent()[0].adapter, "chat"); assert.equal(h.sent()[1].adapter, "messages");
  await h.app.setSwitch("native"); await h.app.forward({ client: "codex", model: "personal" });
  assert.equal(h.sent()[2].adapter, undefined);
  await h.app.clearConnection(); await h.app.redeem("NEW", "Next");
  const restarted = harness(undefined, { adapterSettings }); await restarted.app.start();
  assert.deepEqual(restarted.app.view().adapters, { codex: "chat", claude: "messages" });
  await assert.rejects(restarted.app.setAdapter("codex", "messages"), /Codex/);
});

it("publishes independent Client Route defaults without changing legacy routing state", () => {
  const { app } = harness();
  assert.deepEqual(app.view().clientRoutes, {
    codex: { id: "codex", mode: "native", adapter: "responses", health: "gray", restart: "ready" },
    claudeCode: { id: "claudeCode", mode: "native", adapter: "responses", health: "gray", restart: "ready" },
    vsCodeChat: { id: "vsCodeChat", mode: "native", adapter: "responses", health: "gray", restart: "ready" },
  });
  assert.deepEqual(app.view().clientModes, { codex: "native", claude: "native" });
});

it("does not copy a legacy combined Classroom mode into the separated Client Routes", async () => {
  const storage = createConnectionStorage(createMemorySecureStorage());
  await storage.setConnection({
    version: 1,
    apiKey: KEY,
    session: { class_name: "Saved" },
    mode: "classroom",
  });
  const { app } = harness(undefined, { storage });

  await app.start();

  assert.equal(app.view().mode, "classroom");
  assert.deepEqual(Object.fromEntries(
    Object.entries(app.view().clientRoutes ?? {}).map(([id, route]) => [id, route.mode]),
  ), { codex: "native", claudeCode: "native", vsCodeChat: "native" });
});

it("publishes persisted separated Client Route state without changing legacy routing", async () => {
  const clientRouteSettings: ClientRouteSettingsStorage = {
    async load() {
      return {
        codex: { mode: "classroom", adapter: "chat" },
        claudeCode: { mode: "native", adapter: "messages" },
        vsCodeChat: { mode: "classroom", adapter: "chat" },
      };
    },
    async save() {},
  };
  const { app } = harness(undefined, { clientRouteSettings });

  await app.start();

  assert.deepEqual(app.view().clientRoutes, {
    codex: { id: "codex", mode: "classroom", adapter: "chat", health: "gray", restart: "ready" },
    claudeCode: { id: "claudeCode", mode: "native", adapter: "messages", health: "gray", restart: "ready" },
    vsCodeChat: { id: "vsCodeChat", mode: "classroom", adapter: "chat", health: "gray", restart: "ready" },
  });
  assert.deepEqual(app.view().clientModes, { codex: "native", claude: "native" });
});

it("refuses client classroom switches without models and resets both after allowlist removal", async () => {
  let models = ["one", "two"];
  const h = harness(undefined, { sessionModels: async () => models });
  await h.app.start();
  await h.app.setSwitch("classroom", "codex");
  assert.equal(h.app.view().clientModes?.codex, "native");
  await h.app.redeem("DEMO", "Student");
  assert.deepEqual(h.app.view().allowedModels, models);
  await h.app.setSwitch("classroom", "codex");
  models = [];
  await h.app.reloadAllowlist();
  assert.deepEqual(h.app.view().clientModes, { codex: "native", claude: "native" });
  assert.deepEqual(h.app.view().allowedModels, []);
  assert.equal(h.modelOptions(), null);
});

it("detects clients on startup and refresh without treating probe failure as a connection failure", async () => {
  let found = true;
  const h = harness(undefined, { async detectClient(client) {
    if (client === "claude") throw new Error("missing executable");
    return found;
  } });
  await h.app.start();
  assert.deepEqual(h.app.view().detectedClients, { codex: true, claude: false });
  found = false; await h.app.reloadAllowlist();
  assert.deepEqual(h.app.view().detectedClients, { codex: false, claude: false });
});

it("gates legacy migration with the clients detected on startup and Reload", async () => {
  let installed = { codex: false, claude: true, vsCodeChat: false };
  const migrations: Array<typeof installed> = [];
  const h = harness(undefined, {
    detectClient: async client => installed[client],
    migrateLegacyState: async (_origin, clients) => { migrations.push(structuredClone(clients!)); },
  });

  await h.app.start();
  installed = { codex: true, claude: true, vsCodeChat: true };
  await h.app.reloadAllowlist();

  assert.deepEqual(migrations, [
    { codex: false, claude: true, vsCodeChat: false },
    { codex: true, claude: true, vsCodeChat: true },
  ]);
});

it("Reload re-detects gray clients and enables every recovered route as Native", async () => {
  let installed = false;
  const starts: string[] = [];
  const runtime: ClientRouteRuntime = {
    async start(route) {
      starts.push(route);
      const port = route === "claudeCode" ? 47822 : route === "vsCodeChat" ? 47823 : 47821;
      return { route, health: "green", origin: `http://127.0.0.1:${port}` };
    },
    async stop() {},
  };
  const h = harness(undefined, {
    detectClient: async () => installed,
    clientRouteRuntime: runtime,
    vsCodeRouteSettings: {
      async initializeNative() { return { changed: false }; },
      async publish() { return { changed: false }; },
      async restore() { return { changed: false }; },
    },
  });
  await h.app.start();
  assert.deepEqual(Object.values(h.app.view().clientRoutes!).map(route => route.health), ["gray", "gray", "gray"]);
  assert.deepEqual(starts, []);
  installed = true;

  await h.app.reloadAllowlist();

  for (const route of Object.values(h.app.view().clientRoutes!)) {
    assert.equal(route.mode, "native");
    assert.equal(route.health, "green");
    assert.equal(route.restart, "ready");
  }
  assert.deepEqual(starts, ["codex", "claudeCode", "vsCodeChat"]);
});

it("keeps a failed Codex listener red and Native without writing Classroom settings", async () => {
  let saved = {
    codex: { mode: "classroom" as const, adapter: "chat" as const },
    claudeCode: { mode: "native" as const, adapter: "responses" as const },
    vsCodeChat: { mode: "native" as const, adapter: "responses" as const },
  };
  const starts: string[] = [];
  const runtime: ClientRouteRuntime = {
    async start(route): Promise<ClientRouteStart> {
      starts.push(route);
      return { route, health: "red", origin: "http://127.0.0.1:54321" };
    },
    async stop() {},
  };
  const h = harness(undefined, {
    detectClient: async client => client === "codex",
    clientRouteRuntime: runtime,
    clientRouteSettings: {
      async load() { return structuredClone(saved); },
      async save(next) { saved = structuredClone(next) as typeof saved; },
    },
  });

  await h.app.start();

  assert.deepEqual(starts, ["codex"]);
  assert.equal(h.app.view().clientRoutes?.codex.health, "red");
  assert.equal(h.app.view().clientRoutes?.codex.mode, "native");
  assert.equal(saved.codex.mode, "native");
  assert.equal(h.docs.codex.openai_base_url, undefined);
});

it("a recovered Codex listener stays Native and allows adapter preparation", async () => {
  let healthy = false;
  let saved = {
    codex: { mode: "classroom" as "native" | "classroom", adapter: "responses" as "responses" | "chat" },
    claudeCode: { mode: "native" as const, adapter: "responses" as const },
    vsCodeChat: { mode: "native" as const, adapter: "responses" as const },
  };
  const runtime: ClientRouteRuntime = {
    async start(route) { return { route, health: healthy ? "green" : "red", origin: "http://127.0.0.1:47821" }; },
    async stop() {},
  };
  const h = harness(undefined, {
    detectClient: async client => client === "codex",
    clientRouteRuntime: runtime,
    clientRouteSettings: {
      async load() { return structuredClone(saved); },
      async save(next) { saved = structuredClone(next) as typeof saved; },
    },
  });
  await h.app.start();
  healthy = true;

  await h.app.reloadAllowlist();
  await h.app.setAdapter("codex", "chat");

  assert.equal(h.app.view().clientRoutes?.codex.health, "green");
  assert.equal(h.app.view().clientRoutes?.codex.mode, "native");
  assert.equal(h.app.view().clientRoutes?.codex.adapter, "chat");
  assert.equal(saved.codex.adapter, "chat");
});

it("switches healthy Codex through its independent route state and rejects stale Native requests", async () => {
  let saved = {
    codex: { mode: "native" as "native" | "classroom", adapter: "responses" as "responses" | "chat" },
    claudeCode: { mode: "native" as const, adapter: "responses" as const },
    vsCodeChat: { mode: "native" as const, adapter: "responses" as const },
  };
  const runtime: ClientRouteRuntime = {
    async start(route) { return { route, health: "green", origin: "http://127.0.0.1:47821" }; },
    async stop() {},
  };
  const h = harness(undefined, {
    detectClient: async client => client === "codex",
    clientRouteRuntime: runtime,
    clientRouteSettings: {
      async load() { return structuredClone(saved); },
      async save(next) { saved = structuredClone(next) as typeof saved; },
    },
  });
  await h.app.start();
  await assert.rejects(h.app.forward({ client: "codex", model: "personal" }), /重開 Codex/);
  await h.app.redeem("DEMO", "Student");

  await h.app.setSwitch("classroom", "codex");

  assert.equal(saved.codex.mode, "classroom");
  assert.equal(h.app.view().clientRoutes?.codex.mode, "classroom");
  assert.equal(h.app.view().clientRoutes?.codex.health, "yellow");
  assert.equal(h.docs.codex.openai_base_url, `${PROXY}/v1`);
  await h.app.forward({ client: "codex", model: "later" });
  assert.equal(h.app.view().clientRoutes?.codex.health, "green");

  await h.app.setSwitch("native", "codex");
  assert.equal(saved.codex.mode, "native");
  assert.equal(h.app.view().clientRoutes?.codex.health, "green");
  await assert.rejects(h.app.forward({ client: "codex", model: "later" }), /重開 Codex/);

  await h.app.setSwitch("classroom", "codex");
  await h.app.clearConnection();
  assert.equal(saved.codex.mode, "native");
  assert.equal(h.app.view().clientRoutes?.codex.mode, "native");
});

it("switches VS Code independently, publishes its complete catalog, and becomes green after its first routed request", async () => {
  let saved = {
    codex: { mode: "native" as const, adapter: "responses" as const },
    claudeCode: { mode: "native" as const, adapter: "responses" as const },
    vsCodeChat: { mode: "native" as "native" | "classroom", adapter: "responses" as "responses" | "chat" },
  };
  const starts: string[] = [];
  const published: unknown[] = [];
  let restored = 0;
  const runtime: ClientRouteRuntime = {
    async start(route) {
      starts.push(route);
      const port = route === "vsCodeChat" ? 47823 : 47821;
      return { route, health: "green", origin: `http://127.0.0.1:${port}` };
    },
    async stop() {},
  };
  const h = harness(undefined, {
    detectClient: async client => client === "codex" || client === "vsCodeChat",
    clientRouteRuntime: runtime,
    clientRouteSettings: {
      async load() { return structuredClone(saved); },
      async save(next) { saved = structuredClone(next) as typeof saved; },
    },
    sessionModels: async () => [{
      name: "VCRouter", vendor: "customendpoint", models: [{ id: "lesson", name: "Lesson", toolCalling: true, vision: true }],
    }],
    vsCodeRouteSettings: {
      async initializeNative() { return { changed: false }; },
      async publish(value) { published.push(structuredClone(value)); return { changed: true }; },
      async restore() { restored += 1; return { changed: true }; },
    },
  });
  await h.app.start();
  await h.app.redeem("DEMO", "Student");

  await h.app.setSwitch("classroom", "vscode");

  assert.deepEqual(starts, ["codex", "vsCodeChat"]);
  assert.equal(saved.vsCodeChat.mode, "classroom");
  assert.equal(h.app.view().clientRoutes?.vsCodeChat.health, "yellow");
  assert.deepEqual(published[0], {
    providers: [{ name: "VCRouter", vendor: "customendpoint", models: [{ id: "lesson", name: "Lesson", toolCalling: true, vision: true }] }],
    adapter: "responses",
    origin: "http://127.0.0.1:47823",
  });
  await h.app.forward({ client: "copilot", model: "lesson" });
  assert.equal(h.app.view().clientRoutes?.vsCodeChat.health, "green");
  await h.app.setAdapter("vscode", "chat");
  assert.equal(saved.vsCodeChat.adapter, "chat");
  assert.equal(h.app.view().clientRoutes?.vsCodeChat.health, "yellow");
  await h.app.setSwitch("native", "vscode");
  assert.equal(restored, 1);
  assert.equal(h.app.view().clientRoutes?.vsCodeChat.health, "green");
  await assert.rejects(h.app.forward({ client: "copilot", model: "lesson" }), /重開 VS Code/);
});

it("marks only VS Code red when its listener collides", async () => {
  const runtime: ClientRouteRuntime = {
    async start(route) {
      if (route === "vsCodeChat") throw Object.assign(new Error("occupied"), { code: "EADDRINUSE" });
      return { route, health: "green", origin: "http://127.0.0.1:47821" };
    },
    async stop() {},
  };
  const h = harness(undefined, {
    detectClient: async client => client === "codex" || client === "vsCodeChat",
    clientRouteRuntime: runtime,
    vsCodeRouteSettings: {
      async initializeNative() { return { changed: false }; },
      async publish() { return { changed: false }; },
      async restore() { return { changed: false }; },
    },
  });

  await h.app.start();

  assert.equal(h.app.view().clientRoutes?.codex.health, "green");
  assert.equal(h.app.view().clientRoutes?.vsCodeChat.health, "red");
  assert.equal(h.app.view().clientRoutes?.claudeCode.health, "gray");
});

it("a failed VS Code listener restores its owned provider before persisting Native", async () => {
  const events: string[] = [];
  let saved = {
    codex: { mode: "native" as const, adapter: "responses" as const },
    claudeCode: { mode: "native" as const, adapter: "responses" as const },
    vsCodeChat: { mode: "classroom" as "native" | "classroom", adapter: "responses" as const },
  };
  const runtime: ClientRouteRuntime = {
    async start(route) { return { route, health: route === "vsCodeChat" ? "red" : "green", origin: "http://127.0.0.1:47823" }; },
    async stop() {},
  };
  const h = harness(undefined, {
    detectClient: async client => client === "vsCodeChat",
    clientRouteRuntime: runtime,
    clientRouteSettings: {
      async load() { return structuredClone(saved); },
      async save(next) { events.push(`save:${next.vsCodeChat.mode}`); saved = structuredClone(next) as typeof saved; },
    },
    vsCodeRouteSettings: {
      async initializeNative() { return { changed: false }; },
      async publish() { return { changed: false }; },
      async restore() { events.push("restore:vscode"); return { changed: true }; },
    },
  });

  await h.app.start();

  assert.deepEqual(events.slice(0, 2), ["restore:vscode", "save:native"]);
  assert.equal(h.app.view().clientRoutes?.vsCodeChat.health, "red");
});

it("Reload recovers a freed VS Code listener as Native and green", async () => {
  let available = false;
  const runtime: ClientRouteRuntime = {
    async start(route) {
      return { route, health: route === "vsCodeChat" && !available ? "red" : "green", origin: "http://127.0.0.1:47823" };
    },
    async stop() {},
  };
  const h = harness(undefined, {
    detectClient: async client => client === "vsCodeChat",
    clientRouteRuntime: runtime,
    vsCodeRouteSettings: {
      async initializeNative() { return { changed: false }; },
      async publish() { return { changed: false }; },
      async restore() { return { changed: false }; },
    },
  });
  await h.app.start();
  assert.equal(h.app.view().clientRoutes?.vsCodeChat.health, "red");
  available = true;

  await h.app.reloadAllowlist();

  assert.equal(h.app.view().clientRoutes?.vsCodeChat.mode, "native");
  assert.equal(h.app.view().clientRoutes?.vsCodeChat.health, "green");
  assert.equal(h.app.view().clientRoutes?.vsCodeChat.restart, "ready");
});

it("Stop restores the journal-owned VS Code provider before closing its listener", async () => {
  const events: string[] = [];
  const runtime: ClientRouteRuntime = {
    async start(route) {
      return { route, health: "green", origin: route === "vsCodeChat" ? "http://127.0.0.1:47823" : "http://127.0.0.1:47821" };
    },
    async stop(route) { events.push(`stop:${route}`); },
  };
  const h = harness(undefined, {
    detectClient: async client => client === "vsCodeChat",
    clientRouteRuntime: runtime,
    sessionModels: async () => [{ name: "VCRouter", vendor: "customendpoint", models: [{ id: "lesson" }] }],
    vsCodeRouteSettings: {
      async initializeNative() { return { changed: false }; },
      async publish() { events.push("publish:vscode"); return { changed: true }; },
      async restore() { events.push("restore:vscode"); return { changed: true }; },
    },
  });
  await h.app.start();
  await h.app.redeem("DEMO", "Student");
  await h.app.setSwitch("classroom", "vscode");
  events.length = 0;

  await h.app.stop();

  assert.deepEqual(events.filter(event => event.toLowerCase().includes("vscode")), ["restore:vscode", "stop:vsCodeChat"]);
});

it("Clear removes the journal-owned VS Code provider and returns the route to healthy Native", async () => {
  let restored = 0;
  const runtime: ClientRouteRuntime = {
    async start(route) { return { route, health: "green", origin: route === "vsCodeChat" ? "http://127.0.0.1:47823" : "http://127.0.0.1:47821" }; },
    async stop() {},
  };
  const h = harness(undefined, {
    detectClient: async client => client === "vsCodeChat",
    clientRouteRuntime: runtime,
    sessionModels: async () => [{ name: "VCRouter", vendor: "customendpoint", models: [{ id: "lesson" }] }],
    vsCodeRouteSettings: {
      async initializeNative() { return { changed: false }; },
      async publish() { return { changed: true }; },
      async restore() { restored += 1; return { changed: true }; },
    },
  });
  await h.app.start();
  await h.app.redeem("DEMO", "Student");
  await h.app.setSwitch("classroom", "vscode");

  await h.app.clearConnection();

  assert.equal(restored, 1);
  assert.equal(h.app.view().clientRoutes?.vsCodeChat.mode, "native");
  assert.equal(h.app.view().clientRoutes?.vsCodeChat.health, "green");
  assert.equal(h.app.view().clientRoutes?.vsCodeChat.restart, "ready");
});

it("Clear commits credential revocation before independent route recovery and Reload retries every failed journal", async () => {
  const storage = createConnectionStorage(createMemorySecureStorage());
  const running = new Set<string>();
  const restoreAttempts = { codex: 0, claudeCode: 0, vsCodeChat: 0 };
  let failRecovery = false;
  const assertRevoked = async () => {
    assert.equal((await storage.getConnection())?.apiKey, undefined);
  };
  const runtime: ClientRouteRuntime = {
    async start(route) {
      running.add(route);
      const port = route === "codex" ? 47821 : route === "claudeCode" ? 47822 : 47823;
      return { route, health: "green", origin: `http://127.0.0.1:${port}` };
    },
    current(route) {
      if (!running.has(route)) return undefined;
      const port = route === "codex" ? 47821 : route === "claudeCode" ? 47822 : 47823;
      return { route, health: "green", origin: `http://127.0.0.1:${port}` };
    },
    async stop(route) { if (route) running.delete(route); },
  };
  const h = harness(undefined, {
    storage,
    detectClient: async () => true,
    clientRouteRuntime: runtime,
    async setModelOptions(value) {
      if (value !== null) return;
      restoreAttempts.codex += 1;
      await assertRevoked();
      if (failRecovery) throw new Error(`Codex restore denied ${KEY}`);
    },
    async setClaudeCodeRoute(classroom) {
      if (classroom) return;
      restoreAttempts.claudeCode += 1;
      await assertRevoked();
      if (failRecovery) throw new Error(`Claude restore denied ${KEY}`);
    },
    vsCodeRouteSettings: {
      async initializeNative() { return { changed: false }; },
      async publish() { return { changed: true }; },
      async restore() {
        restoreAttempts.vsCodeChat += 1;
        await assertRevoked();
        if (failRecovery) throw new Error(`VS Code restore denied ${KEY}`);
        return { changed: true };
      },
    },
  });
  await h.app.start();
  await h.app.redeem("DEMO", "Student");
  await h.app.setSwitch("classroom", "codex");
  await h.app.setSwitch("classroom", "claude");
  await h.app.setSwitch("classroom", "vscode");
  failRecovery = true;

  await h.app.clearConnection();

  assert.equal(await storage.getConnection(), undefined);
  const failedRoutes = h.app.view().clientRoutes!;
  assert.deepEqual({
    codex: failedRoutes.codex.health,
    claudeCode: failedRoutes.claudeCode.health,
    vsCodeChat: failedRoutes.vsCodeChat.health,
  }, { codex: "red", claudeCode: "red", vsCodeChat: "red" });
  assert.deepEqual([...running].sort(), ["claudeCode", "codex", "vsCodeChat"]);
  await assert.rejects(h.app.forward({ client: "codex", model: "later" }), /重開 Codex/);
  await assert.rejects(h.app.forward({ client: "claude", model: "later" }), /重開 Claude Code/);
  await assert.rejects(h.app.forward({ client: "copilot", model: "later" }), /重開 VS Code/);
  assert.deepEqual(h.sent(), []);
  assert.equal(JSON.stringify(h.app.view()).includes(KEY), false);

  failRecovery = false;
  const attemptsAfterClear = { ...restoreAttempts };
  await h.app.reloadAllowlist();

  assert.equal(restoreAttempts.codex, attemptsAfterClear.codex + 1);
  assert.equal(restoreAttempts.claudeCode, attemptsAfterClear.claudeCode + 1);
  assert.equal(restoreAttempts.vsCodeChat, attemptsAfterClear.vsCodeChat + 1);
  const recoveredRoutes = h.app.view().clientRoutes!;
  assert.deepEqual({
    codex: recoveredRoutes.codex.health,
    claudeCode: recoveredRoutes.claudeCode.health,
    vsCodeChat: recoveredRoutes.vsCodeChat.health,
  }, { codex: "green", claudeCode: "green", vsCodeChat: "green" });
});

it("an authoritative empty allowlist restores VS Code to Native", async () => {
  let providers: Array<Record<string, unknown>> = [{ name: "VCRouter", vendor: "customendpoint", models: [{ id: "lesson" }] }];
  let restored = 0;
  const runtime: ClientRouteRuntime = {
    async start(route) { return { route, health: "green", origin: route === "vsCodeChat" ? "http://127.0.0.1:47823" : "http://127.0.0.1:47821" }; },
    async stop() {},
  };
  const h = harness(undefined, {
    detectClient: async client => client === "vsCodeChat",
    clientRouteRuntime: runtime,
    sessionModels: async () => providers,
    vsCodeRouteSettings: {
      async initializeNative() { return { changed: false }; },
      async publish() { return { changed: true }; },
      async restore() { restored += 1; return { changed: true }; },
    },
  });
  await h.app.start();
  await h.app.redeem("DEMO", "Student");
  await h.app.setSwitch("classroom", "vscode");
  providers = [];

  await h.app.reloadAllowlist();

  assert.equal(restored, 1);
  assert.equal(h.app.view().clientRoutes?.vsCodeChat.mode, "native");
  assert.equal(h.app.view().clientRoutes?.vsCodeChat.health, "green");
});

it("an authoritative empty allowlist independently restores every Classroom route to healthy Native", async () => {
  let ids = ["lesson"];
  const restored: string[] = [];
  const runtime: ClientRouteRuntime = {
    async start(route) {
      const port = route === "claudeCode" ? 47822 : route === "vsCodeChat" ? 47823 : 47821;
      return { route, health: "green", origin: `http://127.0.0.1:${port}` };
    },
    current(route) {
      const port = route === "claudeCode" ? 47822 : route === "vsCodeChat" ? 47823 : 47821;
      return { route, health: "green", origin: `http://127.0.0.1:${port}` };
    },
    async stop() {},
  };
  const h = harness(undefined, {
    detectClient: async () => true,
    clientRouteRuntime: runtime,
    sessionModels: async () => [{ name: "VCRouter", models: ids.map(id => ({ id })) }],
    setModelOptions: async value => { if (value === null) restored.push("codex"); },
    setClaudeCodeRoute: async classroom => { if (!classroom) restored.push("claudeCode"); },
    vsCodeRouteSettings: {
      async initializeNative() { return { changed: false }; },
      async publish() { return { changed: true }; },
      async restore() { restored.push("vsCodeChat"); return { changed: true }; },
    },
  });
  await h.app.start();
  await h.app.redeem("DEMO", "Student");
  await h.app.setSwitch("classroom", "codex");
  await h.app.setSwitch("classroom", "claude");
  await h.app.setSwitch("classroom", "vscode");
  restored.length = 0;
  ids = [];

  await h.app.reloadAllowlist();

  assert.deepEqual(h.app.view().allowedModels, []);
  for (const route of Object.values(h.app.view().clientRoutes!)) {
    assert.equal(route.mode, "native");
    assert.equal(route.health, "green");
    assert.equal(route.restart, "ready");
  }
  assert.equal(restored.includes("codex"), true);
  assert.equal(restored.includes("claudeCode"), true);
  assert.equal(restored.includes("vsCodeChat"), true);
});

it("an empty allowlist keeps a failed Codex restoration red and retryable without blocking other routes", async () => {
  let ids = ["lesson"];
  let failCodexRestore = true;
  const restored: string[] = [];
  const runtime: ClientRouteRuntime = {
    async start(route) {
      const port = route === "claudeCode" ? 47822 : route === "vsCodeChat" ? 47823 : 47821;
      return { route, health: "green", origin: `http://127.0.0.1:${port}` };
    },
    current(route) {
      const port = route === "claudeCode" ? 47822 : route === "vsCodeChat" ? 47823 : 47821;
      return { route, health: "green", origin: `http://127.0.0.1:${port}` };
    },
    async stop() {},
  };
  const h = harness(undefined, {
    detectClient: async () => true,
    clientRouteRuntime: runtime,
    sessionModels: async () => [{ name: "VCRouter", models: ids.map(id => ({ id })) }],
    setModelOptions: async value => {
      if (value === null) {
        restored.push("codex");
        if (failCodexRestore) throw new Error("synthetic Codex restore failure");
      }
    },
    setClaudeCodeRoute: async classroom => { if (!classroom) restored.push("claudeCode"); },
    vsCodeRouteSettings: {
      async initializeNative() { return { changed: false }; },
      async publish() { return { changed: true }; },
      async restore() { restored.push("vsCodeChat"); return { changed: true }; },
    },
  });
  await h.app.start();
  await h.app.redeem("DEMO", "Student");
  await h.app.setSwitch("classroom", "codex");
  await h.app.setSwitch("classroom", "claude");
  await h.app.setSwitch("classroom", "vscode");
  restored.length = 0;
  ids = [];

  await assert.doesNotReject(h.app.reloadAllowlist());

  assert.equal(h.app.view().clientRoutes?.codex.mode, "native");
  assert.equal(h.app.view().clientRoutes?.codex.health, "red");
  assert.equal(h.app.view().clientRoutes?.claudeCode.health, "green");
  assert.equal(h.app.view().clientRoutes?.vsCodeChat.health, "green");
  assert.equal(restored.includes("claudeCode"), true);
  assert.equal(restored.includes("vsCodeChat"), true);

  failCodexRestore = false;
  await h.app.reloadAllowlist();

  assert.equal(h.app.view().clientRoutes?.codex.mode, "native");
  assert.equal(h.app.view().clientRoutes?.codex.health, "green");
  assert.equal(restored.filter(route => route === "codex").length >= 2, true);
});

it("Reload republishes same-ID VS Code capability changes and leaves identical content green", async () => {
  let vision = false;
  let intended = "";
  const writes: string[] = [];
  const runtime: ClientRouteRuntime = {
    async start(route) { return { route, health: "green", origin: route === "vsCodeChat" ? "http://127.0.0.1:47823" : "http://127.0.0.1:47821" }; },
    async stop() {},
  };
  const h = harness(undefined, {
    detectClient: async client => client === "vsCodeChat",
    clientRouteRuntime: runtime,
    sessionModels: async () => [{ name: "VCRouter", vendor: "customendpoint", models: [{ id: "lesson", vision }] }],
    vsCodeRouteSettings: {
      async initializeNative() { return { changed: false }; },
      async publish(value) {
        const next = JSON.stringify(value);
        const changed = next !== intended;
        intended = next;
        writes.push(next);
        return { changed };
      },
      async restore() { return { changed: true }; },
    },
  });
  await h.app.start();
  await h.app.redeem("DEMO", "Student");
  await h.app.setSwitch("classroom", "vscode");
  await h.app.forward({ client: "copilot", model: "lesson" });
  assert.equal(h.app.view().clientRoutes?.vsCodeChat.health, "green");
  vision = true;

  await h.app.reloadAllowlist();

  assert.equal(writes.length, 2);
  assert.match(writes[1]!, /"vision":true/);
  assert.equal(h.app.view().clientRoutes?.vsCodeChat.health, "yellow");
  await h.app.forward({ client: "copilot", model: "lesson" });
  await h.app.reloadAllowlist();
  assert.equal(writes.length, 2);
  assert.equal(h.app.view().clientRoutes?.vsCodeChat.health, "green");
});

it("Reload marks only Classroom routes with changed native catalogs yellow", async () => {
  let ids = ["lesson"];
  const runtime: ClientRouteRuntime = {
    async start(route) {
      const port = route === "claudeCode" ? 47822 : route === "vsCodeChat" ? 47823 : 47821;
      return { route, health: "green", origin: `http://127.0.0.1:${port}` };
    },
    current(route) {
      const port = route === "claudeCode" ? 47822 : route === "vsCodeChat" ? 47823 : 47821;
      return { route, health: "green", origin: `http://127.0.0.1:${port}` };
    },
    async stop() {},
  };
  const h = harness(undefined, {
    detectClient: async client => client !== "vsCodeChat",
    clientRouteRuntime: runtime,
    sessionModels: async () => ids,
  });
  await h.app.start();
  await h.app.redeem("DEMO", "Student");
  await h.app.setSwitch("classroom", "codex");
  await h.app.setSwitch("classroom", "claude");
  await h.app.forward({ client: "codex", model: "lesson" });
  await h.app.forward({ client: "claude", model: "lesson" });

  await h.app.reloadAllowlist();
  assert.equal(h.app.view().clientRoutes?.codex.health, "green");
  assert.equal(h.app.view().clientRoutes?.claudeCode.health, "green");

  ids = ["lesson", "new-model"];
  await h.app.reloadAllowlist();

  assert.equal(h.app.view().clientRoutes?.codex.health, "yellow");
  assert.equal(h.app.view().clientRoutes?.codex.restart, "restart-required");
  assert.equal(h.app.view().clientRoutes?.claudeCode.health, "yellow");
  assert.equal(h.app.view().clientRoutes?.claudeCode.restart, "restart-required");
  assert.equal(h.app.view().clientRoutes?.vsCodeChat.health, "gray");

  await h.app.reloadAllowlist();
  assert.equal(h.app.view().clientRoutes?.codex.health, "yellow");
  assert.equal(h.app.view().clientRoutes?.claudeCode.health, "yellow");

  await h.app.forward({ client: "codex", model: "new-model" });
  await h.app.forward({ client: "claude", model: "new-model" });
  await h.app.reloadAllowlist();
  assert.equal(h.app.view().clientRoutes?.codex.health, "green");
  assert.equal(h.app.view().clientRoutes?.claudeCode.health, "green");
});

it("session replacement restores the old VS provider and publishes the new classroom catalog", async () => {
  let id = "old-model";
  const events: string[] = [];
  const runtime: ClientRouteRuntime = {
    async start(route) { return { route, health: "green", origin: route === "vsCodeChat" ? "http://127.0.0.1:47823" : "http://127.0.0.1:47821" }; },
    async stop() {},
  };
  const h = harness(undefined, {
    detectClient: async client => client === "vsCodeChat",
    clientRouteRuntime: runtime,
    sessionModels: async () => [{ name: "VCRouter", vendor: "customendpoint", models: [{ id }] }],
    vsCodeRouteSettings: {
      async initializeNative() { return { changed: false }; },
      async publish(value) { events.push(`publish:${((value.providers[0]!.models as Array<Record<string, unknown>>)[0]!.id)}`); return { changed: true }; },
      async restore() { events.push("restore:vscode"); return { changed: true }; },
    },
  });
  await h.app.start();
  await h.app.redeem("OLD", "Student");
  await h.app.setSwitch("classroom", "vscode");
  events.length = 0;
  id = "new-model";

  await h.app.redeem("NEW", "Student");

  assert.deepEqual(events, ["restore:vscode", "publish:new-model"]);
  assert.equal(h.app.view().clientRoutes?.vsCodeChat.mode, "classroom");
  assert.equal(h.app.view().clientRoutes?.vsCodeChat.health, "yellow");
});

it("a committed session replacement persists VS Native and red when provider restoration fails", async () => {
  let failRestore = false;
  let saved = {
    codex: { mode: "native" as const, adapter: "responses" as const },
    claudeCode: { mode: "native" as const, adapter: "responses" as const },
    vsCodeChat: { mode: "native" as "native" | "classroom", adapter: "responses" as const },
  };
  const runtime: ClientRouteRuntime = {
    async start(route) { return { route, health: "green", origin: route === "vsCodeChat" ? "http://127.0.0.1:47823" : "http://127.0.0.1:47821" }; },
    async stop() {},
  };
  const h = harness(undefined, {
    detectClient: async client => client === "vsCodeChat",
    clientRouteRuntime: runtime,
    clientRouteSettings: {
      async load() { return structuredClone(saved); },
      async save(next) { saved = structuredClone(next) as typeof saved; },
    },
    sessionModels: async () => [{ name: "VCRouter", vendor: "customendpoint", models: [{ id: "lesson" }] }],
    vsCodeRouteSettings: {
      async initializeNative() { return { changed: false }; },
      async publish() { return { changed: true }; },
      async restore() { if (failRestore) throw new Error("provider restore denied"); return { changed: true }; },
    },
  });
  await h.app.start();
  await h.app.redeem("OLD", "Student");
  await h.app.setSwitch("classroom", "vscode");
  failRestore = true;

  await h.app.redeem("NEW", "Student");

  assert.equal(h.app.view().connected, true);
  assert.equal(saved.vsCodeChat.mode, "native");
  assert.equal(h.app.view().clientRoutes?.vsCodeChat.mode, "native");
  assert.equal(h.app.view().clientRoutes?.vsCodeChat.health, "red");
});

it("stops the Codex listener only after restoring its Native settings", async () => {
  const events: string[] = [];
  const runtime: ClientRouteRuntime = {
    async start(route) { return { route, health: "green", origin: "http://127.0.0.1:47821" }; },
    async stop(route) { events.push(`stop:${route}`); },
  };
  const h = harness(undefined, {
    detectClient: async client => client === "codex",
    clientRouteRuntime: runtime,
    async setModelOptions(value) { if (value === null) events.push("restore"); },
  });
  await h.app.start();
  events.length = 0;

  await h.app.stop();

  assert.deepEqual(events, ["restore", "stop:codex", "stop:claudeCode", "stop:vsCodeChat"]);
});

it("republishes the saved Codex Classroom config and catalogs after orderly Stop and relaunch", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vanspod-codex-relaunch-"));
  const paths = {
    codex: path.join(root, "config.toml"),
    claude: path.join(root, "settings.json"),
    vsCode: path.join(root, "vscode.json"),
  };
  const storage = persistentStorageFake();
  let saved = {
    codex: { mode: "native" as "native" | "classroom", adapter: "responses" as const },
    claudeCode: { mode: "native" as const, adapter: "responses" as const },
    vsCodeChat: { mode: "native" as const, adapter: "responses" as const },
  };
  const clientRouteSettings: ClientRouteSettingsStorage = {
    async load() { return structuredClone(saved); },
    async save(next) { saved = structuredClone(next) as typeof saved; },
  };
  const runtime: ClientRouteRuntime = {
    async start(route) { return { route, health: "green", origin: PROXY }; },
    async stop() {},
  };
  const diskRoutes = createRouteFiles(paths);
  const routeWrite = async (value: ModelOptions | null) => diskRoutes.setCodexRoute(value ? {
    mode: "classroom",
    ids: value.ids,
    selectedModel: value.codexModel,
    proxyBaseUrl: value.proxyBaseUrl,
  } : { mode: "native", proxyBaseUrl: PROXY });
  try {
    await fs.writeFile(paths.codex, 'model = "personal"\n');
    const first = harness(undefined, { storage, clientRouteSettings, clientRouteRuntime: runtime, detectClient: async client => client === "codex", setModelOptions: routeWrite });
    await first.app.start();
    await first.app.redeem("DEMO", "Student");
    await first.app.setSwitch("classroom", "codex");
    assert.match(await fs.readFile(paths.codex, "utf8"), /model = "VCRouter\/second-looking-but-first"/);

    await first.app.stop();
    assert.match(await fs.readFile(paths.codex, "utf8"), /model = "personal"/);

    const restarted = harness(undefined, { storage, clientRouteSettings, clientRouteRuntime: runtime, detectClient: async client => client === "codex", setModelOptions: routeWrite });
    await restarted.app.start();

    const config = await fs.readFile(paths.codex, "utf8");
    const catalog = JSON.parse(await fs.readFile(path.join(root, "classroom-catalog.json"), "utf8"));
    const cache = JSON.parse(await fs.readFile(path.join(root, "models_cache.json"), "utf8"));
    assert.equal(restarted.app.view().clientRoutes?.codex.mode, "classroom");
    assert.match(config, /openai_base_url = "http:\/\/127\.0\.0\.1:47821\/v1"/);
    assert.match(config, /model_catalog_json/);
    assert.deepEqual(catalog.models.map((model: { slug: string }) => model.slug), ["VCRouter/second-looking-but-first", "VCRouter/later"]);
    assert.deepEqual(cache.models.map((model: { slug: string }) => model.slug), ["VCRouter/second-looking-but-first", "VCRouter/later"]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it("Stop restores separated routes without touching the retired combined Claude seam or adapter preferences", async () => {
  const stopped: string[] = [];
  const runtime: ClientRouteRuntime = {
    async start(route) {
      const port = route === "codex" ? 47821 : route === "claudeCode" ? 47822 : 47823;
      return { route, health: "green", origin: `http://127.0.0.1:${port}` };
    },
    async stop(route) { if (route) stopped.push(route); },
  };
  const h = harness(undefined, {
    detectClient: async () => true,
    clientRouteRuntime: runtime,
    vsCodeRouteSettings: {
      async initializeNative() { return { changed: false }; },
      async publish() { return { changed: true }; },
      async restore() { return { changed: true }; },
    },
  });
  await h.app.start();
  await h.app.setAdapter("codex", "chat");
  await h.app.setAdapter("claude", "messages");
  await h.app.setAdapter("vscode", "chat");
  await h.app.stop();

  assert.deepEqual(stopped, ["codex", "claudeCode", "vsCodeChat"]);
  assert.deepEqual({
    codex: h.app.view().clientRoutes?.codex.adapter,
    claudeCode: h.app.view().clientRoutes?.claudeCode.adapter,
    vsCodeChat: h.app.view().clientRoutes?.vsCodeChat.adapter,
  }, { codex: "chat", claudeCode: "messages", vsCodeChat: "chat" });
});

it("keeps a failed Claude Code listener red and Native without affecting Codex", async () => {
  const starts: string[] = [];
  const runtime: ClientRouteRuntime = {
    async start(route) {
      starts.push(route);
      return {
        route,
        health: route === "claudeCode" ? "red" : "green",
        origin: route === "claudeCode" ? "http://127.0.0.1:47822" : "http://127.0.0.1:47821",
      };
    },
    async stop() {},
  };
  const h = harness(undefined, {
    detectClient: async () => true,
    clientRouteRuntime: runtime,
  });

  await h.app.start();

  assert.deepEqual(starts, ["codex", "claudeCode", "vsCodeChat"]);
  assert.equal(h.app.view().clientRoutes?.codex.health, "green");
  assert.equal(h.app.view().clientRoutes?.claudeCode.health, "red");
  assert.equal(h.app.view().clientRoutes?.claudeCode.mode, "native");
  assert.equal(h.docs.claudeTerminal.ANTHROPIC_BASE_URL, undefined);
  assert.equal(h.docs.vsCode["claudeCode.environmentVariables"], undefined);
});

it("stops healthy routes while retaining a Claude listener whose Native restoration fails", async () => {
  const stopped: string[] = [];
  const runtime: ClientRouteRuntime = {
    async start(route) {
      return { route, health: "green", origin: route === "claudeCode" ? "http://127.0.0.1:47822" : "http://127.0.0.1:47821" };
    },
    async stop(route) { if (route) stopped.push(route); },
  };
  let failRestore = false;
  const h = harness(undefined, {
    detectClient: async () => true,
    clientRouteRuntime: runtime,
    async setClaudeCodeRoute(classroom) {
      if (!classroom && failRestore) throw new Error(`synthetic restore denial ${KEY}`);
    },
  });
  await h.app.start();
  await h.app.redeem("DEMO", "Student");
  failRestore = true;

  await assert.rejects(h.app.stop(), (error: unknown) => {
    assert.match(String(error), /synthetic restore denial/);
    assert.equal(String(error).includes(KEY), false);
    return true;
  });

  assert.deepEqual(stopped, ["codex", "vsCodeChat"]);
  assert.equal(h.app.view().clientRoutes?.claudeCode.health, "red");
  await assert.rejects(h.app.forward({ client: "claude", model: "later" }), (error: unknown) => {
    assert.match(String(error), /重開 Claude Code/);
    assert.equal(String(error).includes(KEY), false);
    return true;
  });
  assert.deepEqual(h.sent(), []);
});

it("switches Claude Code independently, supports all three adapters, and rejects stale or disallowed requests", async () => {
  let saved = {
    codex: { mode: "native" as const, adapter: "responses" as const },
    claudeCode: { mode: "native" as "native" | "classroom", adapter: "responses" as "responses" | "chat" | "messages" },
    vsCodeChat: { mode: "native" as const, adapter: "responses" as const },
  };
  const runtime: ClientRouteRuntime = {
    async start(route) {
      return { route, health: "green", origin: route === "claudeCode" ? "http://127.0.0.1:47822" : "http://127.0.0.1:47821" };
    },
    async stop() {},
  };
  const h = harness(undefined, {
    detectClient: async client => client === "claude",
    clientRouteRuntime: runtime,
    clientRouteSettings: {
      async load() { return structuredClone(saved); },
      async save(next) { saved = structuredClone(next) as typeof saved; },
    },
  });
  await h.app.start();
  await assert.rejects(h.app.forward({ client: "claude", model: "personal" }), /重開 Claude Code/);
  await h.app.redeem("DEMO", "Student");

  await h.app.setAdapter("claude", "messages");
  await h.app.setSwitch("classroom", "claude");

  assert.equal(saved.claudeCode.mode, "classroom");
  assert.equal(saved.claudeCode.adapter, "messages");
  assert.equal(h.app.view().clientRoutes?.claudeCode.health, "yellow");
  assert.equal(h.docs.claudeTerminal.ANTHROPIC_BASE_URL, "http://127.0.0.1:47822");
  assert.equal(h.docs.vsCode["claudeCode.environmentVariables"], undefined);
  await assert.rejects(h.app.forward({ client: "claude", model: "not-allowed" }), /不在課堂允許清單/);
  await h.app.forward({ client: "claude", model: "later" });
  assert.equal(h.sent().at(-1)?.adapter, "messages");
  assert.equal(h.app.view().clientRoutes?.claudeCode.health, "green");

  await h.app.setAdapter("claude", "chat");
  assert.equal(h.app.view().clientRoutes?.claudeCode.health, "yellow");
  await h.app.setSwitch("native", "claude");
  assert.equal(h.app.view().clientRoutes?.claudeCode.health, "green");
  assert.equal(h.docs.claudeTerminal.ANTHROPIC_BASE_URL, undefined);
  await assert.rejects(h.app.forward({ client: "claude", model: "later" }), /重開 Claude Code/);
});

it("switching adapters leaves an ongoing send unchanged and applies to the next request", async () => {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const choices: string[] = [];
  const h = harness(undefined, { async send(upstream) { choices.push(upstream.adapter ?? "native"); if (choices.length === 1) { entered(); await gate; } } });
  await h.app.start(); await h.app.redeem("DEMO", "Student"); await h.app.setSwitch("classroom");
  const ongoing = h.app.forward({ client: "codex", model: "later" }); await started;
  await h.app.setAdapter("codex", "chat");
  await h.app.forward({ client: "codex", model: "later" }); release(); await ongoing;
  assert.deepEqual(choices, ["responses", "chat"]);
});

it("simultaneous route traffic keeps each route model and adapter snapshot across Reload", async () => {
  let ids = ["shared"];
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const allSending = new Promise<void>(resolve => { entered = resolve; });
  let active = 0;
  const runtime: ClientRouteRuntime = {
    async start(route) {
      const port = route === "claudeCode" ? 47822 : route === "vsCodeChat" ? 47823 : 47821;
      return { route, health: "green", origin: `http://127.0.0.1:${port}` };
    },
    current(route) {
      const port = route === "claudeCode" ? 47822 : route === "vsCodeChat" ? 47823 : 47821;
      return { route, health: "green", origin: `http://127.0.0.1:${port}` };
    },
    async stop() {},
  };
  const h = harness(undefined, {
    detectClient: async () => true,
    clientRouteRuntime: runtime,
    sessionModels: async () => [{ name: "VCRouter", models: ids.map(id => ({ id })) }],
    send: async () => { active += 1; if (active === 3) entered(); await gate; },
    vsCodeRouteSettings: {
      async initializeNative() { return { changed: false }; },
      async publish() { return { changed: true }; },
      async restore() { return { changed: true }; },
    },
  });
  await h.app.start();
  await h.app.redeem("DEMO", "Student");
  await h.app.setAdapter("codex", "chat");
  await h.app.setAdapter("claude", "messages");
  await h.app.setAdapter("vscode", "chat");
  await h.app.setSwitch("classroom", "codex");
  await h.app.setSwitch("classroom", "claude");
  await h.app.setSwitch("classroom", "vscode");

  const requests = [
    h.app.forward({ client: "codex", model: "shared" }),
    h.app.forward({ client: "claude", model: "shared" }),
    h.app.forward({ client: "copilot", model: "shared" }),
  ];
  await allSending;
  ids = ["next"];
  await h.app.reloadAllowlist();

  assert.deepEqual(h.sent().map(({ client, model, adapter }) => ({ client, model, adapter })), [
    { client: "codex", model: "shared", adapter: "chat" },
    { client: "claude", model: "shared", adapter: "messages" },
    { client: "copilot", model: "shared", adapter: "chat" },
  ]);
  for (const client of ["codex", "claude", "copilot"] as const) {
    await assert.rejects(h.app.forward({ client, model: "shared" }), /shared.*不在課堂允許清單/);
  }
  release();
  await Promise.all(requests);
});

it("failed adapter persistence keeps the old preference and shows a safe notice", async () => {
  const h = harness(undefined, { adapterSettings: { async load() { return { codex: "responses", claude: "responses" }; }, async save() { throw new Error(KEY); } } });
  await h.app.start(); await h.app.redeem("DEMO", "Student"); await h.app.setSwitch("classroom"); await h.app.setAdapter("codex", "chat");
  assert.deepEqual(h.app.view().adapters, { codex: "responses", claude: "responses" });
  assert.match(h.app.view().adapterNotice ?? "", /無法儲存/);
  assert.doesNotMatch(renderPage(h.app.view()), /vcr_sk_nick/);
});

describe("VansPod redeem", () => {
  it("does not redeem when the invite code is blank after trim", async () => {
    const { app, redeemCalls, modelKeys } = harness();
    await app.redeem("   ", "Ada");
    assert.equal(redeemCalls.length, 0);
    assert.deepEqual(modelKeys, []);
    assert.equal(app.view().connected, false);
    assert.equal(app.view().canCopyKey, false);
    assert.equal(JSON.stringify(app.view()).includes(KEY), false);
  });

  it("does not redeem when the nickname is blank after trim", async () => {
    const { app, redeemCalls, modelKeys } = harness();
    await app.redeem("ABC12345", " \n\t ");
    assert.equal(redeemCalls.length, 0);
    assert.deepEqual(modelKeys, []);
    assert.equal(app.view().connected, false);
    assert.equal(app.view().canCopyKey, false);
  });

  it("shows Class Label after redeem and keeps the key out of the view", async () => {
    const { app, redeemCalls, storedKey } = harness();
    await app.redeem("  ABC12345 ", " Ada ");
    assert.deepEqual(redeemCalls, [
      { invite_code: "ABC12345", nickname: "Ada" },
    ]);
    const view = app.view();
    assert.equal(view.connected, true);
    assert.equal(view.classLabel, "Demo · Week 1");
    assert.equal(view.nickname, "Ada");
    assert.equal(view.courseTitle, "Demo");
    assert.equal(view.sessionTitle, "Week 1");
    assert.equal(view.detail, "Classroom API Key 已設定。");
    assert.equal(view.connectionNotice, view.notice);
    assert.equal(view.canCopyKey, true);
    assert.equal(view.connectionNotice, view.notice);
    assert.equal(await storedKey(), KEY);
    assert.equal(JSON.stringify(view).includes(KEY), false);
  });

  it("uses only the session name when class name is absent", async () => {
    const { app } = harness({ name: "Week 1" });
    await app.redeem("ABC12345", "Ada");
    assert.equal(app.view().classLabel, "Week 1");
    assert.equal(JSON.stringify(app.view()).includes(KEY), false);
  });

  it("stays disconnected when redeem fails and does not keep the key", async () => {
    const options: { redeemError?: Error } = {
      redeemError: new Error(`router said ${KEY}`),
    };
    const { app, redeemCalls, storedKey } = harness(undefined, options);
    await app.redeem("ABC12345", "Ada");
    assert.equal(redeemCalls.length, 1);
    assert.equal(app.view().connected, false);
    assert.equal(app.view().canCopyKey, false);
    assert.equal(app.view().classLabel, undefined);
    assert.equal(await storedKey(), undefined);
    assert.equal(JSON.stringify(app.view()).includes(KEY), false);
    assert.equal(app.view().detail, "");
    assert.equal(app.view().connectionError, "連線失敗，請確認邀請碼與課堂暱稱後再試。");
    assert.deepEqual(app.view().connectionDraft, { inviteCode: "ABC12345", nickname: "Ada" });
    const html = renderPage(app.view());
    const card = html.match(/<section class="tile settings-card" data-setting="連線">([\s\S]*?)<\/section>/)?.[1] ?? "";
    assert.match(card, /class="connection-error" role="alert"/);
    assert.match(card, /value="ABC12345"/);
    assert.match(card, /value="Ada"/);
    assert.equal(card.indexOf('name="nickname"') < card.indexOf('class="connection-error"'), true);
    assert.equal(card.indexOf('class="connection-error"') < card.indexOf('class="settings-actions"'), true);
    assert.equal(html.split(app.view().connectionError!).length - 1, 1);
    options.redeemError = undefined;
    await app.redeem("ABC12345", "Ada");
    assert.equal(app.view().connected, true);
    assert.equal(app.view().connectionError, undefined);
    assert.equal(app.view().connectionDraft, undefined);
    assert.equal(renderPage(app.view()).includes('class="connection-error"'), false);
  });
});

describe("Copy Classroom API Key", () => {
  it("does not read or forward unreadable saved credentials after startup rejects the connection", async () => {
    const storage: ConnectionStorage = {
      async getConnection() { throw new Error(`unreadable ${KEY}`); },
      async setConnection() { throw new Error("unused"); },
      async clearConnection() {},
    };
    const h = harness(undefined, { storage });
    await h.app.start();
    await h.app.copyKey();
    await h.app.reloadAllowlist();
    assert.equal(h.app.view().canCopyKey, false);
    assert.equal(h.clipboardWrites(), 0);
    assert.equal(renderPage(h.app.view()).includes(KEY), false);
    await assert.rejects(h.app.forward({ client: "copilot", model: "later" }), /沒有上課模型/);
    assert.deepEqual(h.sent(), []);
    await h.app.forward({ client: "codex", model: "later" });
    assert.equal(h.sent().at(-1)?.target, "chatgpt");
    assert.equal(h.sent().at(-1)?.apiKey, undefined);
  });
  it("copies the stored key and tells the student not to share it", async () => {
    const { app, clipboard } = harness();
    await app.redeem("ABC12345", "Ada");
    await app.copyKey();
    assert.equal(clipboard(), KEY);
    const view = app.view();
    assert.equal(
      view.notice,
      "已複製 Classroom API Key。請勿分享給不信任的人。",
    );
    assert.equal(view.detail, "Classroom API Key 已設定。");
    assert.equal(JSON.stringify(view).includes(KEY), false);
  });

  it("reports copy failure without echoing the key", async () => {
    const { app, clipboard, failClipboard } = harness();
    await app.redeem("ABC12345", "Ada");
    failClipboard(new Error(`clipboard down ${KEY}`));
    await app.copyKey();
    assert.equal(clipboard(), "");
    const view = app.view();
    assert.equal(
      view.notice,
      "無法複製 Classroom API Key。請重新連線後再試。",
    );
    assert.equal(view.canCopyKey, true);
    assert.equal(view.classLabel, "Demo · Week 1");
    assert.equal(JSON.stringify(view).includes(KEY), false);
  });

  it("does not copy when the student is not connected", async () => {
    const { app, clipboard } = harness();
    await app.copyKey();
    assert.equal(clipboard(), "");
    assert.equal(
      app.view().notice,
      "無法複製 Classroom API Key。請重新連線後再試。",
    );
    assert.equal(app.view().canCopyKey, false);
  });
});

describe("Clear Classroom Connection", () => {
  for (const persistence of ["temporary", "persistent"] as const) {
    it(`clears the entire ${persistence} connection across restart while preserving client settings and the running proxy`, async () => {
      const retained = createConnectionStorage(createMemorySecureStorage());
      const storage: ConnectionStorage = {
        getConnection: () => retained.getConnection(),
        async setConnection(value) { await retained.setConnection(value); return { persistence }; },
        clearConnection: () => retained.clearConnection(),
      };
      const personalProvider = { name: "PersonalProvider", apiKey: "personal-key", models: [{ id: "personal-model" }] };
      const h = harness(undefined, { storage, codex: { personal: "codex-personal" }, claudeTerminal: { PERSONAL: "claude-personal" }, vsCode: { personal: "vscode-personal" }, providers: [personalProvider], async write() { throw new Error("Workspace MCP Config must remain untouched"); } });
      await h.app.redeem("invite", "Student");
      await h.app.start();
      await h.app.setSwitch("classroom");
      await h.app.clearConnection();
      const view = h.app.view();
      assert.equal(view.connected, false);
      assert.equal(view.classLabel, undefined);
      assert.equal(view.nickname, undefined);
      assert.equal(view.catalog, undefined);
      assert.equal(view.modelId, undefined);
      assert.equal(view.mode, "native");
      assert.equal(view.canCopyKey, false);
      assert.equal(h.modelOptions(), null);
      assert.equal(h.proxyStops(), 0);
      await h.app.copyKey();
      assert.equal(h.clipboardWrites(), 0);
      await h.app.forward({ client: "codex", model: "later" });
      assert.equal(h.sent().at(-1)?.target, "chatgpt");
      assert.equal(h.sent().at(-1)?.apiKey, undefined);
      await h.app.forward({ client: "claude", model: "later" });
      assert.equal(h.sent().at(-1)?.target, "claude.ai");
      assert.equal(h.sent().at(-1)?.apiKey, undefined);
      await assert.rejects(h.app.forward({ client: "copilot", model: "later" }), /沒有上課模型/);
      assert.equal(h.docs.codex.personal, "codex-personal");
      assert.equal(h.docs.claudeTerminal.PERSONAL, "claude-personal");
      assert.equal(h.docs.vsCode.personal, "vscode-personal");
      assert.deepEqual(h.copilotProviders().find(p => p.name === "PersonalProvider"), personalProvider);
      const restarted = harness(undefined, { storage });
      await restarted.app.start();
      assert.equal(restarted.app.view().connected, false);
      assert.equal(restarted.app.view().mode, "native");
      assert.equal(restarted.app.view().canCopyKey, false);
    });
  }
  it("stays disconnected and Native when client model restoration fails after credential deletion", async () => {
    let fail = false;
    const h = harness(undefined, { async setModelOptions(value) { if (fail && !value) throw new Error(`route failed ${KEY}`); } });
    await h.app.redeem("invite", "Student");
    await h.app.start();
    await h.app.setSwitch("classroom");
    fail = true;
    await h.app.clearConnection();
    const view = h.app.view();
    assert.equal(view.connected, false);
    assert.equal(view.mode, "native");
    assert.equal(view.canCopyKey, false);
    assert.equal(await h.storedConnection(), undefined);
    assert.match(view.notice ?? "", /已清除.*Native.*稍後/);
    assert.equal(renderPage(view).includes(KEY), false);
    await h.app.forward({ client: "codex", model: "later" });
    assert.equal(h.sent().at(-1)?.target, "chatgpt");
    assert.equal(h.sent().at(-1)?.apiKey, undefined);
  });
  it("reports failed persistent clear without hiding the retained identity or restart behavior", async () => {
    const retained = createConnectionStorage(createMemorySecureStorage());
    await retained.setConnection({ version: 1, apiKey: KEY, session: { class_name: "Saved", name: "Lesson" }, nickname: "Student", mode: "classroom" });
    const storage: ConnectionStorage = {
      getConnection: () => retained.getConnection(),
      setConnection: connection => retained.setConnection(connection),
      async clearConnection() { throw new Error(`delete failed ${KEY}`); },
    };
    const h = harness(undefined, { storage });
    await h.app.start();
    const catalog = h.app.view().catalog;
    await h.app.clearConnection();
    const view = h.app.view();
    assert.equal(view.connected, true);
    assert.equal(view.classLabel, "Saved · Lesson");
    assert.equal(view.nickname, "Student");
    assert.equal(view.mode, "classroom");
    assert.deepEqual(view.catalog, catalog);
    assert.equal(view.canCopyKey, true);
    assert.match(view.notice ?? "", /無法清除.*重新啟動/);
    assert.equal(renderPage(view).includes(KEY), false);
    await h.app.copyKey();
    assert.equal(h.clipboard(), KEY);
    await h.app.forward({ client: "codex", model: "later" });
    assert.equal(h.sent().at(-1)?.apiKey, KEY);
    assert.equal(h.sent().at(-1)?.target, "router");
    const restarted = harness(undefined, { storage });
    await restarted.app.start();
    assert.equal(restarted.app.view().classLabel, "Saved · Lesson");
    assert.equal(restarted.app.view().mode, "classroom");
  });
  it("removes the copy entry and Class Label", async () => {
    const { app, storedKey, clipboardWrites } = harness();
    await app.redeem("ABC12345", "Ada");
    await app.copyKey();
    assert.equal(clipboardWrites(), 1);
    await app.clearConnection();
    const view = app.view();
    assert.equal(view.connected, false);
    assert.equal(view.canCopyKey, false);
    assert.equal(view.classLabel, undefined);
    assert.equal(view.nickname, undefined);
    assert.equal(view.courseTitle, undefined);
    assert.equal(view.sessionTitle, undefined);
    assert.equal(view.notice, undefined);
    assert.equal(await storedKey(), undefined);
    assert.equal(view.catalog, undefined);
    assert.equal(JSON.stringify(view).includes(KEY), false);
    await app.copyKey();
    assert.equal(clipboardWrites(), 1);
    assert.equal(app.view().canCopyKey, false);
    assert.equal(JSON.stringify(app.view()).includes(KEY), false);
  });

  it("returns the switch to Native and drops the copy entry", async () => {
    const { app, storedKey, clipboardWrites } = harness();
    await app.redeem("ABC12345", "Ada");
    await app.setSwitch("classroom");
    await app.clearConnection();
    const view = app.view();
    assert.equal(view.mode, "native");
    assert.equal(view.modelId, undefined);
    assert.equal(view.canCopyKey, false);
    assert.equal(view.classLabel, undefined);
    assert.equal(view.notice, undefined);
    assert.equal(await storedKey(), undefined);
    assert.equal(JSON.stringify(view).includes(KEY), false);
    await app.copyKey();
    assert.equal(clipboardWrites(), 0);
    await app.setSwitch("classroom");
    assert.equal(app.view().mode, "native");
  });
});

describe("Model Switch", () => {
  it("shows a model reminder only after a successful change, not startup or an unavailable switch", async () => {
    const { app } = harness();
    await app.start();
    assert.equal(app.view().modelRestart, undefined);
    await app.setSwitch("classroom");
    assert.equal(app.view().modelRestart, undefined);
    await app.redeem("ABC12345", "Ada");
    assert.equal(app.view().modelRestart, undefined);
    await app.setSwitch("classroom");
    assert.deepEqual(app.view().modelRestart, ["codex", "claude"]);
  });
  it("uses one mode for both Codex and Claude Code, selecting the first returned id", async () => {
    const { app, modelKeys } = harness();
    await app.redeem("ABC12345", "Ada");
    assert.equal(app.view().mode, "native");
    assert.deepEqual(modelKeys, [KEY]);
    await app.setSwitch("classroom");
    assert.deepEqual(modelKeys, [KEY]);
    const view = app.view();
    assert.equal(view.mode, "classroom");
    assert.equal(view.modelId, "second-looking-but-first");
    assert.equal("codex" in view, false);
    assert.equal("claude" in view, false);
    assert.equal(JSON.stringify(view).includes(KEY), false);
  });

  it("stays Native when the allowlist is explicitly empty", async () => {
    const { app, modelKeys } = harness(undefined, {
      async sessionModels() {
        return [];
      },
    });
    await app.redeem("ABC12345", "Ada");
    await app.setSwitch("classroom");
    assert.equal(app.view().mode, "native");
    assert.equal(app.view().modelId, undefined);
    assert.deepEqual(modelKeys, [KEY]);
  });

  it("stays Native when there is no Classroom API Key", async () => {
    const { app, modelKeys } = harness();
    await app.setSwitch("classroom");
    assert.equal(app.view().mode, "native");
    assert.equal(app.view().modelId, undefined);
    assert.deepEqual(modelKeys, []);
  });

  it("returns to Native when the new session allowlist is explicitly empty", async () => {
    let call = 0;
    const { app } = harness(undefined, {
      async sessionModels() {
        call += 1;
        if (call === 1) {
          return ["second-looking-but-first", "later"];
        }
        return [];
      },
    });
    await app.redeem("ABC12345", "Ada");
    await app.setSwitch("classroom");
    await app.redeem("ABC12345", "Ada");
    assert.equal(app.view().mode, "native");
    assert.equal(app.view().modelId, undefined);
    assert.equal(JSON.stringify(app.view()).includes(KEY), false);
  });

  it("replaces the selected id with the new session's first id", async () => {
    let call = 0;
    const { app } = harness(undefined, {
      async sessionModels(apiKey) {
        assert.equal(apiKey, KEY);
        call += 1;
        if (call === 1) {
          return ["second-looking-but-first", "later"];
        }
        return ["fresh-session-first", "tail"];
      },
    });
    await app.redeem("ABC12345", "Ada");
    await app.setSwitch("classroom");
    await app.redeem("ABC12345", "Ada");
    assert.equal(app.view().mode, "classroom");
    assert.equal(app.view().modelId, "fresh-session-first");
  });

  it("sends an allowlist id the client picked and explicitly rejects foreign ids", async () => {
    const { app } = harness();
    await app.redeem("ABC12345", "Ada");
    await app.start();
    await app.setSwitch("classroom");
    const picked = await app.forward({ client: "codex", model: "later" });
    assert.equal(picked.model, "later");
    await assert.rejects(
      app.forward({ client: "claude", model: "claude-incoming" }),
      /claude-incoming.*不在課堂允許清單/,
    );
    await app.forward({ client: "claude", model: "later" });
    assert.equal(app.view().notice, undefined);
  });

  it("keeps a client on an id that survives the new allowlist", async () => {
    let call = 0;
    const { app } = harness(undefined, {
      async sessionModels() {
        call += 1;
        if (call === 1) {
          return ["second-looking-but-first", "later"];
        }
        return ["fresh", "later", "second-looking-but-first"];
      },
    });
    await app.redeem("ABC12345", "Ada");
    await app.start();
    await app.setSwitch("classroom");
    await app.forward({ client: "codex", model: "later" });
    await app.reloadAllowlist();
    assert.equal(app.view().notice, undefined);
    assert.equal(app.view().modelId, "fresh");
    const kept = await app.forward({ client: "codex", model: "later" });
    assert.equal(kept.model, "later");
  });

  it("rejects an id as soon as Reload removes it from the allowlist", async () => {
    let call = 0;
    const { app } = harness(undefined, {
      async sessionModels() {
        call += 1;
        if (call === 1) {
          return ["second-looking-but-first", "later"];
        }
        return ["fresh"];
      },
    });
    await app.redeem("ABC12345", "Ada");
    await app.start();
    await app.setSwitch("classroom");
    await app.forward({ client: "codex", model: "later" });
    await app.reloadAllowlist();
    assert.equal(app.view().notice, undefined);
    assert.equal(app.view().modelId, "fresh");
    await app.reloadAllowlist();
    await assert.rejects(app.forward({ client: "codex", model: "later" }), /later.*不在課堂允許清單/);
    await app.forward({ client: "codex", model: "fresh" });
    await app.forward({ client: "claude", model: "fresh" });
    await app.forward({ client: "copilot", model: "fresh" });
    assert.equal(app.view().notice, undefined);
  });

  it("never substitutes invalid ids across Reload or mode switches", async () => {
    let call = 0;
    const { app } = harness(undefined, {
      async sessionModels() {
        call += 1;
        if (call === 1) {
          return ["second-looking-but-first", "later"];
        }
        return ["second-looking-but-first", "later", "extra"];
      },
    });
    await app.redeem("ABC12345", "Ada");
    await app.start();
    await app.setSwitch("classroom");
    await assert.rejects(app.forward({ client: "codex", model: "gpt-incoming" }), /gpt-incoming.*不在課堂允許清單/);
    assert.equal(app.view().notice, undefined);
    await app.reloadAllowlist();
    assert.equal(app.view().notice, undefined);
    await assert.rejects(app.forward({ client: "claude", model: "gpt-incoming" }), /gpt-incoming.*不在課堂允許清單/);
    await app.setSwitch("native");
    assert.equal(app.view().notice, undefined);
    await app.setSwitch("classroom");
    const picked = await app.forward({ client: "codex", model: "later" });
    assert.equal(picked.model, "later");
  });

  it("keeps the previous Classroom id when reload throws", async () => {
    let fail = false;
    const { app } = harness(undefined, {
      async sessionModels() {
        if (fail) {
          throw new Error("refetch failed, template-fallback-id");
        }
        return ["second-looking-but-first", "later"];
      },
    });
    await app.redeem("ABC12345", "Ada");
    await app.setSwitch("classroom");
    fail = true;
    await app.reloadAllowlist();
    const view = app.view();
    assert.equal(view.mode, "classroom");
    assert.equal(view.modelId, "second-looking-but-first");
    assert.equal(JSON.stringify(view).includes("template-fallback-id"), false);
  });

  it("does not keep a third-party base URL when returning to Native", async () => {
    const { app } = harness();
    await app.redeem("ABC12345", "Ada");
    await app.setSwitch("classroom");
    await app.setSwitch("native");
    const view = app.view();
    assert.equal(view.mode, "native");
    assert.equal(view.modelId, undefined);
    assert.equal(view.connected, true);
    const serialized = JSON.stringify(view);
    assert.equal(serialized.includes("openai_base_url"), false);
    assert.equal(serialized.includes("ANTHROPIC_BASE_URL"), false);
    assert.equal(serialized.includes("http"), false);
    assert.equal(serialized.includes(KEY), false);
  });
});

describe("Course Catalog after redeem", () => {
  it("shows remote actions and snippets using the stored Classroom API Key", async () => {
    const { app, catalogKeys, storedKey, fileReads } = harness();
    await app.redeem("ABC12345", "Ada");
    assert.deepEqual(catalogKeys, [KEY]);
    assert.equal(catalogKeys[0], await storedKey());
    const view = app.view();
    assert.equal(view.catalog?.source, "remote");
    assert.deepEqual(view.catalog?.actions, [
      {
        id: "demo",
        title: "安裝 demo",
        kind: "package",
        description: "從課堂清單安裝",
        command: "uv add demo",
      },
    ]);
    assert.deepEqual(view.catalog?.snippets, [
      {
        id: "stub",
        title: "骨架",
        pasteHint: "main.py",
        body: "print(1)\n",
      },
    ]);
    assert.equal(view.catalog?.localNote, undefined);
    assert.equal(fileReads.length, 0);
    assert.equal(JSON.stringify(view).includes(KEY), false);
  });

  it("keeps snippet body whitespace and does not read a project file", async () => {
    const { app, fileReads } = harness(undefined, {
      catalogYaml: `
actions:
  - id: demo
    title: Demo
    kind: skill
    command: echo hi
snippets:
  - id: stub
    title: 骨架
    paste_hint: mcp_client.py
    body: "  keep  \\n"
`,
    });
    await app.redeem("ABC12345", "Ada");
    const snippet = app.view().catalog?.snippets?.[0];
    assert.equal(snippet?.body, "  keep  \n");
    assert.equal(snippet?.pasteHint, "mcp_client.py");
    assert.equal(fileReads.length, 0);
    assert.equal(JSON.stringify(app.view()).includes(KEY), false);
  });

  it("omits the snippet region when snippets are missing or empty", async () => {
    const missing = harness(undefined, {
      catalogYaml: `
actions:
  - id: demo
    title: Demo
    kind: skill
    command: echo hi
`,
    });
    await missing.app.redeem("ABC12345", "Ada");
    assert.equal(missing.app.view().catalog?.actions.length, 1);
    assert.equal(missing.app.view().catalog?.snippets, undefined);
    assert.equal(
      Object.hasOwn(missing.app.view().catalog ?? {}, "snippets"),
      false,
    );

    const empty = harness(undefined, {
      catalogYaml: "actions: []\nsnippets: []\n",
    });
    await empty.app.redeem("ABC12345", "Ada");
    assert.deepEqual(empty.app.view().catalog?.actions, []);
    assert.equal(empty.app.view().catalog?.snippets, undefined);
    assert.equal(
      Object.hasOwn(empty.app.view().catalog ?? {}, "snippets"),
      false,
    );
  });

  it("keeps an empty remote action list and does not read the local file", async () => {
    const { app, fileReads } = harness(undefined, {
      catalogYaml: "actions: []\n",
      files: {
        "D:\\lesson": `
actions:
  - id: local
    title: Should Not Load
    kind: skill
    command: echo local
`,
      },
    });
    await app.redeem("ABC12345", "Ada");
    await app.setProjectFolder("D:\\lesson");
    const view = app.view();
    assert.equal(view.catalog?.source, "remote");
    assert.deepEqual(view.catalog?.actions, []);
    assert.equal(view.catalog?.snippets, undefined);
    assert.equal(view.catalog?.localNote, undefined);
    assert.equal(JSON.stringify(view).includes("Should Not Load"), false);
    assert.deepEqual(fileReads, []);
  });

  it("reads classroom-installs.yaml when remote fetch throws and a Project Folder is set", async () => {
    const { app, fileReads } = harness(undefined, {
      catalogError: new Error("network down"),
      files: {
        "D:\\lesson": `
actions:
  - id: local
    title: 本機動作
    kind: mcp
    command: echo local
`,
      },
    });
    await app.setProjectFolder("D:\\lesson");
    await app.redeem("ABC12345", "Ada");
    const view = app.view();
    assert.equal(view.catalog?.source, "local");
    assert.equal(view.catalog?.localNote, "這是本機清單。");
    assert.equal(view.catalog?.actions[0]?.title, "本機動作");
    assert.equal(view.catalog?.actions[0]?.kind, "mcp");
    assert.equal(view.catalog?.snippets, undefined);
    assert.equal(view.installAvailable, true);
    assert.deepEqual(fileReads, ["D:\\lesson"]);
    assert.equal(JSON.stringify(view).includes(KEY), false);
  });

  it("reads the local file when the remote body has no YAML string", async () => {
    const { app, fileReads } = harness(undefined, {
      catalogBody: { course_catalog_yaml: null },
      files: {
        "D:\\lesson": `
actions:
  - id: local
    title: 本機動作
    kind: skill
    command: echo local
`,
      },
    });
    await app.setProjectFolder("D:\\lesson");
    await app.redeem("ABC12345", "Ada");
    assert.equal(app.view().catalog?.source, "local");
    assert.equal(app.view().catalog?.localNote, "這是本機清單。");
    assert.equal(app.view().catalog?.actions[0]?.title, "本機動作");
    assert.deepEqual(fileReads, ["D:\\lesson"]);
  });

  it("falls back to the local file when the remote catalog is illegal", async () => {
    const { app, fileReads } = harness(undefined, {
      catalogYaml: `
actions:
  - id: partial
    title: Partial Action
    kind: skill
    command: echo hi
snippets:
  - id: stub
    title: A
    body: a
  - id: stub
    title: B
    body: b
`,
      files: {
        "D:\\lesson": `
actions:
  - id: local
    title: Local Only
    kind: skill
    command: echo local
`,
      },
    });
    await app.setProjectFolder("D:\\lesson");
    await app.redeem("ABC12345", "Ada");
    const view = app.view();
    assert.equal(view.connected, true);
    assert.equal(view.catalog?.source, "local");
    assert.equal(view.catalog?.localNote, "這是本機清單。");
    assert.equal(view.catalog?.actions[0]?.title, "Local Only");
    assert.equal(view.catalogError, undefined);
    assert.equal(JSON.stringify(view).includes("Partial Action"), false);
    assert.deepEqual(fileReads, ["D:\\lesson"]);
  });

  it("fails the whole catalog when the remote and local files are both illegal", async () => {
    const { app } = harness(undefined, {
      catalogYaml: `
actions:
  - id: partial
    title: Partial Action
    kind: nope
    command: echo hi
`,
      files: {
        "D:\\lesson": `
actions:
  - id: local
    title: Local Partial
    kind: skill
    command: echo local
snippets:
  - id: stub
    title: A
    body: a
  - id: stub
    title: B
    body: b
`,
      },
    });
    await app.setProjectFolder("D:\\lesson");
    await app.redeem("ABC12345", "Ada");
    const view = app.view();
    assert.equal(view.catalog, undefined);
    assert.equal(typeof view.catalogError, "string");
    assert.equal(JSON.stringify(view).includes("Partial Action"), false);
    assert.equal(JSON.stringify(view).includes("Local Partial"), false);
  });

  it("fails the whole catalog when the remote YAML does not parse and the local file is missing", async () => {
    const { app, fileReads } = harness(undefined, {
      catalogYaml: "[\n",
      files: {},
    });
    await app.setProjectFolder("D:\\lesson");
    await app.redeem("ABC12345", "Ada");
    const view = app.view();
    assert.equal(view.catalog, undefined);
    assert.equal(view.catalogError, "找不到 classroom-installs.yaml");
    assert.equal(JSON.stringify(view).includes("actions"), false);
    assert.deepEqual(fileReads, ["D:\\lesson"]);
  });

  it("reads the local file when the remote YAML string is empty", async () => {
    const { app, fileReads } = harness(undefined, {
      catalogYaml: "",
      files: {
        "D:\\lesson": `
actions:
  - id: local
    title: Local Only
    kind: skill
    command: echo local
`,
      },
    });
    await app.setProjectFolder("D:\\lesson");
    await app.redeem("ABC12345", "Ada");
    assert.equal(app.view().catalog?.source, "local");
    assert.equal(app.view().catalog?.actions[0]?.title, "Local Only");
    assert.equal(app.view().catalog?.localNote, "這是本機清單。");
    assert.deepEqual(fileReads, ["D:\\lesson"]);
  });

  it("reloadCatalog fetches the remote catalog again after a held remote list", async () => {
    let yaml = "actions: []\n";
    const { app, fileReads, catalogKeys } = harness(undefined, {
      get catalogYaml() {
        return yaml;
      },
      files: {
        "D:\\lesson": `
actions:
  - id: local
    title: Local Only
    kind: skill
    command: echo local
`,
      },
    });
    await app.setProjectFolder("D:\\lesson");
    await app.redeem("ABC12345", "Ada");
    assert.equal(app.view().catalog?.source, "remote");
    assert.deepEqual(app.view().catalog?.actions, []);
    assert.deepEqual(fileReads, []);
    yaml = `
actions:
  - id: next
    title: Reloaded
    kind: package
    command: echo next
`;
    await app.setProjectFolder("D:\\other");
    assert.equal(app.view().projectFolder, "D:\\other");
    assert.equal(app.view().catalog?.source, "remote");
    assert.deepEqual(app.view().catalog?.actions, []);
    await app.reloadCatalog();
    assert.equal(app.view().catalog?.source, "remote");
    assert.equal(app.view().catalog?.actions[0]?.title, "Reloaded");
    assert.equal(app.view().catalog?.localNote, undefined);
    assert.deepEqual(fileReads, []);
    assert.equal(catalogKeys.length, 2);
    assert.equal(JSON.stringify(app.view()).includes(KEY), false);
  });

  it("loads the remote catalog without a Project Folder and does not read a local file", async () => {
    const { app, fileReads } = harness(undefined, {
      files: {
        "D:\\lesson": `
actions:
  - id: local
    title: Local Only
    kind: skill
    command: echo local
`,
      },
    });
    await app.redeem("ABC12345", "Ada");
    const view = app.view();
    assert.equal(view.catalog?.source, "remote");
    assert.equal(view.catalog?.actions[0]?.title, "安裝 demo");
    assert.equal(view.projectFolder, undefined);
    assert.equal(view.installAvailable, false);
    assert.equal(view.installNotice, "尚未指定專案資料夾，安裝不可用。");
    assert.deepEqual(fileReads, []);
    assert.equal(JSON.stringify(view).includes(KEY), false);
  });

  it("does not read a local file when remote fetch throws and no Project Folder is set", async () => {
    const { app, fileReads } = harness(undefined, {
      catalogError: new Error("network down"),
      files: {
        "D:\\somewhere": `
actions:
  - id: local
    title: Local Only
    kind: skill
    command: echo local
`,
      },
    });
    await app.redeem("ABC12345", "Ada");
    const view = app.view();
    assert.equal(view.connected, true);
    assert.equal(view.catalog, undefined);
    assert.equal(view.installAvailable, false);
    assert.equal(view.installNotice, "尚未指定專案資料夾，安裝不可用。");
    assert.equal(JSON.stringify(view).includes("Local Only"), false);
    assert.deepEqual(fileReads, []);
  });

  it("replaces the Project Folder and reads the new local list", async () => {
    const { app, fileReads } = harness(undefined, {
      catalogError: new Error("network down"),
      files: {
        "D:\\one": `
actions:
  - id: a
    title: From A
    kind: package
    command: echo a
`,
        "D:\\two": `
actions:
  - id: b
    title: From B
    kind: skill
    command: echo b
`,
      },
    });
    await app.setProjectFolder("D:\\one");
    await app.redeem("ABC12345", "Ada");
    assert.equal(app.view().catalog?.actions[0]?.title, "From A");
    await app.setProjectFolder("  D:\\two  ");
    const view = app.view();
    assert.equal(view.projectFolder, "D:\\two");
    assert.equal(view.catalog?.source, "local");
    assert.equal(view.catalog?.localNote, "這是本機清單。");
    assert.equal(view.catalog?.actions[0]?.title, "From B");
    assert.equal(JSON.stringify(view).includes("From A"), false);
    assert.deepEqual(fileReads, ["D:\\one", "D:\\two"]);
  });
});

describe.skip("retired combined route addresses", () => {
  it("keeps Codex on its personal route at startup and switches routes with the model mode", async () => {
    const { app, docs } = harness(undefined, {
      codex: { trust: "always", mcp: { server: "local" }, model: "kept" },
    });
    await app.start();
    assert.equal(docs.codex.openai_base_url, undefined);
    await app.redeem("ABC12345", "Ada");
    await app.setSwitch("classroom");
    assert.equal(docs.codex.openai_base_url, `${PROXY}/v1`);
    await app.setSwitch("native");
    assert.equal(docs.codex.openai_base_url, undefined);
    assert.equal(docs.codex.trust, "always");
    assert.deepEqual(docs.codex.mcp, { server: "local" });
    assert.equal(docs.codex.model, "kept");
    assert.equal(JSON.stringify(app.view()).includes(KEY), false);
  });

  it("points both Claude ANTHROPIC_BASE_URL fields at the proxy and leaves API key fields alone", async () => {
    const { app, docs } = harness(undefined, {
      claudeTerminal: {
        ANTHROPIC_API_KEY: "sk-ant-keep",
        apiKey: "keep-api",
        CUSTOM_API_KEY: "keep-custom",
        theme: "dark",
      },
      vsCode: {
        "claudeCode.environmentVariables": [
          { name: "ANTHROPIC_API_KEY", value: "sk-ant-keep" },
          { name: "OTHER", value: "stay" },
        ],
        apiKey: "keep-api",
        EDITOR_API_KEY: "keep-editor",
      },
    });
    await app.start();
    await app.redeem("ABC12345", "Ada");
    await app.setSwitch("classroom", "claude");
    assert.equal(docs.claudeTerminal.ANTHROPIC_BASE_URL, PROXY);
    assert.equal(docs.claudeTerminal.ANTHROPIC_API_KEY, "sk-ant-keep");
    assert.equal(docs.claudeTerminal.apiKey, "keep-api");
    assert.equal(docs.claudeTerminal.CUSTOM_API_KEY, "keep-custom");
    assert.equal(docs.claudeTerminal.theme, "dark");
    assert.deepEqual(docs.vsCode["claudeCode.environmentVariables"], [
      { name: "ANTHROPIC_API_KEY", value: "sk-ant-keep" },
      { name: "OTHER", value: "stay" },
      { name: "ANTHROPIC_BASE_URL", value: PROXY },
    ]);
    assert.equal(docs.vsCode.apiKey, "keep-api");
    assert.equal(docs.vsCode.EDITOR_API_KEY, "keep-editor");
    assert.equal(Object.hasOwn(docs.claudeTerminal, "ANTHROPIC_AUTH_TOKEN"), false);
    assert.equal(JSON.stringify(app.view()).includes(KEY), false);
    assert.equal(JSON.stringify(docs).includes("sk-ant-keep"), true);
  });

  it("keeps other VS Code environment map entries when setting ANTHROPIC_BASE_URL", async () => {
    const { app, docs } = harness(undefined, {
      vsCode: {
        "claudeCode.environmentVariables": {
          OTHER: "stay",
          ANTHROPIC_API_KEY: "sk-ant-keep",
        },
        "editor.fontSize": 14,
      },
    });
    await app.start();
    await app.redeem("ABC12345", "Ada");
    await app.setSwitch("classroom", "claude");
    assert.deepEqual(docs.vsCode["claudeCode.environmentVariables"], {
      OTHER: "stay",
      ANTHROPIC_API_KEY: "sk-ant-keep",
      ANTHROPIC_BASE_URL: PROXY,
    });
    assert.equal(docs.vsCode["editor.fontSize"], 14);
  });

  it("names the previous host and leaves the key out of the view", async () => {
    const previous = "https://user:secret@old.example/v1?key=vcr_sk_secret";
    const { app, docs } = harness(undefined, {
      codex: { openai_base_url: previous, trust: "always" },
    });
    await app.start();
    const notice = app.view().notice ?? "";
    assert.equal(notice.includes("old.example"), true);
    assert.equal(notice.includes("secret"), false);
    assert.equal(notice.includes("vcr_sk"), false);
    assert.equal(notice.includes("user:"), false);
    const viewText = JSON.stringify(app.view());
    assert.equal(viewText.includes("secret"), false);
    assert.equal(viewText.includes("vcr_sk"), false);
    assert.equal(viewText.includes(KEY), false);
    assert.equal(docs.codex.openai_base_url, previous);
    assert.equal(docs.codex.trust, "always");
  });

  it("asks the student to fully quit Codex and Claude Code the first time a route is written", async () => {
    const { app } = harness();
    await app.start();
    assert.deepEqual(app.view().mustRestart, ["codex", "claude", "vscode"]);
    assert.equal(JSON.stringify(app.view()).includes(KEY), false);
  });

  it("restores a custom personal Codex route while the proxy remains running", async () => {
    const { app, docs, routeWrites } = harness(undefined, { codex: { openai_base_url: "https://personal.example/v1" } });
    await app.redeem("ABC12345", "Ada");
    await app.start();
    const writes = { ...routeWrites };
    await app.setSwitch("classroom");
    assert.equal(docs.codex.openai_base_url, `${PROXY}/v1`);
    assert.equal(app.view().mode, "classroom");
    assert.equal(app.view().modelId, "second-looking-but-first");
    await app.setSwitch("native");
    assert.equal(app.view().mode, "native");
    assert.equal(app.view().modelId, undefined);
    assert.equal(docs.codex.openai_base_url, "https://personal.example/v1");
    assert.deepEqual(routeWrites, { ...writes, codex: writes.codex + 2, claudeTerminal: writes.claudeTerminal + 2, vsCode: writes.vsCode + 2 });
    assert.equal(JSON.stringify(app.view()).includes(KEY), false);
  });

  it("preserves the personal Codex address when stopping and preserves personal Claude routes", async () => {
    const previous = "https://user:secret@old.example/v1?key=vcr_sk_secret";
    const { app, docs, proxyStops } = harness(undefined, {
      codex: {
        openai_base_url: previous,
        trust: "always",
        mcp: { server: "local" },
      },
      claudeTerminal: {
        ANTHROPIC_BASE_URL: "https://claude.example",
        theme: "dark",
        ANTHROPIC_API_KEY: "sk-ant-keep",
      },
      vsCode: {
        "claudeCode.environmentVariables": [
          { name: "OTHER", value: "stay" },
          { name: "ANTHROPIC_BASE_URL", value: "https://claude.example" },
        ],
        "editor.fontSize": 14,
      },
    });
    await app.start();
    await app.stop();
    assert.equal(proxyStops(), 1);
    assert.equal(docs.codex.openai_base_url, previous);
    assert.equal(docs.codex.trust, "always");
    assert.deepEqual(docs.codex.mcp, { server: "local" });
    assert.equal(docs.claudeTerminal.ANTHROPIC_BASE_URL, "https://claude.example");
    assert.equal(docs.claudeTerminal.theme, "dark");
    assert.equal(docs.claudeTerminal.ANTHROPIC_API_KEY, "sk-ant-keep");
    assert.deepEqual(docs.vsCode["claudeCode.environmentVariables"], [
      { name: "OTHER", value: "stay" },
      { name: "ANTHROPIC_BASE_URL", value: "https://claude.example" },
    ]);
    assert.equal(docs.vsCode["editor.fontSize"], 14);
    const written = JSON.stringify(docs);
    assert.equal(written.includes(previous), true);
    assert.equal(written.includes("old.example"), true);
    assert.equal(written.includes("claude.example"), true);
    assert.equal(written.includes("secret"), true);
    assert.equal(JSON.stringify(app.view()).includes(KEY), false);
  });

  it("points the routes at the proxy again after stop and keeps the stored switch", async () => {
    const { app, docs, proxyStarts, proxyStops } = harness();
    await app.redeem("ABC12345", "Ada");
    await app.setSwitch("classroom");
    await app.start();
    await app.stop();
    await app.start();
    assert.equal(proxyStops(), 1);
    assert.equal(proxyStarts(), 2);
    assert.equal(docs.codex.openai_base_url, `${PROXY}/v1`);
    assert.equal(docs.claudeTerminal.ANTHROPIC_BASE_URL, PROXY);
    assert.deepEqual(docs.vsCode["claudeCode.environmentVariables"], [
      { name: "ANTHROPIC_BASE_URL", value: PROXY },
    ]);
    assert.equal(app.view().mode, "classroom");
    assert.equal(app.view().modelId, "second-looking-but-first");
    assert.deepEqual(app.view().mustRestart, ["codex", "claude", "vscode"]);
    assert.equal(JSON.stringify(app.view()).includes(KEY), false);
  });

  it("preserves personal ANTHROPIC_BASE_URL in a VS Code environment map", async () => {
    const { app, docs } = harness(undefined, {
      vsCode: {
        "claudeCode.environmentVariables": {
          OTHER: "stay",
          ANTHROPIC_BASE_URL: "https://claude.example",
          ANTHROPIC_API_KEY: "sk-ant-keep",
        },
      },
    });
    await app.start();
    await app.stop();
    assert.deepEqual(docs.vsCode["claudeCode.environmentVariables"], {
      OTHER: "stay",
      ANTHROPIC_BASE_URL: "https://claude.example",
      ANTHROPIC_API_KEY: "sk-ant-keep",
    });
    assert.equal(JSON.stringify(docs).includes("claude.example"), true);
  });
});

describe("confirm one catalog command", () => {
  it("marks only the successful action as installed in its project folder", async () => {
    const { app } = harness(undefined, {
      catalogYaml: `actions:
  - id: first
    title: First
    kind: package
    command: echo installed
  - id: second
    title: Second
    kind: package
    command: echo installed
`,
    });
    await app.setProjectFolder("D:\\lesson");
    await app.redeem("ABC12345", "Ada");
    assert.deepEqual(app.view().installedActionIds, []);
    app.prepare("first");
    await app.confirm();
    assert.deepEqual(app.view().installedActionIds, ["first"]);
    assert.equal((renderPage(app.view()).match(/class="badge installed-tag"/g) ?? []).length, 1);
    await app.setProjectFolder("D:\\other");
    assert.deepEqual(app.view().installedActionIds, []);
    assert.doesNotMatch(renderPage(app.view()), /class="badge installed-tag"/);
    await app.setProjectFolder("D:\\lesson");
    assert.deepEqual(app.view().installedActionIds, ["first"]);
  });

  it("does not mark a failed or canceled installation as installed", async () => {
    const { app } = harness(undefined, { runExitCode: 1 });
    await app.setProjectFolder("D:\\lesson");
    await app.redeem("ABC12345", "Ada");
    app.prepare("demo");
    app.cancel();
    assert.deepEqual(app.view().installedActionIds, []);
    app.prepare("demo");
    await app.confirm();
    assert.deepEqual(app.view().installedActionIds, []);
    assert.doesNotMatch(renderPage(app.view()), /class="badge installed-tag"/);
  });
  it("marks nonzero command exits as failed even when the runner resolves", async () => {
    const { app } = harness(undefined, {
      run: async () => "dependency failed\n",
      runExitCode: 7,
    });
    await app.setProjectFolder("D:\\lesson");
    await app.redeem("ABC12345", "Ada");
    app.prepare("demo");
    await app.confirm();
    assert.equal(app.view().commandSucceeded, false);
    assert.equal(app.view().commandOutput, "dependency failed\n");
    app.prepare("demo");
    assert.equal(app.view().commandSucceeded, undefined);
  });
  it("publishes partial output while installing and clears the dialog when done", async () => {
    let finish!: (output: string) => void;
    let publish!: (output: string) => void;
    const waiting = new Promise<string>((resolve) => { finish = resolve; });
    const { app } = harness(undefined, {
      run: async (_cwd, _command, onOutput) => {
        publish = onOutput!;
        return waiting;
      },
    });
    await app.setProjectFolder("D:\\lesson");
    await app.redeem("ABC12345", "Ada");
    app.prepare("demo");
    const installing = app.confirm();
    publish("Downloading demo…\n");
    assert.equal(app.view().commandRunning, true);
    assert.equal(app.view().commandOutput, "Downloading demo…\n");
    publish("Downloading demo…\nInstalling…\n");
    assert.equal(app.view().commandOutput, "Downloading demo…\nInstalling…\n");
    finish("Installed 1 package\n");
    await installing;
    assert.equal(app.view().commandRunning, false);
    assert.equal(app.view().pendingCommand, undefined);
    assert.equal(app.view().commandOutput, "Installed 1 package\n");
    assert.equal(app.view().commandSucceeded, true);
  });
  it("closes the confirmation dialog after installation and keeps the output", async () => {
    const { app, runCalls } = harness(undefined, {
      run: async () => "Installed 1 package\n",
    });
    await app.setProjectFolder("D:\\lesson");
    await app.redeem("ABC12345", "Ada");
    app.prepare("demo");
    assert.match(renderPage(app.view()), /class="confirm-dialog"/);
    await app.confirm();
    assert.doesNotMatch(renderPage(app.view()), /class="confirm-dialog"/);
    assert.equal(app.view().pendingCommand, undefined);
    assert.equal(app.view().commandOutput, "Installed 1 package\n");
    await app.confirm();
    assert.equal(runCalls.length, 1);
    app.prepare("demo");
    assert.match(renderPage(app.view()), /class="confirm-dialog"/);
  });

  it("prepare puts that action's full command on the view and does not run it", async () => {
    const { app, runCalls } = harness();
    await app.redeem("ABC12345", "Ada");
    app.prepare("demo");
    assert.equal(app.view().pendingCommand, undefined);
    const blocked = renderPage(app.view());
    assert.match(blocked, /尚未選擇安裝位置/);
    assert.match(blocked, /<button type="submit" disabled>安裝<\/button>/);
    await app.setProjectFolder("D:\\lesson");
    app.prepare("demo");
    const view = app.view();
    assert.equal(view.pendingCommand, "uv add demo");
    assert.equal(view.commandRunning, false);
    assert.equal(runCalls.length, 0);
    assert.equal(JSON.stringify(view).includes(KEY), false);
    const ready = renderPage(view);
    assert.match(ready, /class="confirm-dialog"/);
    assert.equal(ready.includes("尚未選擇安裝位置"), false);
  });

  it("confirm runs the pending command", async () => {
    const { app, runCalls } = harness();
    await app.setProjectFolder("D:\\lesson");
    await app.redeem("ABC12345", "Ada");
    app.prepare("demo");
    await app.confirm();
    assert.equal(runCalls.length, 1);
    assert.equal(JSON.stringify(app.view()).includes(KEY), false);
  });

  it("keeps an execution failure visible after closing the confirmation dialog", async () => {
    const { app } = harness(undefined, {
      run: async () => { throw new Error("runner failed"); },
    });
    await app.setProjectFolder("D:\\lesson");
    await app.redeem("ABC12345", "Ada");
    app.prepare("demo");
    await app.confirm();
    const view = app.view();
    assert.equal(view.pendingCommand, undefined);
    assert.equal(view.commandRunning, false);
    assert.equal(view.commandOutput, "指令執行失敗。");
    assert.equal(view.commandSucceeded, false);
    assert.doesNotMatch(renderPage(view), /class="confirm-dialog"/);
    assert.match(renderPage(view), /指令執行失敗。/);
  });

  it("cancel clears the pending command and does not run it", async () => {
    const { app, runCalls } = harness();
    await app.setProjectFolder("D:\\lesson");
    await app.redeem("ABC12345", "Ada");
    app.prepare("demo");
    app.cancel();
    assert.equal(app.view().pendingCommand, undefined);
    await app.confirm();
    assert.equal(runCalls.length, 0);
    assert.equal(JSON.stringify(app.view()).includes(KEY), false);
  });

  it("runs in the Project Folder with the catalog command unchanged", async () => {
    const { app, runCalls } = harness(undefined, {
      catalogYaml: `
actions:
  - id: spaced
    title: Spaced
    kind: package
    command: "echo hello  world"
`,
    });
    await app.setProjectFolder("D:\\lesson");
    await app.redeem("ABC12345", "Ada");
    app.prepare("spaced");
    await app.confirm();
    assert.deepEqual(runCalls, [
      { cwd: "D:\\lesson", command: "echo hello  world" },
    ]);
    assert.equal(JSON.stringify(app.view()).includes(KEY), false);
  });

  it("shows the runner output on the view", async () => {
    const { app } = harness(undefined, {
      run: async () => "printed-by-runner\n",
    });
    await app.setProjectFolder("D:\\lesson");
    await app.redeem("ABC12345", "Ada");
    app.prepare("demo");
    await app.confirm();
    const view = app.view();
    assert.equal(view.commandOutput, "printed-by-runner\n");
    assert.equal(view.commandRunning, false);
    assert.equal(JSON.stringify(view).includes(KEY), false);
  });

  it("does not run when no Project Folder is set", async () => {
    const { app, runCalls } = harness();
    await app.redeem("ABC12345", "Ada");
    app.prepare("demo");
    await app.confirm();
    assert.equal(runCalls.length, 0);
    assert.equal(app.view().pendingCommand, undefined);
    assert.equal(app.view().commandOutput, undefined);
    assert.equal(JSON.stringify(app.view()).includes(KEY), false);
  });

  it("rejects a folder change and a second command while one is running", async () => {
    let release: (value: string) => void = () => {};
    const gate = new Promise<string>((resolve) => {
      release = resolve;
    });
    const { app, runCalls, fileReads } = harness(undefined, {
      catalogYaml: `
actions:
  - id: first
    title: First
    kind: skill
    command: echo first
  - id: second
    title: Second
    kind: skill
    command: echo second
`,
      files: {
        "D:\\other": `
actions:
  - id: other
    title: Other
    kind: skill
    command: echo other
`,
      },
      run: async () => gate,
    });
    await app.setProjectFolder("D:\\lesson");
    await app.redeem("ABC12345", "Ada");
    app.prepare("first");
    const running = app.confirm();
    assert.equal(runCalls.length, 1);
    assert.equal(app.view().commandRunning, true);
    await app.setSwitch("classroom");
    assert.equal(app.view().mode, "classroom");
    assert.equal(app.view().modelId, "second-looking-but-first");
    assert.equal(app.view().commandRunning, true);
    await app.setSwitch("native");
    assert.equal(app.view().mode, "native");
    assert.equal(app.view().commandRunning, true);
    await app.setProjectFolder("D:\\other");
    assert.equal(app.view().projectFolder, "D:\\lesson");
    assert.deepEqual(fileReads, []);
    app.prepare("second");
    await app.confirm();
    assert.equal(runCalls.length, 1);
    assert.equal(app.view().pendingCommand, "echo first");
    release("still first\n");
    await running;
    const view = app.view();
    assert.equal(view.commandOutput, "still first\n");
    assert.equal(view.commandRunning, false);
    assert.equal(view.projectFolder, "D:\\lesson");
    assert.equal(JSON.stringify(view).includes(KEY), false);
  });

  it("runs an mcp action as that catalog command and does not write a config file", async () => {
    const writes: { path: string; contents: string }[] = [];
    const command =
      "uvx --from git+https://github.com/mz038197/peas-agent-mcp.git add-vans-mcp";
    const { app, runCalls } = harness(undefined, {
      catalogYaml: `
actions:
  - id: add-vans-mcp
    title: 安裝 MCP
    kind: mcp
    command: "${command}"
`,
      write: async (path, contents) => {
        writes.push({ path, contents });
      },
    });
    await app.setProjectFolder("D:\\lesson");
    await app.redeem("ABC12345", "Ada");
    app.prepare("add-vans-mcp");
    assert.equal(runCalls.length, 0);
    await app.confirm();
    assert.deepEqual(runCalls, [{ cwd: "D:\\lesson", command }]);
    assert.deepEqual(writes, []);
    assert.equal(JSON.stringify(app.view()).includes(KEY), false);
  });
});

describe("environment tools", () => {
  it("lists uv, git, node, and pwsh, and does not count Windows PowerShell 5.1 as pwsh", async () => {
    const asked: string[] = [];
    const { app } = harness(undefined, {
      async probe(tool) {
        asked.push(tool);
        if ((tool as string) === "powershell") {
          return { installed: true };
        }
        return { installed: tool !== "pwsh" };
      },
    });
    await app.checkEnvironment();
    const view = app.view();
    assert.deepEqual(
      view.tools.map((tool) => tool.id),
      ["uv", "git", "node", "pwsh"],
    );
    assert.equal(view.tools.length, 4);
    assert.equal(view.tools.find((tool) => tool.id === "pwsh")?.installed, false);
    assert.equal(JSON.stringify(view.tools).includes("powershell"), false);
    assert.deepEqual(asked, ["uv", "git", "node", "pwsh"]);
    assert.equal(JSON.stringify(view).includes(KEY), false);
  });

  it("installs a subset in list order inside the Project Folder after one confirm", async () => {
    const { app, installCalls } = harness();
    await app.setProjectFolder("D:\\lesson");
    app.selectEnvironment(["node", "uv"]);
    await app.confirmEnvironment();
    assert.deepEqual(installCalls, [
      { tool: "uv", cwd: "D:\\lesson" },
      { tool: "node", cwd: "D:\\lesson" },
    ]);
    assert.equal(JSON.stringify(app.view()).includes(KEY), false);
  });

  it("stops after a real install failure and does not install later tools", async () => {
    const { app, installCalls } = harness(undefined, {
      async install(tool) {
        if (tool === "git") {
          return { exitCode: 1, output: "boom" };
        }
        return { exitCode: 0, output: "" };
      },
    });
    await app.setProjectFolder("D:\\lesson");
    app.selectEnvironment(["pwsh", "git", "uv"]);
    await app.confirmEnvironment();
    assert.deepEqual(
      installCalls.map((call) => call.tool),
      ["uv", "git"],
    );
    assert.equal(JSON.stringify(app.view()).includes(KEY), false);
  });

  it("does not install when the selection is empty", async () => {
    const { app, installCalls } = harness();
    await app.setProjectFolder("D:\\lesson");
    app.selectEnvironment([]);
    await app.confirmEnvironment();
    assert.deepEqual(installCalls, []);
  });

  it("does not install without a Project Folder", async () => {
    const { app, installCalls } = harness();
    app.selectEnvironment(["uv", "git", "node", "pwsh"]);
    await app.confirmEnvironment();
    assert.deepEqual(installCalls, []);
    assert.equal(app.view().projectFolder, undefined);
  });

  it("holds the command lock while an install is pending", async () => {
    let release: (value: { exitCode: number | undefined; output: string }) => void =
      () => {};
    const gate = new Promise<{ exitCode: number | undefined; output: string }>(
      (resolve) => {
        release = resolve;
      },
    );
    const { app, runCalls, fileReads } = harness(undefined, {
      files: {
        "D:\\other": `
actions:
  - id: other
    title: Other
    kind: skill
    command: echo other
`,
      },
      install: async () => gate,
    });
    await app.setProjectFolder("D:\\lesson");
    await app.redeem("ABC12345", "Ada");
    app.selectEnvironment(["uv"]);
    const pending = app.confirmEnvironment();
    assert.equal(app.view().commandRunning, true);
    app.prepare("demo");
    await app.confirm();
    assert.equal(runCalls.length, 0);
    await app.setProjectFolder("D:\\other");
    assert.equal(app.view().projectFolder, "D:\\lesson");
    assert.deepEqual(fileReads, []);
    release({ exitCode: 0, output: "" });
    await pending;
    assert.equal(app.view().commandRunning, false);
    assert.equal(app.view().projectFolder, "D:\\lesson");
    assert.equal(JSON.stringify(app.view()).includes(KEY), false);
  });

  it("does not start an install while a lesson command is running", async () => {
    let release: (value: string) => void = () => {};
    const gate = new Promise<string>((resolve) => {
      release = resolve;
    });
    const { app, installCalls, runCalls } = harness(undefined, {
      run: async () => gate,
    });
    await app.setProjectFolder("D:\\lesson");
    await app.redeem("ABC12345", "Ada");
    app.prepare("demo");
    const running = app.confirm();
    assert.equal(runCalls.length, 1);
    app.selectEnvironment(["uv", "git"]);
    await app.confirmEnvironment();
    assert.deepEqual(installCalls, []);
    assert.equal(app.view().projectFolder, "D:\\lesson");
    release("done\n");
    await running;
    assert.equal(JSON.stringify(app.view()).includes(KEY), false);
  });

  it("asks the student to reopen the terminal after exit 0 and does not mark the tool ready", async () => {
    const { app, probeCalls } = harness();
    await app.setProjectFolder("D:\\lesson");
    await app.checkEnvironment();
    const probesAfterCheck = probeCalls.length;
    app.selectEnvironment(["uv"]);
    await app.confirmEnvironment();
    const view = app.view();
    assert.equal(view.tools.find((tool) => tool.id === "uv")?.installed, false);
    assert.equal(view.environmentNotice, "請重開終端機再重新檢查。");
    assert.equal(probeCalls.length, probesAfterCheck);
    assert.equal(JSON.stringify(view).includes(KEY), false);
  });

  it("treats the official already-installed message as success and a bare boom as failure", async () => {
    const { app, installCalls, probeCalls } = harness(undefined, {
      async install(tool) {
        if (tool === "git") {
          return {
            exitCode: 1,
            output:
              'xcode-select: error: command line tools are already installed, use "Software Update" to install updates\n',
          };
        }
        if (tool === "node") {
          return { exitCode: 1, output: "boom" };
        }
        return { exitCode: 0, output: "" };
      },
    });
    await app.setProjectFolder("D:\\lesson");
    await app.checkEnvironment();
    const probesAfterCheck = probeCalls.length;
    app.selectEnvironment(["pwsh", "node", "git"]);
    await app.confirmEnvironment();
    assert.deepEqual(
      installCalls.map((call) => call.tool),
      ["git", "node"],
    );
    const view = app.view();
    assert.equal(view.tools.every((tool) => tool.installed === false), true);
    assert.equal(view.environmentNotice, "請重開終端機再重新檢查。");
    assert.equal(probeCalls.length, probesAfterCheck);
    assert.equal(JSON.stringify(view).includes(KEY), false);
  });

  it("treats winget already-installed wording as success and does not mark the tool ready", async () => {
    const { app, installCalls, probeCalls } = harness(undefined, {
      async install(tool) {
        if (tool === "git") {
          return { exitCode: 1, output: "No available upgrade found.\n" };
        }
        if (tool === "node") {
          return {
            exitCode: -1978335189,
            output: "Found an existing package already installed.\n",
          };
        }
        return { exitCode: 1, output: "boom" };
      },
    });
    await app.setProjectFolder("D:\\lesson");
    await app.checkEnvironment();
    const probesAfterCheck = probeCalls.length;
    app.selectEnvironment(["pwsh", "node", "git"]);
    await app.confirmEnvironment();
    assert.deepEqual(
      installCalls.map((call) => call.tool),
      ["git", "node", "pwsh"],
    );
    const view = app.view();
    assert.equal(view.tools.every((tool) => tool.installed === false), true);
    assert.equal(view.environmentNotice, "請重開終端機再重新檢查。");
    assert.equal(probeCalls.length, probesAfterCheck);
    assert.equal(JSON.stringify(view).includes(KEY), false);
  });
});

describe("close window", () => {
  it("does not stop the process", async () => {
    const { app, stops, storedKey, clipboardWrites } = harness();
    await app.redeem("ABC12345", "Ada");
    app.closeWindow();
    assert.equal(stops(), 0);
    assert.equal(app.view().connected, true);
    assert.equal(app.view().classLabel, "Demo · Week 1");
    assert.equal(app.view().canCopyKey, true);
    assert.equal(await storedKey(), KEY);
    await app.copyKey();
    assert.equal(clipboardWrites(), 1);
    assert.equal(stops(), 0);
  });

  it("does not stop the proxy or change routes", async () => {
    const { app, docs, proxyStops, routeWrites } = harness(undefined, {
      codex: { trust: "always", mcp: { server: "local" } },
      claudeTerminal: { theme: "dark", ANTHROPIC_API_KEY: "sk-ant-keep" },
    });
    await app.start();
    const writes = { ...routeWrites };
    app.closeWindow();
    assert.equal(proxyStops(), 0);
    assert.deepEqual(routeWrites, writes);
    assert.equal(docs.codex.openai_base_url, undefined);
    assert.equal(docs.codex.trust, "always");
    assert.deepEqual(docs.codex.mcp, { server: "local" });
    assert.equal(docs.claudeTerminal.ANTHROPIC_BASE_URL, undefined);
    assert.equal(docs.claudeTerminal.ANTHROPIC_API_KEY, "sk-ant-keep");
    assert.equal(app.view().connected, false);
    assert.equal(JSON.stringify(app.view()).includes(KEY), false);
  });
});

describe.skip("retired shared VCRouter startup provider", () => {
  it("appends one VCRouter addressed at the local proxy and leaves other providers unchanged", async () => {
    const openRouter = {
      name: "OpenRouter",
      vendor: "openrouter",
      apiKey: "keep-me",
      models: [{ id: "keep-or", name: "keep-or" }],
    };
    const { app, copilotWrites, storedKey } = harness(undefined, {
      providers: [openRouter],
    });
    await app.redeem("ABC12345", "Ada");
    assert.equal(await storedKey(), KEY);
    await app.start();
    assert.equal(copilotWrites().length, 1);
    const written = copilotWrites()[0];
    assert.deepEqual(written?.providers[0], openRouter);
    assert.deepEqual(written?.providers[1], {
      name: "VCRouter",
      url: "http://127.0.0.1:47821",
    });
    assert.equal(written?.providers.length, 2);
    assert.equal(Object.hasOwn(written?.providers[1] ?? {}, "apiKey"), false);
    assert.equal(JSON.stringify(written).includes(KEY), false);
    assert.equal(JSON.stringify(app.view()).includes(KEY), false);
  });

  it("asks for a full VS Code restart only when VCRouter is inserted", async () => {
    const { app } = harness(undefined, {
      providers: [{ name: "OpenRouter", apiKey: "keep-me" }],
    });
    await app.redeem("ABC12345", "Ada");
    await app.start();
    assert.deepEqual(app.view().mustRestart, ["codex", "claude", "vscode"]);
    assert.equal(JSON.stringify(app.view()).includes(KEY), false);
  });

  it("does not write when VCRouter is already present", async () => {
    const existing = [
      { name: "OpenRouter", apiKey: "keep-me" },
      {
        name: "VCRouter",
        url: "http://127.0.0.1:9",
        models: [{ id: "leave-me" }],
      },
    ];
    const { app, copilotWrites } = harness(undefined, { providers: existing });
    await app.redeem("ABC12345", "Ada");
    await app.start();
    await app.setSwitch("classroom");
    await app.setSwitch("native");
    assert.equal(copilotWrites().length, 0);
    assert.deepEqual(app.view().mustRestart, ["codex", "claude"]);
    assert.equal(JSON.stringify(app.view()).includes(KEY), false);
  });

  it("does not add or remove providers when the switch changes after the first insert", async () => {
    const { app, copilotWrites, copilotProviders } = harness(undefined, {
      providers: [{ name: "OpenRouter", apiKey: "keep-me" }],
    });
    await app.redeem("ABC12345", "Ada");
    await app.start();
    const afterInsert = copilotProviders();
    await app.setSwitch("classroom");
    await app.setSwitch("native");
    assert.deepEqual(copilotProviders(), afterInsert);
    assert.equal(copilotWrites().length, 1);
    assert.equal(
      afterInsert.filter((provider) => provider.name === "VCRouter").length,
      1,
    );
    assert.equal(
      afterInsert.some((provider) => provider.name === "OpenRouter"),
      true,
    );
  });

  it("refuses VCRouter while the proxy is stopped and never sends Native into it", async () => {
    const { app, proxyReceived } = harness();
    await app.redeem("ABC12345", "Ada");
    await app.start();
    await app.copilotRequest("native");
    assert.deepEqual(proxyReceived(), []);
    await app.stop();
    await assert.rejects(() => app.copilotRequest("VCRouter"), (err: unknown) => {
      assert.equal(String(err).includes(KEY), false);
      return true;
    });
    assert.deepEqual(proxyReceived(), []);
    await app.copilotRequest("native");
    assert.deepEqual(proxyReceived(), []);
  });

  it("accepts VCRouter after start again and still skips Native", async () => {
    const { app, proxyReceived, copilotProviders } = harness();
    await app.start();
    await app.stop();
    assert.equal(
      copilotProviders().some((provider) => provider.name === "VCRouter"),
      true,
    );
    await app.start();
    await app.copilotRequest("native");
    assert.deepEqual(proxyReceived(), []);
    await app.copilotRequest("VCRouter");
    assert.deepEqual(proxyReceived(), ["VCRouter"]);
  });

  it("forwards allowed classroom Codex and Claude models to the router with the key", async () => {
    const { app, sent } = harness();
    await app.redeem("ABC12345", "Ada");
    await app.start();
    await app.setSwitch("classroom");
    const codex = await app.forward({ client: "codex", model: "second-looking-but-first" });
    const claude = await app.forward({
      client: "claude",
      model: "later",
    });
    assert.deepEqual(codex, {
      client: "codex",
      target: "router",
      model: "second-looking-but-first",
    });
    assert.deepEqual(claude, {
      client: "claude",
      target: "router",
      model: "later",
    });
    assert.equal(sent()[0]?.target, "router");
    assert.equal(sent()[0]?.apiKey, KEY);
    assert.equal(sent()[1]?.target, "router");
    assert.equal(sent()[1]?.model, "later");
    assert.equal(sent()[1]?.apiKey, KEY);
    assert.equal(JSON.stringify(codex).includes(KEY), false);
    assert.equal(JSON.stringify(claude).includes(KEY), false);
    assert.equal(JSON.stringify(app.view()).includes(KEY), false);
  });

  it("forwards native Codex to ChatGPT and native Claude to claude.ai without the key", async () => {
    const { app, sent } = harness(undefined, {
      codex: { openai_base_url: "https://old.example/v1" },
      claudeTerminal: { ANTHROPIC_BASE_URL: "https://third.example" },
    });
    await app.redeem("ABC12345", "Ada");
    await app.start();
    await app.setSwitch("native");
    const codex = await app.forward({ client: "codex", model: "gpt-4.1" });
    const claude = await app.forward({ client: "claude", model: "claude-sonnet" });
    assert.deepEqual(codex, {
      client: "codex",
      target: "chatgpt",
      model: "gpt-4.1",
    });
    assert.deepEqual(claude, {
      client: "claude",
      target: "claude.ai",
      model: "claude-sonnet",
    });
    assert.equal(sent()[0]?.target, "chatgpt");
    assert.equal(sent()[0]?.model, "gpt-4.1");
    assert.equal("apiKey" in (sent()[0] ?? {}), false);
    assert.equal(sent()[1]?.target, "claude.ai");
    assert.equal("apiKey" in (sent()[1] ?? {}), false);
    const sentText = JSON.stringify(sent());
    assert.equal(sentText.includes(KEY), false);
    assert.equal(sentText.includes("old.example"), false);
    assert.equal(sentText.includes("third.example"), false);
    assert.equal(JSON.stringify(app.view()).includes(KEY), false);
  });

  it("forwards VCRouter to the classroom upstream even when the switch is native", async () => {
    const { app, sent, proxyReceived } = harness();
    await app.redeem("ABC12345", "Ada");
    await app.start();
    await app.setSwitch("native");
    await app.copilotRequest("native");
    assert.deepEqual(proxyReceived(), []);
    assert.deepEqual(sent(), []);
    await app.copilotRequest("VCRouter");
    assert.deepEqual(proxyReceived(), ["VCRouter"]);
    assert.equal(sent()[0]?.client, "copilot");
    assert.equal(sent()[0]?.target, "router");
    assert.equal(sent()[0]?.model, "second-looking-but-first");
    assert.equal(sent()[0]?.apiKey, KEY);
    assert.equal(JSON.stringify(app.view()).includes(KEY), false);
  });

  it("does not forward after the proxy stops", async () => {
    const { app, sent } = harness();
    await app.redeem("ABC12345", "Ada");
    await app.start();
    await app.setSwitch("classroom");
    await app.stop();
    await assert.rejects(() => app.copilotRequest("VCRouter"), (err: unknown) => {
      assert.equal(String(err).includes(KEY), false);
      return true;
    });
    await assert.rejects(
      () => app.forward({ client: "codex", model: "gpt-4.1" }),
      (err: unknown) => {
        assert.equal(String(err).includes(KEY), false);
        return true;
      },
    );
    assert.deepEqual(sent(), []);
    assert.equal(JSON.stringify(app.view()).includes(KEY), false);
  });

  it("does not stop the proxy when the window closes", async () => {
    const { app, stops, proxyReceived } = harness();
    await app.redeem("ABC12345", "Ada");
    await app.start();
    app.closeWindow();
    assert.equal(stops(), 0);
    await app.copilotRequest("VCRouter");
    assert.deepEqual(proxyReceived(), ["VCRouter"]);
    assert.equal(JSON.stringify(app.view()).includes(KEY), false);
  });
});

it("redeem stores connection identity without writing the retired combined route state", async () => {
 const h = harness();
 await h.app.redeem(" invite ", " Student ");
 assert.deepEqual(await h.storedConnection(), {
  version: 1, apiKey: KEY, session: { class_name: "Demo", name: "Week 1" }, nickname: "Student",
 });
});

it("does not expose the connection key in installation output", async () => {
  const h = harness(undefined, { run: async () => `failed credential: ${KEY}` });
  await h.app.redeem("invite", "Student");
  await h.app.setProjectFolder("C:/project");
  h.app.prepare("demo");
  await h.app.confirm();
  assert.equal(JSON.stringify(h.app.view()).includes(KEY), false);
  assert.equal(renderPage(h.app.view()).includes(KEY), false);
});

it("startup restores saved Classroom mode once after fetching a fresh nonempty allowlist", async () => {
  const storage = createConnectionStorage(createMemorySecureStorage());
  await storage.setConnection({ version: 1, apiKey: KEY, session: { class_name: "Saved", name: "Lesson" }, nickname: "Student", mode: "classroom" });
  const h = harness(undefined, { storage });
  await Promise.all([h.app.start(), h.app.start()]);
  assert.equal(h.app.view().connected, true);
  assert.equal(h.app.view().classLabel, "Saved · Lesson");
  assert.equal(h.app.view().nickname, "Student");
  assert.equal(h.app.view().mode, "classroom");
  assert.deepEqual(h.modelOptions()?.ids, ["second-looking-but-first", "later"]);
  await h.app.forward({ client: "codex", model: "second-looking-but-first" });
  assert.equal(h.sent().at(-1)?.target, "router");
  assert.deepEqual(h.modelKeys, [KEY]);
  assert.deepEqual(h.catalogKeys, [KEY]);
  assert.equal(JSON.stringify(h.app.view()).includes(KEY), false);
});

it("a failed strict mode save preserves current routing and the mode restored next startup", async () => {
  const retained = createConnectionStorage(createMemorySecureStorage());
  await retained.setConnection({ version: 1, apiKey: KEY, session: { class_name: "Saved", name: "Lesson" }, mode: "native" });
  let fail = true;
  const storage: ConnectionStorage = {
    getConnection: () => retained.getConnection(),
    clearConnection: () => retained.clearConnection(),
    async setConnection(connection, options) {
      if (fail && options?.allowTemporary === false) throw new Error(`storage failure ${KEY}`);
      return retained.setConnection(connection);
    },
  };
  const h = harness(undefined, { storage });
  await h.app.start();
  await h.app.setSwitch("classroom");
  assert.equal(h.app.view().mode, "native");
  assert.equal(h.modelOptions(), null);
  assert.match(h.app.view().notice ?? "", /模式/);
  assert.equal(renderPage(h.app.view()).includes(KEY), false);
  await h.app.forward({ client: "codex", model: "second-looking-but-first" });
  assert.equal(h.sent().at(-1)?.target, "chatgpt");
  const restart = harness(undefined, { storage });
  await restart.app.start();
  assert.equal(restart.app.view().mode, "native");
  fail = false;
  await h.app.setSwitch("classroom");
  assert.equal(h.app.view().mode, "classroom");
  fail = true;
  await h.app.setSwitch("native");
  assert.equal(h.app.view().mode, "classroom");
  await h.app.forward({ client: "claude", model: "later" });
  assert.equal(h.sent().at(-1)?.target, "router");
  const secondRestart = harness(undefined, { storage });
  await secondRestart.app.start();
  assert.equal(secondRestart.app.view().mode, "classroom");
  fail = false;
  await h.app.setSwitch("native");
  const nativeRestart = harness(undefined, { storage });
  await nativeRestart.app.start();
  assert.equal(nativeRestart.app.view().mode, "native");
  assert.equal(nativeRestart.modelOptions(), null);
});

describe("saved Mode startup availability", () => {
  for (const mode of ["native", "classroom"] as const) {
    it(`preserves saved ${mode} across restart when a fresh allowlist is valid`, async () => {
      const storage = createConnectionStorage(createMemorySecureStorage());
      await storage.setConnection({ version: 1, apiKey: KEY, session: { class_name: "Saved" }, mode });
      const h = harness(undefined, { storage });
      await h.app.start();
      assert.equal(h.app.view().mode, mode);
      assert.equal(h.modelOptions()?.ids.length ?? 0, mode === "classroom" ? 2 : 0);
      await h.app.forward({ client: "codex", model: "later" });
      assert.equal(h.sent().at(-1)?.target, mode === "classroom" ? "router" : "chatgpt");
    });
  }
  for (const unavailable of ["offline", "missing", "empty", "malformed"] as const) {
    it(`keeps saved Classroom identity and preference but uses Native on ${unavailable} startup`, async () => {
      const storage = createConnectionStorage(createMemorySecureStorage());
      await storage.setConnection({ version: 1, apiKey: KEY, session: { class_name: "Saved" }, nickname: "Student", mode: "classroom" });
      let recovered = false;
      const h = harness(undefined, { storage, async sessionModels() {
        if (recovered) return ["freshly-allowed"];
        if (unavailable === "offline") throw new Error(`offline ${KEY}`);
        if (unavailable === "missing") return JSON.parse("{}");
        if (unavailable === "malformed") return JSON.parse('[null]');
        return [];
      } });
      await h.app.start();
      assert.equal(h.app.view().connected, true);
      assert.equal(h.app.view().classLabel, "Saved");
      assert.equal(h.app.view().nickname, "Student");
      assert.equal(h.app.view().mode, "native");
      assert.equal(h.app.view().modelId, undefined);
      assert.equal(h.modelOptions(), null);
      assert.equal(renderPage(h.app.view()).includes(KEY), false);
      await h.app.forward({ client: "codex", model: "freshly-allowed" });
      assert.equal(h.sent().at(-1)?.target, "chatgpt");
      assert.equal((await storage.getConnection())?.mode, "classroom");
      await assert.rejects(h.app.forward({ client: "copilot", model: "freshly-allowed" }), /沒有上課模型/);
      recovered = true;
      await h.app.reloadAllowlist();
      await h.app.setSwitch("classroom");
      assert.equal(h.app.view().mode, "classroom");
      assert.deepEqual(h.modelOptions()?.ids, ["freshly-allowed"]);
      await h.app.forward({ client: "claude", model: "freshly-allowed" });
      assert.equal(h.sent().at(-1)?.target, "router");
    });
  }
});

it("a malformed Reload response preserves prior Classroom models as last-known-good", async () => {
  const storage = createConnectionStorage(createMemorySecureStorage());
  await storage.setConnection({ version: 1, apiKey: KEY, session: { class_name: "Saved" }, mode: "classroom" });
  let missing = false;
  const h = harness(undefined, { storage, async sessionModels() { return missing ? JSON.parse("null") : ["allowed"]; } });
  await h.app.start();
  assert.equal(h.app.view().mode, "classroom");
  missing = true;
  await h.app.reloadAllowlist();
  assert.equal(h.app.view().mode, "classroom");
  assert.equal(h.app.view().modelId, "allowed");
  assert.match(h.app.view().notice ?? "", /重新載入.*失敗|保留.*模型/);
  await h.app.forward({ client: "claude", model: "allowed" });
  assert.equal(h.sent().at(-1)?.target, "router");
  assert.equal((await storage.getConnection())?.mode, "classroom");
  missing = false;
  await h.app.reloadAllowlist();
  assert.equal(h.app.view().notice, undefined);
  await h.app.forward({ client: "claude", model: "allowed" });
  assert.equal(h.sent().at(-1)?.target, "router");
});

it("Reload preserves the last-known-good catalogs on refresh failure and reports the error", async () => {
  let offline = false;
  const h = harness(undefined, {
    async sessionModels() {
      if (offline) throw new Error("router unavailable");
      return ["allowed", "other"];
    },
  });
  await h.app.start();
  await h.app.redeem("DEMO", "Student");
  await h.app.setSwitch("classroom");
  offline = true;

  await h.app.reloadAllowlist();

  assert.deepEqual(h.app.view().allowedModels, ["allowed", "other"]);
  assert.equal(h.app.view().mode, "classroom");
  assert.match(h.app.view().notice ?? "", /重新載入.*失敗|保留.*模型/);
  assert.equal((await h.app.forward({ client: "codex", model: "other" })).model, "other");
});

it("rejects a removed model on every route while an already-started request finishes its snapshot", async () => {
  let ids = ["old", "kept"];
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const sending = new Promise<void>(resolve => { entered = resolve; });
  const h = harness(undefined, {
    sessionModels: async () => ids,
    send: async upstream => {
      if (upstream.model === "old") {
        entered();
        await gate;
      }
    },
  });
  await h.app.start();
  await h.app.redeem("DEMO", "Student");
  await h.app.setSwitch("classroom");
  const inFlight = h.app.forward({ client: "codex", model: "old" });
  await sending;
  ids = ["kept"];

  await h.app.reloadAllowlist();

  for (const client of ["codex", "claude", "copilot"] as const) {
    await assert.rejects(h.app.forward({ client, model: "old" }), /old.*不在課堂允許清單/);
  }
  await assert.rejects(h.app.forward({ client: "codex", model: "" }), /missing.*不在課堂允許清單/);
  release();
  assert.equal((await inFlight).model, "old");
});


it("malformed Router metadata preserves the current persistent connection before any save", async () => {
  const original = { version: 1 as const, apiKey: "old-key", session: { class_name: "Old" }, nickname: "Old student", mode: "classroom" as const };
  let saves = 0;
  const h = harness(JSON.parse('{"class_name":42}'), { storage: {
    async getConnection() { return structuredClone(original); },
    async setConnection() { saves++; return { persistence: "persistent" }; },
    async clearConnection() { throw new Error("must retain original"); },
  } });
  await h.app.start();
  const before = h.app.view();
  await h.app.redeem("NEW", "New student");
  assert.equal(saves, 0);
  assert.equal(h.app.view().classLabel, before.classLabel);
  assert.equal(h.app.view().nickname, "Old student");
  assert.equal(h.app.view().mode, "classroom");
  assert.match(h.app.view().notice ?? "", /資料格式/);
  await h.app.copyKey(); assert.equal(h.clipboard(), "old-key");
  await h.app.forward({ client: "copilot", model: "later" });
  assert.equal(h.sent()[0]?.apiKey, "old-key");
});


it("failed Classroom model publication restores Native routes and persists the safe mode", async () => {
  const disk = persistentStorageFake();
  let fail = false, restorations = 0;
  const h = harness(undefined, { storage: disk, async setModelOptions(value) {
    if (fail && value) throw new Error(KEY);
    if (fail && !value) restorations++;
  } });
  await h.app.start();
  await h.app.redeem("DEMO", "Student");
  fail = true;
  await assert.doesNotReject(h.app.setSwitch("classroom"));
  assert.equal(h.app.view().mode, "native");
  assert.equal((await disk.getConnection())?.mode, "native");
  assert.equal(restorations, 1);
  assert.match(h.app.view().notice ?? "", /模型設定/);
  assert.doesNotMatch(renderPage(h.app.view()), /vcr_sk_nick/);
  await h.app.forward({ client: "codex", model: "later" });
  assert.equal(h.sent()[0]?.target, "chatgpt");
});


it("failed route and mode compensation reports partial failure while routing Native", async () => {
  const disk = persistentStorageFake();
  let failing = false;
  const h = harness(undefined, { storage: {
    getConnection: () => disk.getConnection(), clearConnection: () => disk.clearConnection(),
    async setConnection(value) {
      if (failing && value.mode === "native") throw new Error(KEY);
      return disk.setConnection(value);
    },
  }, async setModelOptions() { if (failing) throw new Error(KEY); } });
  await h.app.start(); await h.app.redeem("DEMO", "Student");
  failing = true;
  await assert.doesNotReject(h.app.setSwitch("classroom"));
  assert.equal(h.app.view().mode, "native");
  assert.equal((await disk.getConnection())?.mode, "classroom");
  assert.match(h.app.view().notice ?? "", /部分客戶端設定無法恢復/);
  assert.match(h.app.view().notice ?? "", /重新啟動仍可能恢復 Classroom/);
  assert.doesNotMatch(renderPage(h.app.view()), /vcr_sk_nick/);
  await h.app.forward({ client: "codex", model: "later" }); assert.equal(h.sent()[0]?.target, "chatgpt");
});

it("Native route restoration failure is controlled and retains the safely committed Native mode", async () => {
  const disk = persistentStorageFake(); let failing = false;
  const h = harness(undefined, { storage: disk, async setModelOptions(value) { if (failing && !value) throw new Error(KEY); } });
  await h.app.start(); await h.app.redeem("DEMO", "Student"); await h.app.setSwitch("classroom");
  failing = true;
  await assert.doesNotReject(h.app.setSwitch("native"));
  assert.equal(h.app.view().mode, "native"); assert.equal((await disk.getConnection())?.mode, "native");
  assert.match(h.app.view().notice ?? "", /部分客戶端設定無法恢復/);
  assert.doesNotMatch(h.app.view().notice ?? "", /vcr_sk_nick|重新啟動仍可能恢復 Classroom/);
  await h.app.forward({ client: "codex", model: "later" }); assert.equal(h.sent()[0]?.target, "chatgpt");
});

it("Native startup leaves personal Claude CLI and VS Code routes untouched", async () => {
  const h = harness(undefined, { claudeTerminal: { ANTHROPIC_BASE_URL: "https://personal.example", theme: "dark" }, vsCode: { "claudeCode.environmentVariables": [{ name: "ANTHROPIC_BASE_URL", value: "https://personal.example" }, { name: "OTHER", value: "keep" }] } });
  const original = structuredClone(h.docs);
  await h.app.start();
  assert.deepEqual(h.docs.claudeTerminal, original.claudeTerminal);
  assert.deepEqual(h.docs.vsCode["claudeCode.environmentVariables"], original.vsCode["claudeCode.environmentVariables"]);
});

it("Native startup recovery failure is visible and can be retried without restarting the app", async () => {
  let fail = true;
  const h = harness(undefined, { async setModelOptions(options) { if (fail && !options) throw new Error("synthetic restore failure"); } });
  await assert.doesNotReject(h.app.start());
  assert.equal(h.app.view().mode, "native");
  assert.match(h.app.view().notice ?? "", /恢復|重試/);
  fail = false;
  await h.app.setSwitch("native", "claude");
  assert.equal(h.app.view().notice, undefined);
});

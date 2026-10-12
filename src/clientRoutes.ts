import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { AdapterId } from "./adapters";

export const CLIENT_ROUTE_IDS = ["codex", "claudeCode", "vsCodeChat"] as const;

export type ClientRouteId = (typeof CLIENT_ROUTE_IDS)[number];
export type ClientRouteMode = "native" | "classroom";
export type ClientRouteHealth = "gray" | "red" | "yellow" | "green";
export type ClientRouteRestartState = "ready" | "restart-required";

export type ClientRouteState = {
  id: ClientRouteId;
  mode: ClientRouteMode;
  adapter: AdapterId;
  health: ClientRouteHealth;
  restart: ClientRouteRestartState;
};

export type ClientRoutes = Record<ClientRouteId, ClientRouteState>;

const SUPPORTED_ADAPTERS: Record<ClientRouteId, readonly AdapterId[]> = {
  codex: ["responses", "chat"],
  claudeCode: ["responses", "chat", "messages"],
  vsCodeChat: ["responses", "chat"],
};

export function supportedClientRouteAdapters(route: ClientRouteId): readonly AdapterId[] {
  return [...SUPPORTED_ADAPTERS[route]];
}

export function isClientRouteAdapter(route: ClientRouteId, adapter: string): adapter is AdapterId {
  return SUPPORTED_ADAPTERS[route].some(candidate => candidate === adapter);
}

export function defaultClientRoutes(): ClientRoutes {
  return {
    codex: { id: "codex", mode: "native", adapter: "responses", health: "gray", restart: "ready" },
    claudeCode: { id: "claudeCode", mode: "native", adapter: "responses", health: "gray", restart: "ready" },
    vsCodeChat: { id: "vsCodeChat", mode: "native", adapter: "responses", health: "gray", restart: "ready" },
  };
}

export type ClientRouteJournal<TOriginal = unknown, TIntended = unknown, TOwned = unknown> = {
  version: 1;
  route: ClientRouteId;
  original: TOriginal;
  intended: TIntended;
  owned: TOwned;
};

export interface ClientRouteJournalStorage {
  load(route: ClientRouteId): Promise<ClientRouteJournal | undefined>;
  save(journal: ClientRouteJournal): Promise<void>;
  clear(route: ClientRouteId): Promise<void>;
}

export type ClientRoutePreference = Pick<ClientRouteState, "mode" | "adapter">;
export type ClientRouteSettings = Record<ClientRouteId, ClientRoutePreference>;

export interface ClientRouteSettingsStorage {
  load(): Promise<ClientRouteSettings>;
  save(settings: ClientRouteSettings): Promise<void>;
}

export function defaultClientRouteSettings(): ClientRouteSettings {
  const routes = defaultClientRoutes();
  return {
    codex: { mode: routes.codex.mode, adapter: routes.codex.adapter },
    claudeCode: { mode: routes.claudeCode.mode, adapter: routes.claudeCode.adapter },
    vsCodeChat: { mode: routes.vsCodeChat.mode, adapter: routes.vsCodeChat.adapter },
  };
}

function isMode(value: unknown): value is ClientRouteMode {
  return value === "native" || value === "classroom";
}

function routePreference(route: ClientRouteId, value: unknown): ClientRoutePreference {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Client Route 設定格式無效。");
  const record = value as Record<string, unknown>;
  if (!isMode(record.mode) || typeof record.adapter !== "string" || !isClientRouteAdapter(route, record.adapter)) {
    throw new Error("Client Route 設定格式無效。");
  }
  return { mode: record.mode, adapter: record.adapter };
}

function parseClientRouteSettings(value: unknown): ClientRouteSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Client Route 設定格式無效。");
  const document = value as Record<string, unknown>;
  if (document.version === 1) {
    const adapters = document.adapters as Record<string, unknown> | undefined;
    if (!adapters || typeof adapters.codex !== "string" || !isClientRouteAdapter("codex", adapters.codex) ||
      typeof adapters.claude !== "string" || !isClientRouteAdapter("claudeCode", adapters.claude)) {
      throw new Error("Client Route 設定格式無效。");
    }
    return {
      codex: { mode: "native", adapter: adapters.codex },
      claudeCode: { mode: "native", adapter: adapters.claude },
      vsCodeChat: { mode: "native", adapter: "responses" },
    };
  }
  if (document.version !== 2 || !document.routes || typeof document.routes !== "object" || Array.isArray(document.routes)) {
    throw new Error("Client Route 設定版本無效。");
  }
  const routes = document.routes as Record<string, unknown>;
  return {
    codex: routePreference("codex", routes.codex),
    claudeCode: routePreference("claudeCode", routes.claudeCode),
    vsCodeChat: routePreference("vsCodeChat", routes.vsCodeChat),
  };
}

export function createClientRouteSettingsStorage(filename: string): ClientRouteSettingsStorage {
  return {
    async load() {
      let raw: string;
      try { raw = await fs.readFile(filename, "utf8"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultClientRouteSettings();
        throw new Error("無法讀取 Client Route 設定。");
      }
      let document: unknown;
      try { document = JSON.parse(raw); }
      catch { throw new Error("無法讀取 Client Route 設定。"); }
      return parseClientRouteSettings(document);
    },
    async save(settings) {
      const value: ClientRouteSettings = {
        codex: routePreference("codex", settings.codex),
        claudeCode: routePreference("claudeCode", settings.claudeCode),
        vsCodeChat: routePreference("vsCodeChat", settings.vsCodeChat),
      };
      await fs.mkdir(path.dirname(filename), { recursive: true });
      const temporary = `${filename}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, JSON.stringify({ version: 2, routes: value }) + "\n", "utf8");
        await fs.rename(temporary, filename);
      } finally { await fs.rm(temporary, { force: true }); }
    },
  };
}

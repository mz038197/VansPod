import type { AdapterClient, AdapterId } from "./adapters";
import { createClientRouteSettingsStorage } from "./clientRoutes";

export type AdapterSettings = { codex: "chat" | "responses"; claude: AdapterId };
export interface AdapterSettingsStorage {
  load(): Promise<AdapterSettings>;
  save(settings: AdapterSettings): Promise<void>;
}
export function defaultAdapters(): AdapterSettings { return { codex: "responses", claude: "responses" }; }
export function isAdapterChoice(client: AdapterClient, id: string): id is AdapterId {
  return id === "chat" || id === "responses" || (client === "claude" && id === "messages");
}
function settings(value: unknown): AdapterSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("無法讀取 adapter 設定。");
  const row = value as Record<string, unknown>;
  if (typeof row.codex !== "string" || !isAdapterChoice("codex", row.codex) || row.codex === "messages" || typeof row.claude !== "string" || !isAdapterChoice("claude", row.claude)) throw new Error("adapter 設定格式無效。");
  return { codex: row.codex, claude: row.claude };
}

// Non-secret app preferences are separate from Classroom Connection and survive its removal.
export function createAdapterSettingsStorage(filename: string): AdapterSettingsStorage {
  const routes = createClientRouteSettingsStorage(filename);
  return {
    async load() {
      const saved = await routes.load();
      return settings({ codex: saved.codex.adapter, claude: saved.claudeCode.adapter });
    },
    async save(next) {
      const value = settings(next);
      const saved = await routes.load();
      await routes.save({
        ...saved,
        codex: { ...saved.codex, adapter: value.codex },
        claudeCode: { ...saved.claudeCode, adapter: value.claude },
      });
    },
  };
}

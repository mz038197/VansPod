import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AdapterClient, AdapterId } from "./adapters";

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
  return {
    async load() {
      let raw: string;
      try { raw = await fs.readFile(filename, "utf8"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultAdapters(); throw new Error("無法讀取 adapter 設定。"); }
      const document = JSON.parse(raw) as { version?: unknown; adapters?: unknown };
      if (document?.version !== 1) throw new Error("adapter 設定版本無效。");
      return settings(document.adapters);
    },
    async save(next) {
      const value = settings(next);
      await fs.mkdir(path.dirname(filename), { recursive: true });
      const temporary = `${filename}.${randomUUID()}.tmp`;
      try { await fs.writeFile(temporary, JSON.stringify({ version: 1, adapters: value }) + "\n", "utf8"); await fs.rename(temporary, filename); }
      finally { await fs.rm(temporary, { force: true }); }
    },
  };
}

import type { ModelSwitchMode, NicknameRedeemResult } from "./classroomApp";

export type StorageResult = { persistence: "temporary" | "persistent" };

/** Reusable boundary for sensitive values. Implementations must never persist plaintext. */
export interface SecureStorage {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<StorageResult>;
  delete(key: string): Promise<void>;
}

export type ClassroomConnection = {
  version: 1;
  apiKey: string;
  session: NicknameRedeemResult["session"];
  nickname?: string;
  mode: ModelSwitchMode;
};

export interface ConnectionStorage {
  getConnection(): Promise<ClassroomConnection | undefined>;
  setConnection(connection: ClassroomConnection): Promise<StorageResult>;
  clearConnection(): Promise<void>;
}

/** One instance lives for one process; there is no disk fallback. */
export function createMemorySecureStorage(): SecureStorage {
  const values = new Map<string, string>();
  return {
    async get(key) { return values.get(key); },
    async set(key, value) {
      values.set(key, value);
      return { persistence: "temporary" };
    },
    async delete(key) { values.delete(key); },
  };
}

const CONNECTION_KEY = "classroom-connection";

export function createConnectionStorage(storage: SecureStorage): ConnectionStorage {
  return {
    async getConnection() {
      const raw = await storage.get(CONNECTION_KEY);
      if (raw === undefined) return undefined;
      let value: unknown;
      try { value = JSON.parse(raw); } catch { throw new Error("課堂連線資料無法讀取。請重新連線。"); }
      if (!isClassroomConnection(value)) throw new Error("課堂連線資料無法讀取。請重新連線。");
      return value;
    },
    async setConnection(connection) {
      if (!isClassroomConnection(connection)) throw new Error("課堂連線資料無法保存。");
      return storage.set(CONNECTION_KEY, JSON.stringify(connection));
    },
    async clearConnection() { await storage.delete(CONNECTION_KEY); },
  };
}

export function isClassroomConnection(value: unknown): value is ClassroomConnection {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<ClassroomConnection>;
  if (record.version !== 1 || typeof record.apiKey !== "string" || !record.apiKey ||
    (record.mode !== "native" && record.mode !== "classroom") ||
    (record.nickname !== undefined && typeof record.nickname !== "string") ||
    !record.session || typeof record.session !== "object" || Array.isArray(record.session)) return false;
  return ["class_name", "name", "invite_code", "expires_at"].every(field => {
    const item = (record.session as Record<string, unknown>)[field];
    return item === undefined || typeof item === "string";
  });
}

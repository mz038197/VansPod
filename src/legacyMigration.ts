import { type ClassroomConnection, type ConnectionStorage } from "./secureStorage";
import { StorageError } from "./storageErrors";
import type { ProtectedFiles } from "./windowsSecureStorage";

function legacyConnection(raw: string): ClassroomConnection | undefined {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return undefined; }
  if (!value || typeof value !== "object") return undefined;
  const legacy = value as Record<string, unknown>;
  if (legacy.secureStorage !== undefined || typeof legacy.apiKey !== "string" || !legacy.apiKey) return undefined;
  const session: ClassroomConnection["session"] = {};
  if (legacy.session && typeof legacy.session === "object") {
    const oldSession = legacy.session as Record<string, unknown>;
    for (const field of ["class_name", "name", "invite_code", "expires_at"] as const) {
      if (typeof oldSession[field] === "string") session[field] = oldSession[field];
    }
  }
  const connection: ClassroomConnection = { version: 1, apiKey: legacy.apiKey, session, mode: legacy.mode === "classroom" ? "classroom" : "native" };
  if (typeof legacy.nickname === "string") connection.nickname = legacy.nickname;
  return connection;
}

/** Startup migration is shared by all reads and settles before later mutations. */
export function createMigratingConnectionStorage(storage: ConnectionStorage, filePath: string, files: ProtectedFiles): ConnectionStorage {
  let loaded: Promise<ClassroomConnection | undefined> | undefined;
  async function migrate(): Promise<ClassroomConnection | undefined> {
    try { return await storage.getConnection(); }
    catch (error) {
      if (!(error instanceof StorageError) || error.code !== "legacy") throw error;
    }
    try {
      const legacy = legacyConnection(await files.read(filePath));
      if (!legacy) throw new StorageError("unavailable");
      // A strict save performs protect, decrypt verification, protected temp write and replacement.
      const result = await storage.setConnection(legacy);
      if (result.persistence !== "persistent") throw new StorageError("unavailable");
      return legacy;
    } catch {
      try {
        await files.remove(filePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw new StorageError("legacy-cleanup-failed");
      }
      throw new StorageError("migration-failed");
    }
  }
  function initialize() {
    if (!loaded) {
      loaded = migrate();
      void loaded.catch(() => {});
    }
    return loaded;
  }
  return {
    async getConnection() {
      const connection = await initialize();
      return connection && structuredClone(connection);
    },
    async setConnection(connection, options) {
      await initialize().catch(() => {});
      const result = await storage.setConnection(connection, options);
      loaded = Promise.resolve(structuredClone(connection));
      return result;
    },
    async clearConnection() {
      await initialize().catch(() => {});
      await storage.clearConnection();
      loaded = Promise.resolve(undefined);
    },
  };
}

import {
  createConnectionStorage, createMemorySecureStorage,
  type ClassroomConnection, type ConnectionStorage, type StorageResult,
} from "./secureStorage";
import { createWindowsSecureStorage, protectedFiles, StorageError, type WindowsStorageOptions } from "./windowsSecureStorage";
import { createMigratingConnectionStorage } from "./legacyMigration";

/** Read once; unsuccessful reads remain distinguishable until a successful new redeem. */
export function createPersistentConnectionStorage(persistent: ConnectionStorage): ConnectionStorage {
  const memory = createConnectionStorage(createMemorySecureStorage());
  let temporary = false;
  let loaded: Promise<ClassroomConnection | undefined> | undefined;
  let writes: Promise<unknown> = Promise.resolve();
  const serial = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = writes.then(operation, operation);
    writes = next.catch(() => {});
    return next;
  };
  return {
    async getConnection() {
      if (temporary) return memory.getConnection();
      if (!loaded) {
        loaded = persistent.getConnection();
        // A failed initialization may be inspected again later without an unhandled rejection.
        void loaded.catch(() => {});
      }
      const value = await loaded;
      return value && structuredClone(value);
    },
    setConnection(connection, options) {
      const snapshot = structuredClone(connection);
      return serial(async () => {
        if (temporary && !options?.allowTemporary) return memory.setConnection(snapshot);
        let result: StorageResult;
        try { result = await persistent.setConnection(snapshot); }
        catch {
          if (!options?.allowTemporary) throw new StorageError("unavailable");
          // Read failure is never absence. Clear must succeed before memory can become authoritative.
          try { await persistent.clearConnection(); }
          catch { throw new StorageError("clear-failed"); }
          result = await memory.setConnection(snapshot);
        }
        temporary = result.persistence === "temporary";
        loaded = Promise.resolve(snapshot);
        if (!temporary) await memory.clearConnection();
        return result;
      });
    },
    clearConnection() {
      return serial(async () => {
        try { await persistent.clearConnection(); }
        catch { throw new StorageError("clear-failed"); }
        await memory.clearConnection();
        temporary = false;
        loaded = Promise.resolve(undefined);
      });
    },
  };
}

export function createPlatformConnectionStorage(filePath: string, options: WindowsStorageOptions & { platform?: NodeJS.Platform } = {}): ConnectionStorage {
  const windows = (options.platform ?? process.platform) === "win32";
  // Other platforms may inspect/delete the old file, but cannot decrypt or persist credentials.
  const unavailableProtector = {
    async protect(): Promise<string> { throw new StorageError("unavailable"); },
    async unprotect(): Promise<string> { throw new StorageError("unavailable"); },
  };
  const persistent = createConnectionStorage(createWindowsSecureStorage(filePath, {
    ...options, protector: windows ? options.protector : unavailableProtector,
  }));
  return createPersistentConnectionStorage(createMigratingConnectionStorage(persistent, filePath, options.files ?? protectedFiles));
}

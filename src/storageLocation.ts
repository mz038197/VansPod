import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import type { ConnectionStorage } from "./secureStorage";
import { StorageError } from "./storageErrors";

/** Move the existing envelope unchanged; the secure adapter handles decryption and plaintext migration. */
export function relocateConnectionStorage(storage: ConnectionStorage, target: string, legacy: string): ConnectionStorage {
  let initialized: Promise<void> | undefined;
  async function removeLegacy() {
    try { await fs.unlink(legacy); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new StorageError("clear-failed"); }
  }
  async function relocate() {
    try {
      await fs.access(legacy);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new StorageError("unavailable");
    }
    try {
      await fs.mkdir(path.dirname(target), { recursive: true });
      // Never overwrite a newer connection. Exclusive copying also supports different drives.
      await fs.copyFile(legacy, target, constants.COPYFILE_EXCL);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new StorageError("unavailable");
    }
    await removeLegacy();
  }
  function initialize() {
    if (!initialized) initialized = relocate();
    return initialized;
  }
  return {
    async getConnection() { await initialize(); return storage.getConnection(); },
    async setConnection(connection, options) { await initialize(); return storage.setConnection(connection, options); },
    async clearConnection() {
      await initialize().catch(() => {});
      await removeLegacy();
      await storage.clearConnection();
      initialized = Promise.resolve();
    },
  };
}

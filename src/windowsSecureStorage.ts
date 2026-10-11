import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { SecureStorage } from "./secureStorage";

import { StorageError } from "./storageErrors";
export { StorageError, type StorageErrorCode } from "./storageErrors";

export interface DataProtector {
  protect(plaintext: string): Promise<string>;
  unprotect(ciphertext: string): Promise<string>;
}

export type ProtectorOptions = { launch?: typeof spawn; timeoutMs?: number; maxBytes?: number };

export function createWindowsDataProtector(options: ProtectorOptions = {}): DataProtector {
  const launch = options.launch ?? spawn;
  const maxBytes = options.maxBytes ?? 2_097_152;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const executable = path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  function run(operation: "Protect" | "Unprotect", input: string): Promise<string> {
    if (Buffer.byteLength(input, "utf8") > maxBytes) return Promise.reject(new StorageError("unavailable"));
    const transform = operation === "Protect"
      ? "$bytes = [Text.Encoding]::UTF8.GetBytes($payload); $out = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($out))"
      : "$bytes = [Convert]::FromBase64String($payload); $out = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Text.Encoding]::UTF8.GetString($out))";
    const command = "$ErrorActionPreference = 'Stop'; [Console]::InputEncoding = New-Object Text.UTF8Encoding($false); [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false); try { Add-Type -AssemblyName System.Security; $payload = [Console]::In.ReadToEnd(); " + transform + " } catch { exit 1 }";
    return new Promise((resolve, reject) => {
      let child: ReturnType<typeof spawn>;
      try { child = launch(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }); }
      catch { reject(new StorageError("unavailable")); return; }
      let finished = false;
      let bytes = 0;
      const output: Buffer[] = [];
      const finish = (failed: boolean) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (failed) { child.kill(); reject(new StorageError("unavailable")); }
        else resolve(Buffer.concat(output).toString("utf8"));
      };
      const timer = setTimeout(() => finish(true), timeoutMs);
      child.on("error", () => finish(true));
      child.stdin?.on("error", () => finish(true));
      child.stdout?.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > maxBytes) { finish(true); return; }
        output.push(chunk);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        // Never forward raw PowerShell diagnostics; they may contain sensitive input.
        bytes += chunk.length;
        if (bytes > maxBytes) finish(true);
      });
      child.on("close", code => finish(code !== 0));
      child.stdin?.end(input, "utf8");
    });
  }
  return { protect: value => run("Protect", value), unprotect: value => run("Unprotect", value) };
}

export interface ProtectedFiles {
  read(file: string): Promise<string>;
  write(file: string, contents: string): Promise<void>;
  replace(source: string, target: string): Promise<void>;
  remove(file: string): Promise<void>;
  mkdir(directory: string): Promise<void>;
}

export const protectedFiles: ProtectedFiles = {
  read: file => fs.readFile(file, "utf8"),
  async write(file, contents) {
    const handle = await fs.open(file, "wx", 0o600);
    try { await handle.writeFile(contents, "utf8"); await handle.sync(); }
    finally { await handle.close(); }
  },
  replace: (source, target) => fs.rename(source, target),
  remove: file => fs.unlink(file),
  async mkdir(directory) { await fs.mkdir(directory, { recursive: true }); },
};

export type WindowsStorageOptions = { protector?: DataProtector; files?: ProtectedFiles };

function absent(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === "ENOENT"; }

export function createWindowsSecureStorage(filePath: string, options: WindowsStorageOptions = {}): SecureStorage {
  const protector = options.protector ?? createWindowsDataProtector();
  const files = options.files ?? protectedFiles;
  const fileFor = (key: string) => key === "classroom-connection" ? filePath :
    path.join(path.dirname(filePath), `secure-${createHash("sha256").update(key).digest("hex")}.json`);
  return {
    async get(key) {
      let raw: string;
      try { raw = await files.read(fileFor(key)); }
      catch (error) { if (absent(error)) return undefined; throw new StorageError("unavailable"); }
      let value: unknown;
      try { value = JSON.parse(raw); }
      catch { throw new StorageError("unreadable"); }
      if (!value || typeof value !== "object") throw new StorageError("unreadable");
      const envelope = value as Record<string, unknown>;
      if (typeof envelope.apiKey === "string" && envelope.apiKey && envelope.secureStorage === undefined) throw new StorageError("legacy");
      if (envelope.secureStorage !== 1 || envelope.scheme !== "dpapi-current-user" ||
        typeof envelope.ciphertext !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.ciphertext)) throw new StorageError("unreadable");
      try { return await protector.unprotect(envelope.ciphertext); }
      catch { throw new StorageError("unreadable"); }
    },
    async set(key, value) {
      const target = fileFor(key);
      const temporary = `${target}.${randomUUID()}.tmp`;
      try {
        const ciphertext = await protector.protect(value);
        if (!/^[A-Za-z0-9+/]+={0,2}$/.test(ciphertext) || await protector.unprotect(ciphertext) !== value) throw new StorageError("unavailable");
        const envelope = JSON.stringify({ secureStorage: 1, scheme: "dpapi-current-user", ciphertext });
        await files.mkdir(path.dirname(target));
        await files.write(temporary, envelope);
        await files.replace(temporary, target);
        return { persistence: "persistent" };
      } catch { throw new StorageError("unavailable"); }
      finally { try { await files.remove(temporary); } catch { /* Only encrypted abandoned data is possible. */ } }
    },
    async delete(key) {
      try { await files.remove(fileFor(key)); }
      catch (error) { if (!absent(error)) throw new StorageError("clear-failed"); }
    },
  };
}

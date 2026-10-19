import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { VERSION } from "./version";

export type Instance = { pid: number; id: string; token: string; version: string; origin?: string };
export type ControlResult = { id: string; ok?: boolean; running?: boolean; ready?: boolean; startupError?: string; pid?: number; version?: string; origin?: string; message?: string; confirmation?: boolean; launchVersion?: string; trayError?: string; activeRequests?: number; installing?: boolean };
export const dataDirectory = () => path.join(os.homedir(), ".vanspod");
export const managementDirectory = () => path.join(process.env.LOCALAPPDATA || os.homedir(), "VansPod");
const lockDirectory = () => path.join(managementDirectory(), "runtime");
const stateFile = () => path.join(lockDirectory(), "instance.json");

export async function readInstance(): Promise<Instance | undefined> {
  try {
    const value = JSON.parse(await fs.readFile(stateFile(), "utf8")) as Instance;
    if (!Number.isSafeInteger(value.pid) || value.pid < 1 || !/^[a-f0-9]{64}$/.test(value.token) || !/^[a-f0-9]{32}$/.test(value.id) || typeof value.version !== "string" || (value.origin !== undefined && !/^http:\/\/127\.0\.0\.1:\d+$/.test(value.origin))) throw new Error("VansPod 執行狀態格式無效。");
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

export async function removalInProgress(): Promise<boolean> {
  try {
    const value = JSON.parse(await fs.readFile(path.join(managementDirectory(), "uninstall-ready"), "utf8")) as {pid: number};
    return !Number.isSafeInteger(value.pid) || isAlive(value.pid);
  } catch (error) { return (error as NodeJS.ErrnoException).code !== "ENOENT"; }
}

export async function saveInstance(instance: Instance): Promise<void> {
  const temporary = `${stateFile()}.${instance.id}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(instance), { mode: 0o600 });
  for (let attempt = 0; ; attempt++) {
    try { await fs.rename(temporary, stateFile()); return; }
    catch (error) {
      if (attempt >= 40 || !["EPERM", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      // Windows may briefly hold the old record while a launcher reads it.
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
}

export async function releaseInstance(id: string): Promise<void> {
  if ((await readInstance())?.id !== id) return;
  const retired = path.join(lockDirectory(), `retired-${id}.json`);
  try { await fs.rename(stateFile(), retired); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  const actual = JSON.parse(await fs.readFile(retired, "utf8")) as Instance;
  if (actual.id !== id) { await fs.rename(retired, stateFile()); return; }
  await fs.rm(retired);
  await fs.rmdir(lockDirectory()).catch(error => { if (!['ENOENT', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; });
}

export async function reserveInstance(): Promise<{ instance: Instance; owner: boolean }> {
  await fs.mkdir(managementDirectory(), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await removalInProgress()) throw new Error("VansPod 完整移除中，請等待移除結果。");
    try {
      await fs.mkdir(lockDirectory(), { mode: 0o700 });
      if (await removalInProgress()) { await fs.rmdir(lockDirectory()); throw new Error("VansPod 完整移除中，請等待移除結果。"); }
      const instance: Instance = { pid: process.pid, id: randomBytes(16).toString("hex"), token: randomBytes(32).toString("hex"), version: VERSION };
      await saveInstance(instance);
      return { instance, owner: true };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const existing = await readInstance();
    if (!existing) {
      const files = await fs.readdir(lockDirectory()).catch(() => []);
      let removedRetired = false;
      for (const file of files.filter(name => /^retired-[a-f0-9]{32}\.json$/.test(name))) {
        const retired = path.join(lockDirectory(), file);
        const value = await fs.readFile(retired, "utf8").then(raw => JSON.parse(raw) as Instance).catch(() => undefined);
        if (value && file === `retired-${value.id}.json` && !isAlive(value.pid)) { await fs.rm(retired, { force: true }); removedRetired = true; }
      }
      for (const file of files) {
        const temporary = /^instance\.json\.[a-f0-9]{32}\.(\d+)\.tmp$/.exec(file);
        if (temporary && !isAlive(Number(temporary[1]))) { await fs.rm(path.join(lockDirectory(), file), {force: true}); removedRetired = true; }
      }
      const state = await fs.stat(lockDirectory()).catch(() => undefined);
      if (state && (removedRetired || Date.now() - state.mtimeMs > 30000)) await fs.rmdir(lockDirectory()).catch(() => undefined);
    }
    if (existing && !isAlive(existing.pid)) {
      await releaseInstance(existing.id).catch(() => undefined);
    } else if (existing?.origin) {
      return { instance: existing, owner: false };
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("VansPod 正在啟動或未回應，請稍後重試。");
}

export async function control(instance: Instance, action: string, body?: unknown): Promise<ControlResult> {
  if (!instance.origin) throw new Error("VansPod 尚未完成啟動。");
  const response = await fetch(`${instance.origin}/_vanspod/${action}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${instance.token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error("VansPod 管理操作授權失敗，請確認本機執行紀錄。");
  const result = await response.json() as ControlResult;
  if (result.id !== instance.id) throw new Error("VansPod 實例身分驗證失敗。");
  return result;
}

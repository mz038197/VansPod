import { createHash } from "node:crypto";
import { isSea } from "node:sea";
import fs from "node:fs/promises";
import path from "node:path";
import { managementDirectory, removalInProgress } from "./instance";

export type Installation = { kind: "exe"; file: string; sha256: string } | { kind: "npm"; root: string; prefix: string; node: string; npmCli: string };
const manifestFile = () => path.join(managementDirectory(), "installations.json");

export async function installations(): Promise<Installation[]> {
  try {
    const value: unknown = JSON.parse(await fs.readFile(manifestFile(), "utf8"));
    if (!Array.isArray(value) || value.some(item => !item || (item.kind !== "exe" && item.kind !== "npm"))) throw new Error("VansPod 安裝紀錄無效，請先修復再移除。");
    return value as Installation[];
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

/** 目前這個行程是哪一份可登記的安裝；原始碼執行時沒有。 */
export async function detectInstallation(): Promise<Installation | undefined> {
  if (isSea()) return { kind: "exe", file: process.execPath, sha256: createHash("sha256").update(await fs.readFile(process.execPath)).digest("hex") };
  const root = path.resolve(__dirname, "..");
  if (path.basename(root).toLowerCase() !== "vanspod" || path.basename(path.dirname(root)) !== "node_modules") return undefined;
  const npmCli = process.env.npm_execpath && path.basename(process.env.npm_execpath) === "npm-cli.js"
    ? process.env.npm_execpath : path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  return await fs.stat(npmCli).catch(() => undefined) ? { kind: "npm", root, prefix: path.dirname(path.dirname(root)), node: process.execPath, npmCli } : undefined;
}

export async function registerInstallation(): Promise<void> {
  if (await removalInProgress()) throw new Error("VansPod 完整移除中，請稍後重試。");
  const installation = await detectInstallation();
  if (!installation) return;
  await fs.mkdir(managementDirectory(), { recursive: true });
  const lock = path.join(managementDirectory(), "installations.lock");
  let acquired = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await fs.mkdir(lock); acquired = true; break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (!acquired) throw new Error("安裝紀錄正在更新，請稍後重試。");
  try {
    const previous = await installations();
    const location = (item: Installation) => (item.kind === "exe" ? item.file : item.root).toLowerCase();
    const updated = [...previous.filter(item => location(item) !== location(installation!)), installation];
    const temporary = `${manifestFile()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(updated), { mode: 0o600 });
    await fs.rename(temporary, manifestFile());
  } finally { await fs.rmdir(lock); }
}

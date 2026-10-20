import fs from "node:fs/promises";
import path from "node:path";

/** 只保留最近幾次 Environment Install 的紀錄，避免佔滿學生硬碟。 */
export const KEPT_INSTALL_LOGS = 10;

export type InstallLogFile = {
  /** 本次安裝的紀錄資料夾：<管理資料夾>\InstallLogs\<時間>。 */
  folder: string;
  /** 依呼叫順序附加到 install.log；寫不進去也不影響安裝。 */
  append(text: string): Promise<void>;
};

function stamp(date: Date): string {
  const two = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}_${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`;
}

async function createRunFolder(root: string, name: string): Promise<string> {
  await fs.mkdir(root, { recursive: true });
  for (let attempt = 1; ; attempt += 1) {
    const folder = path.join(root, attempt === 1 ? name : `${name}-${attempt}`);
    try {
      await fs.mkdir(folder);
      return folder;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

async function pruneOldLogs(root: string): Promise<void> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  // 資料夾名稱以時間開頭，字串排序就是時間順序。
  const folders = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  const old = folders.slice(0, Math.max(0, folders.length - KEPT_INSTALL_LOGS));
  await Promise.all(old.map((name) => fs.rm(path.join(root, name), { recursive: true, force: true }).catch(() => {})));
}

/** 在 <managementDirectory>\InstallLogs 下建立本次安裝的紀錄資料夾，並刪掉超過保留數量的舊紀錄。 */
export async function startInstallLogFile(managementDirectory: string, now: Date): Promise<InstallLogFile> {
  const root = path.join(managementDirectory, "InstallLogs");
  const folder = await createRunFolder(root, stamp(now));
  await pruneOldLogs(root).catch(() => {});
  const file = path.join(folder, "install.log");
  let pending: Promise<void> = Promise.resolve();
  return {
    folder,
    append(text) {
      pending = pending.then(() => fs.appendFile(file, text, "utf8")).catch(() => {});
      return pending;
    },
  };
}

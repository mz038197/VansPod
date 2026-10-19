import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Installation } from "./installations";
import { asset } from "./desktop";
import { managementDirectory } from "./instance";
import { startHiddenTool } from "./removal";

export const RELEASES_URL = "https://github.com/mz038197/VansPod/releases";
// 測試以環境變數換成假的 registry 與下載來源。
const registryUrl = () => process.env.VANSPOD_UPDATE_REGISTRY ?? "https://registry.npmjs.org/vanspod/latest";
const downloadBase = (version: string) => `${process.env.VANSPOD_UPDATE_DOWNLOADS ?? `${RELEASES_URL}/download`}/v${version}`;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
export const CHECK_DELAY_MS = 30_000;
export const CHECK_INTERVAL_MS = 6 * 60 * 60_000;

/** 依 semver 比較；同號時預發佈版本比正式版舊。 */
export function compareVersions(a: string, b: string): number {
  const split = (value: string) => {
    const dash = value.indexOf("-");
    return { core: (dash < 0 ? value : value.slice(0, dash)).split(".").map(Number), pre: dash < 0 ? "" : value.slice(dash + 1) };
  };
  const left = split(a), right = split(b);
  for (let index = 0; index < 3; index++) if (left.core[index] !== right.core[index]) return Math.sign(left.core[index] - right.core[index]);
  if (left.pre === right.pre) return 0;
  if (!left.pre) return 1;
  if (!right.pre) return -1;
  return Math.sign(left.pre.localeCompare(right.pre, "en", { numeric: true }));
}

export async function fetchLatestVersion(): Promise<string> {
  const response = await fetch(registryUrl(), { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`npm registry 回應 ${response.status}`);
  const version = (await response.json() as { version?: unknown }).version;
  if (typeof version !== "string" || !VERSION_PATTERN.test(version)) throw new Error("npm registry 回應格式無效");
  return version;
}

/** 正在執行的這一份：登記得到的 exe／npm 安裝，或原始碼執行。 */
export type UpdateSource = Installation | { kind: "source" };

/** 不能更新的原因；可以更新時為 undefined。模型回答中不算，改由確認處理。 */
export function updateBlock(source: UpdateSource, work: { installing: boolean }, writable: boolean): string | undefined {
  if (source.kind === "source") return "從原始碼執行的 VansPod 無法自動更新，請用 git pull 後重新建置。";
  if (work.installing) return "安裝進行中，完成後才能更新。";
  if (source.kind === "exe" && !writable) return "VansPod.exe 所在的資料夾無法寫入，請到 GitHub 下載新版。";
  return undefined;
}

export function updateAction(source: UpdateSource, version: string): string | undefined {
  if (source.kind === "exe") return `將下載 VansPod.exe v${version} 並驗證，接著取代 ${source.file}，完成後重新啟動 VansPod。`;
  if (source.kind === "npm") return `將執行 npm install -g vanspod@${version}，完成後重新啟動 VansPod。`;
  return undefined;
}

export type UpdateCheck = { latest?: string; checkedAt?: number; error?: string };

/** 背景檢查：啟動後延遲一次，之後固定間隔；結果只放記憶體，失敗時保留上次查到的版本。 */
export function createUpdateChecker(fetchLatest: () => Promise<string> = fetchLatestVersion) {
  let state: UpdateCheck = {};
  let pending: Promise<UpdateCheck> | undefined;
  const check = () => pending ??= fetchLatest()
    .then(latest => (state = { latest, checkedAt: Date.now() }))
    .catch((error: unknown) => (state = { latest: state.latest, checkedAt: Date.now(), error: error instanceof Error ? error.message : "檢查失敗" }))
    .finally(() => { pending = undefined; });
  return {
    check,
    state: () => state,
    start() {
      const first = setTimeout(() => { void check(); }, CHECK_DELAY_MS);
      const every = setInterval(() => { void check(); }, CHECK_INTERVAL_MS);
      first.unref(); every.unref();
    },
  };
}

export function checksumFor(sums: string, name: string): string {
  for (const line of sums.split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})\s+\*?(.+)$/i.exec(line.trim());
    if (match && match[2] === name) return match[1].toLowerCase();
  }
  throw new Error(`SHA256SUMS.txt 沒有 ${name}`);
}

/** 從 GitHub Release 下載新版 exe 到原檔旁的 `.new`；SHA-256 不符就刪掉並失敗。 */
export async function downloadExe(version: string, file: string, onProgress: (percent: number) => void, fetcher: typeof fetch = fetch): Promise<string> {
  const get = async (name: string) => {
    const response = await fetcher(`${downloadBase(version)}/${name}`, { signal: AbortSignal.timeout(10 * 60_000) });
    if (!response.ok || !response.body) throw new Error(`下載 ${name} 失敗（${response.status}）`);
    return response;
  };
  const expected = checksumFor(await (await get("SHA256SUMS.txt")).text(), "VansPod.exe");
  const response = await get("VansPod.exe");
  const total = Number(response.headers.get("content-length")) || 0;
  const target = `${file}.new`;
  const hash = createHash("sha256");
  const handle = await fs.open(target, "w");
  let received = 0;
  try {
    const reader = response.body!.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
      await handle.write(value);
      received += value.length;
      if (total) onProgress(Math.min(100, Math.floor(received * 100 / total)));
    }
  } finally { await handle.close(); }
  if (hash.digest("hex") !== expected) { await fs.rm(target, { force: true }); throw new Error("下載的 VansPod.exe 驗證失敗，已刪除。"); }
  return target;
}

export async function folderWritable(file: string): Promise<boolean> {
  const probe = path.join(path.dirname(file), `.vanspod-write-${process.pid}.tmp`);
  try { await fs.writeFile(probe, ""); await fs.rm(probe); return true; }
  catch { return false; }
}

export type UpdatePhase = "idle" | "downloading" | "restarting";

export type UpdateStatus = {
  ok: true; current: string; latest?: string; available: boolean; source: UpdateSource["kind"];
  block?: string; action?: string; checkError?: string; releasesUrl: string;
  phase: UpdatePhase; progress?: number;
  /** 這一次按下更新失敗的原因（VansPod 還沒結束前）。 */
  error?: string;
  /** 上一次更新工具的結果，重新啟動後只回報一次。 */
  lastResult?: UpdateResult;
};

export type UpdateRun = { ok: boolean; confirmation?: boolean; message?: string };

/**
 * 側欄圓鈕背後的版本更新：查狀態、按下更新。
 * 按下後在背景下載與驗證，再由 `exit` 恢復客戶端設定、啟動更新工具並結束 VansPod。
 */
export function createVersionUpdate(options: {
  current: string;
  source: UpdateSource;
  work: () => { installing: boolean; activeRequests: number };
  exit: (launchTool: () => Promise<void>) => Promise<void>;
  checker?: ReturnType<typeof createUpdateChecker>;
}) {
  const checker = options.checker ?? createUpdateChecker();
  const { current, source } = options;
  let phase: UpdatePhase = "idle";
  let progress: number | undefined;
  let error: string | undefined;
  const snapshot = async (refresh: boolean): Promise<UpdateStatus> => {
    if (refresh) await checker.check();
    const check = checker.state();
    const available = !!check.latest && compareVersions(check.latest, current) > 0;
    const writable = source.kind === "exe" ? await folderWritable(source.file) : true;
    return {
      ok: true, current, latest: check.latest, available, source: source.kind,
      block: updateBlock(source, options.work(), writable),
      action: available ? updateAction(source, check.latest!) : undefined,
      checkError: check.error, releasesUrl: RELEASES_URL, phase, progress, error,
    };
  };
  const install = async (installation: Installation, target: string) => {
    try {
      let download: string | undefined;
      if (installation.kind === "exe") download = await downloadExe(target, installation.file, percent => { progress = percent; });
      phase = "restarting";
      await options.exit(await prepareUpdate({ pid: process.pid, from: current, target, headless: process.env.CLASSROOM_APP_HEADLESS === "1", installation, download }));
    } catch (failure) {
      phase = "idle"; progress = undefined;
      error = `更新未完成：${failure instanceof Error ? failure.message : "未知錯誤"}`;
      if (installation.kind === "exe") await fs.rm(`${installation.file}.new`, { force: true });
    }
  };
  return {
    async status(refresh = false): Promise<UpdateStatus> {
      // 更新工具等新版就緒後才寫出結果，所以每次都要讀；讀到就刪，只回報一次。
      const lastResult = await takeUpdateResult();
      return { ...await snapshot(refresh), lastResult };
    },
    start: () => checker.start(),
    async run(body: { interruptConfirmed?: boolean }): Promise<UpdateRun> {
      if (phase !== "idle") return { ok: false, message: "更新已在進行中。" };
      const now = await snapshot(true);
      if (!now.available) return { ok: false, message: now.latest ? `v${current} 已是最新版本。` : "暫時查不到最新版本，請稍後再試。" };
      if (now.block || source.kind === "source") return { ok: false, message: now.block };
      if (options.work().activeRequests && body.interruptConfirmed !== true) return { ok: false, confirmation: true, message: "仍有模型回答，更新會中斷目前回答。確定要更新？" };
      phase = source.kind === "exe" ? "downloading" : "restarting";
      progress = undefined; error = undefined;
      void install(source, now.latest!);
      return { ok: true };
    },
  };
}

export type UpdateResult = { ok: boolean; from: string; target: string; message?: string };

/** 讀出並清掉上一次更新工具留下的結果。 */
export async function takeUpdateResult(): Promise<UpdateResult | undefined> {
  const file = path.join(managementDirectory(), "update-result.json");
  try {
    const raw = (await fs.readFile(file, "utf8")).replace(/^﻿/, "");
    await fs.rm(file, { force: true });
    const value = JSON.parse(raw) as UpdateResult;
    return typeof value.ok === "boolean" && typeof value.target === "string" ? value : undefined;
  } catch { return undefined; }
}

export type UpdatePlan = {
  version: 1;
  root: string;
  pid: number;
  from: string;
  target: string;
  headless: boolean;
  installation: Installation;
  /** exe：已驗證、放在原檔旁的新版。 */
  download?: string;
  /** 換好之後啟動 VansPod 的指令；它會等到就緒才結束。 */
  start: { file: string; args: string[] };
};

/** 寫出更新工具與計畫；回傳的函式啟動工具，之後 VansPod 必須自己結束。 */
export async function prepareUpdate(plan: Omit<UpdatePlan, "version" | "root" | "start">): Promise<() => Promise<void>> {
  const root = managementDirectory();
  const script = path.join(root, "update-tool.ps1");
  const file = path.join(root, "update-plan.json");
  const start = plan.installation.kind === "exe"
    ? { file: plan.installation.file, args: ["start"] }
    : { file: plan.installation.node, args: [path.join(plan.installation.root, "bin", "vanspod.cjs"), "start"] };
  await fs.writeFile(script, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), await asset("update.ps1")]));
  await fs.writeFile(file, JSON.stringify({ version: 1, root, start, ...plan } satisfies UpdatePlan), { mode: 0o600 });
  return () => startHiddenTool(script, file, path.join(root, "update-ready"), "更新工具");
}

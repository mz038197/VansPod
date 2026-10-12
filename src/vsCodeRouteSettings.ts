import { isDeepStrictEqual } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import type { AdapterId } from "./adapters";

export type VsCodeProvider = Record<string, unknown> & {
  name?: string;
  vendor?: string;
  models?: unknown[];
};

type Journal = {
  version: 1;
  route: "vsCodeChat";
  original: VsCodeProvider | null;
  intended: VsCodeProvider;
  owned: { name: "VCRouter"; vendor: "customendpoint" };
};

function isJournal(value: unknown): value is Journal {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<Journal>;
  return item.version === 1 && item.route === "vsCodeChat" && !!item.intended && typeof item.intended === "object" &&
    !!item.owned && item.owned.name === "VCRouter" && item.owned.vendor === "customendpoint";
}

export type VsCodeRouteSettings = {
  publish(options: { providers: VsCodeProvider[]; adapter: Extract<AdapterId, "responses" | "chat">; origin: string }): Promise<{ changed: boolean }>;
  restore(): Promise<{ changed: boolean }>;
  initializeNative(): Promise<{ changed: boolean }>;
};

function asProviderArray(value: unknown): VsCodeProvider[] {
  if (!Array.isArray(value) || value.some(item => !item || typeof item !== "object" || Array.isArray(item))) {
    throw new Error("VS Code Chat 模型設定格式無效。");
  }
  return value as VsCodeProvider[];
}

async function readProviders(filename: string): Promise<VsCodeProvider[]> {
  let raw: string;
  try { raw = await fs.readFile(filename, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  try { return asProviderArray(JSON.parse(raw)); }
  catch (error) {
    if (error instanceof SyntaxError) throw new Error("VS Code Chat 模型設定不是合法 JSON。");
    throw error;
  }
}

async function atomicJson(filename: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await fs.rename(temporary, filename);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function readJournal(filename: string): Promise<Journal | undefined> {
  let raw: string;
  try { raw = await fs.readFile(filename, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error("VS Code Chat 設定 journal 已損毀。"); }
  if (!isJournal(parsed)) throw new Error("VS Code Chat 設定 journal 已損毀。");
  return parsed;
}

function namedIndexes(providers: VsCodeProvider[]): number[] {
  const result: number[] = [];
  providers.forEach((provider, index) => {
    if (provider.name === "VCRouter") result.push(index);
  });
  return result;
}

function containsOldExtensionSecret(provider: VsCodeProvider): boolean {
  return JSON.stringify(provider).includes("${input:chat.lm.secret.");
}

function classroomTemplate(providers: VsCodeProvider[]): VsCodeProvider {
  const found = providers.find(provider => provider.name === "VCRouter" && provider.vendor === "customendpoint");
  if (!found) throw new Error("Router 沒有提供 VS Code Chat 模型設定。");
  return found;
}

const CREDENTIAL_KEYS = new Set([
  "apikey",
  "xapikey",
  "authorization",
  "proxyauthorization",
  "token",
  "accesstoken",
  "credential",
  "credentials",
  "password",
  "secret",
  "secretref",
]);

function withoutCredentials(value: unknown): unknown {
  if (typeof value === "string" && value.includes("${input:chat.lm.secret.")) return undefined;
  if (Array.isArray(value)) {
    return value.map(withoutCredentials).filter(item => item !== undefined);
  }
  if (!value || typeof value !== "object") return value;
  const clean: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (CREDENTIAL_KEYS.has(normalized)) continue;
    const sanitized = withoutCredentials(item);
    if (sanitized !== undefined) clean[key] = sanitized;
  }
  return clean;
}

function intendedProvider(template: VsCodeProvider, adapter: "responses" | "chat", origin: string): VsCodeProvider {
  const provider = withoutCredentials(structuredClone(template)) as VsCodeProvider;
  provider.name = "VCRouter";
  provider.vendor = "customendpoint";
  provider.apiType = adapter;
  provider.models = (Array.isArray(provider.models) ? provider.models : []).map(value => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const model = structuredClone(value as Record<string, unknown>);
    model.url = `${origin.replace(/\/$/, "")}/v1`;
    model.apiType = adapter;
    return model;
  });
  return provider;
}

export function createVsCodeRouteSettings(options: { settingsFile: string; journalFile: string; legacyOrigins?: string[] }): VsCodeRouteSettings {
  const restore = async (): Promise<{ changed: boolean }> => {
    const journal = await readJournal(options.journalFile);
    if (!journal) return { changed: false };
    const current = await readProviders(options.settingsFile);
    const indexes = namedIndexes(current);
    if (indexes.length !== 1 || !isDeepStrictEqual(current[indexes[0]!], journal.intended)) {
      throw new Error("VS Code 的 VCRouter provider 已被其他程式修改，VansPod 不會覆寫。");
    }
    const next = current.filter((_provider, index) => index !== indexes[0]);
    await atomicJson(options.settingsFile, next);
    await fs.rm(options.journalFile, { force: true });
    return { changed: true };
  };
  return {
    async publish({ providers, adapter, origin }) {
      const current = await readProviders(options.settingsFile);
      const intended = intendedProvider(classroomTemplate(providers), adapter, origin);
      const journal = await readJournal(options.journalFile);
      let original: VsCodeProvider | null = null;
      let next: VsCodeProvider[];
      if (journal) {
        const indexes = namedIndexes(current);
        if (indexes.length !== 1 || !isDeepStrictEqual(current[indexes[0]!], journal.intended)) {
          throw new Error("VS Code 的 VCRouter provider 已被其他程式修改，VansPod 不會覆寫。");
        }
        original = journal.original;
        next = current.map((provider, index) => index === indexes[0] ? intended : provider);
      } else {
        const existing = namedIndexes(current).map(index => current[index]!);
        if (existing.some(containsOldExtensionSecret)) {
          throw new Error("偵測到舊擴充的 VCRouter provider。請先在舊擴充清除舊擴充的 Classroom Connection，再回到 VansPod 重新載入。");
        }
        if (existing.length > 0) {
          throw new Error("既有 VCRouter provider 的 ownership 無法確認，VansPod 不會覆寫。");
        }
        next = [...current, intended];
      }
      if (isDeepStrictEqual(next, current)) return { changed: false };
      const nextJournal: Journal = {
        version: 1,
        route: "vsCodeChat",
        original,
        intended,
        owned: { name: "VCRouter", vendor: "customendpoint" },
      };
      await atomicJson(options.journalFile, nextJournal);
      await atomicJson(options.settingsFile, next);
      return { changed: true };
    },
    restore,
    async initializeNative() {
      if (await readJournal(options.journalFile)) return restore();
      const current = await readProviders(options.settingsFile);
      const origins = new Set((options.legacyOrigins ?? ["http://127.0.0.1:47821"]).map(origin => origin.replace(/\/$/, "")));
      const next = current.filter(provider => {
        const keys = Object.keys(provider).sort();
        return !(keys.length === 2 && keys[0] === "name" && keys[1] === "url" && provider.name === "VCRouter" &&
          typeof provider.url === "string" && origins.has(provider.url.replace(/\/$/, "")));
      });
      if (isDeepStrictEqual(next, current)) return { changed: false };
      await atomicJson(options.settingsFile, next);
      return { changed: true };
    },
  };
}

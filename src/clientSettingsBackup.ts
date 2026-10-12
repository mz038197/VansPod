import fs from "node:fs/promises";
import path from "node:path";

type Entry = { original: string | null; written: string; previousWritten?: string; keys: string[] };
type Journal = Record<string, Entry>;

export type SettingsResource = { file: string; restore(current: string, original: string, written: string, keys: string[]): string };

/** One durable journal per client, shared by route, model and cache writes. */
export function clientSettingsBackup(file: string, resources: Record<string, SettingsResource>) {
  async function load(): Promise<Journal> {
    const raw = await optionalText(file);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid client settings backup");
    for (const [id, value] of Object.entries(parsed)) {
      const entry = value as Entry;
      if (!resources[id] || !entry || (entry.original !== null && typeof entry.original !== "string") || typeof entry.written !== "string" || (entry.previousWritten !== undefined && typeof entry.previousWritten !== "string") || !Array.isArray(entry.keys) || entry.keys.some(key => typeof key !== "string")) throw new Error("Invalid client settings backup");
    }
    return parsed as Journal;
  }
  async function save(journal: Journal) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(journal) + "\n", "utf8");
      await fs.rename(temporary, file);
    } finally { await fs.rm(temporary, { force: true }); }
  }
  return {
    async seed(id: string, original: string | null, keys: string[]) {
      const journal = await load();
      if (journal[id]) return;
      const current = await optionalText(resources[id].file);
      if (current === null) return;
      journal[id] = { original, written: current, keys };
      await save(journal);
    },
    async write(id: string, next: string, keys: string[], original?: string | null) {
      const resource = resources[id];
      const journal = await load();
      const current = await optionalText(resource.file);
      const entry = journal[id] ?? { original: original === undefined ? current : original, written: current ?? "", keys: [] };
      if (journal[id] && current !== entry.written && current !== entry.previousWritten) {
        // Preserve intervening edits before a classroom replay takes ownership.
        if (current === null) entry.original = null;
        else {
          let baseline = resource.restore(current, entry.original ?? "", entry.written, entry.keys);
          if (entry.previousWritten !== undefined) baseline = resource.restore(baseline, entry.original ?? "", entry.previousWritten, entry.keys);
          entry.original = baseline;
        }
      }
      journal[id] = { ...entry, previousWritten: entry.written, written: next, keys: [...new Set([...entry.keys, ...keys])] };
      // Persist both the baseline and planned write before touching the client.
      await save(journal);
      if (next !== current) {
        await fs.mkdir(path.dirname(resource.file), { recursive: true });
        await fs.writeFile(resource.file, next, "utf8");
      }
    },
    async restore(ids?: readonly string[]) {
      const journal = await load();
      const selected = ids ? new Set(ids) : undefined;
      for (const [id, entry] of Object.entries(journal)) {
        if (selected && !selected.has(id)) continue;
        const resource = resources[id];
        const current = await optionalText(resource.file);
        if (current === null) continue; // An external deletion must stay deleted.
        const exact = current === entry.written || current === entry.previousWritten;
        let next = exact ? entry.original : resource.restore(current, entry.original ?? "", entry.written, entry.keys);
        if (!exact && next !== null && entry.previousWritten !== undefined) next = resource.restore(next, entry.original ?? "", entry.previousWritten, entry.keys);
        if (next === null) await fs.rm(resource.file, { force: true });
        else if (next !== current) await fs.writeFile(resource.file, next, "utf8");
      }
      // Keep every unselected resource and the whole journal on any failed
      // restoration, so independently detected clients can retry safely.
      const remaining = Object.fromEntries(Object.entries(journal).filter(([id]) => selected && !selected.has(id)));
      if (Object.keys(remaining).length) await save(remaining);
      else await fs.rm(file, { force: true });
    },
  };
}

export async function optionalText(file: string): Promise<string | null> {
  try { return await fs.readFile(file, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

import fs from "node:fs/promises";
import path from "node:path";

// Classroom Default Model: same rules as the classroom-one-click-install extension
// (its ADR 0018). While Classroom, VS Code's user `chat.defaultModel` points at the
// first VCRouter model so new Chat conversations use it; Native puts back the
// student's own value, but only if the setting still holds the one VansPod wrote.

const CHAT_DEFAULT_MODEL = "chat.defaultModel";

export type ClassroomDefaultModelRecord = {
  /** Student's value before VansPod wrote; absent means the setting did not exist. */
  previous?: string;
  written: string;
};

type Token = { kind: "string" | "punct" | "literal"; start: number; end: number; depth: number; char?: string };

// Comment- and string-aware tokens of a JSONC document. `depth` is the nesting level
// the token sits at (the root object's own braces are depth 0, its members depth 1).
function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let depth = 0;
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (/\s|﻿/.test(c)) { i += 1; continue; }
    if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      i = close < 0 ? text.length : close + 2;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      tokens.push({ kind: "string", start: i, end: Math.min(j + 1, text.length), depth });
      i = j + 1;
      continue;
    }
    if ("{[".includes(c)) { tokens.push({ kind: "punct", char: c, start: i, end: i + 1, depth }); depth += 1; i += 1; continue; }
    if ("}]".includes(c)) { depth -= 1; tokens.push({ kind: "punct", char: c, start: i, end: i + 1, depth }); i += 1; continue; }
    if (":,".includes(c)) { tokens.push({ kind: "punct", char: c, start: i, end: i + 1, depth }); i += 1; continue; }
    let j = i;
    while (j < text.length && !/[\s{}[\]:,"/]/.test(text[j]!)) j += 1;
    tokens.push({ kind: "literal", start: i, end: Math.max(j, i + 1), depth });
    i = Math.max(j, i + 1);
  }
  return tokens;
}

type Entry = { index: number; key: Token; value: Token; text?: string };

type Document = { tokens: Token[]; root?: Token; entry?: Entry; members: number };

function inspect(text: string): Document | undefined {
  const tokens = tokenize(text);
  if (tokens.length === 0) return { tokens, members: 0 };
  const root = tokens[0]!;
  if (root.char !== "{") return undefined;
  let entry: Entry | undefined;
  let members = 0;
  for (let i = 1; i + 2 < tokens.length; i += 1) {
    const key = tokens[i]!;
    if (key.depth !== 1 || key.kind !== "string" || tokens[i + 1]!.char !== ":") continue;
    members += 1;
    if (JSON.parse(text.slice(key.start, key.end)) !== CHAT_DEFAULT_MODEL) continue;
    const value = tokens[i + 2]!;
    // VS Code uses the last duplicate key, so the last one wins here too.
    entry = { index: i, key, value, text: value.kind === "string" ? JSON.parse(text.slice(value.start, value.end)) as string : undefined };
  }
  return { tokens, root, entry, members };
}

async function readText(file: string): Promise<string | null> {
  try { return await fs.readFile(file, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function readDefaultModel(file: string): Promise<string | undefined> {
  const text = await readText(file);
  return text === null ? undefined : inspect(text)?.entry?.text;
}

function lineStart(text: string, index: number): number {
  const start = text.lastIndexOf("\n", index - 1) + 1;
  return text.slice(start, index).trim() === "" ? start : index;
}

function lineEnd(text: string, index: number): number {
  const rest = text.slice(index).match(/^[ \t]*(\r?\n)?/)![0];
  return rest.endsWith("\n") ? index + rest.length : index;
}

/** The edited text, or undefined when the file cannot be edited safely. */
function edit(text: string | null, value: string | undefined): string | undefined {
  const line = `"${CHAT_DEFAULT_MODEL}": ${JSON.stringify(value)}`;
  if (text === null) return value === undefined ? undefined : `{\n  ${line}\n}\n`;
  const doc = inspect(text);
  if (!doc) return undefined;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  if (!doc.root) {
    // Only comments or nothing: keep them and add the object after.
    if (value === undefined) return undefined;
    const sep = text === "" || text.endsWith("\n") ? "" : eol;
    return `${text}${sep}{${eol}  ${line}${eol}}${eol}`;
  }
  const { entry, tokens } = doc;
  if (entry && value !== undefined) {
    // A non-string value we can't place safely (object, array) is left alone.
    if (entry.value.kind === "punct") return undefined;
    return text.slice(0, entry.value.start) + JSON.stringify(value) + text.slice(entry.value.end);
  }
  if (entry) {
    if (entry.value.kind === "punct") return undefined;
    const next = tokens[entry.index + 3];
    const before = tokens[entry.index - 1]!;
    if (next?.char === ",") {
      const from = lineStart(text, entry.key.start);
      return text.slice(0, from) + text.slice(lineEnd(text, next.end));
    }
    if (before.char === ",") return text.slice(0, before.start) + text.slice(entry.value.end);
    const from = lineStart(text, entry.key.start);
    return text.slice(0, from) + text.slice(lineEnd(text, entry.value.end));
  }
  if (value === undefined) return undefined;
  const at = doc.root.end;
  const rest = text.slice(at);
  const comma = doc.members > 0 ? "," : "";
  // Match the file's layout so removing the entry later gives back the exact bytes:
  // its own line in a multi-line object, inline right after `{` in a compact one.
  return /^[ \t]*\r?\n/.test(rest)
    ? `${text.slice(0, at)}${eol}  ${line}${comma}${rest}`
    : `${text.slice(0, at)}${line}${comma}${rest}`;
}

async function writeDefaultModel(file: string, value: string | undefined): Promise<void> {
  const next = edit(await readText(file), value);
  if (next === undefined) return;
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.vanspod.tmp`;
  try {
    await fs.writeFile(temporary, next, "utf8");
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

/**
 * What the journal should hold after this publish, or undefined to write nothing.
 * Same model as last time → leave whatever the student has now, never re-override it.
 */
export async function planClassroomDefaultModel(file: string, modelId: string, record: ClassroomDefaultModelRecord | undefined): Promise<ClassroomDefaultModelRecord | undefined> {
  if (record?.written === modelId) return undefined;
  const current = await readDefaultModel(file);
  const previous = record && current === record.written ? record.previous : current;
  return previous === undefined ? { written: modelId } : { previous, written: modelId };
}

export async function applyClassroomDefaultModel(file: string, record: ClassroomDefaultModelRecord): Promise<void> {
  if (await readDefaultModel(file) !== record.written) await writeDefaultModel(file, record.written);
}

export async function restoreClassroomDefaultModel(file: string, record: ClassroomDefaultModelRecord | undefined): Promise<void> {
  if (!record) return;
  if (await readDefaultModel(file) === record.written) await writeDefaultModel(file, record.previous);
}

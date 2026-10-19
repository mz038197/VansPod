import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { materializeAsset } from "../desktop";

const media = (name: string) => fs.readFile(path.join(__dirname, "..", "..", "media", name));

test("the tray icon is written under a name that changes with its content", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "vanspod-assets-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const icon = await media("brand-icon.ico");
  const file = await materializeAsset(directory, "brand-icon.ico");
  assert.equal(path.basename(file), `brand-icon-${createHash("sha256").update(icon).digest("hex").slice(0, 12)}.ico`);
  assert.deepEqual(await fs.readFile(file), icon);
});

test("an existing copy that cannot be overwritten is reused, not rewritten", async t => {
  // 檔案總管的縮圖程序會把 .ico 對應進記憶體，之後這個檔案就無法清空重寫。
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "vanspod-assets-"));
  const file = await materializeAsset(directory, "brand-icon.ico");
  await fs.chmod(file, 0o444);
  t.after(async () => { await fs.chmod(file, 0o666); await fs.rm(directory, { recursive: true, force: true }); });
  assert.equal(await materializeAsset(directory, "brand-icon.ico"), file);
});

test("PowerShell scripts get the BOM Windows PowerShell needs to read Chinese text", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "vanspod-assets-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const bytes = await fs.readFile(await materializeAsset(directory, "tray.ps1"));
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.deepEqual(bytes.subarray(3), await fs.readFile(path.join(__dirname, "..", "..", "scripts", "tray.ps1")));
});

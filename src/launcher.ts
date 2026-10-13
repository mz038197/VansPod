import { VERSION } from "./version";
import { spawn } from "node:child_process";
import { isSea } from "node:sea";
import path from "node:path";
import { readInstance, reserveInstance, saveInstance, releaseInstance, isAlive, control, managementDirectory } from "./instance";
import fs from "node:fs/promises";
import { openBrowser } from "./desktop";
import { registerInstallation } from "./installations";
import { createInterface } from "node:readline/promises";

export async function runCli(args = process.argv.slice(2)): Promise<void> {
  if (args[0] === "--version") { process.stdout.write(`${VERSION}\n`); return; }
  if (args[0] === "--help") {
    process.stdout.write("VansPod\nvanspod [start | status | stop | uninstall]\nvanspod --version\nvanspod --help\n");
    return;
  }
  const command = args[0] ?? "start";
  if (!["start", "status", "stop", "uninstall"].includes(command) || args.slice(1).some(arg => arg !== "--json")) throw new Error("指令無效，請執行 vanspod --help。");
  if (process.platform !== "win32") throw new Error("此版本完整支援 Windows，其他平台尚未支援。");
  if (process.env.VANSPOD_WORKER_TOKEN) {
    let instance = await readInstance();
    if (!instance || instance.token !== process.env.VANSPOD_WORKER_TOKEN) throw new Error("VansPod 啟動授權無效。");
    for (let attempt = 0; instance.pid !== process.pid && attempt < 200; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 50));
      const current = await readInstance();
      if (!current || current.id !== instance.id) throw new Error("VansPod 啟動身分已改變。");
      instance = current;
    }
    if (instance.pid !== process.pid) throw new Error("VansPod 啟動交接逾時。");
    await (require("./start") as typeof import("./start")).main(instance);
    return;
  }
  if (command === "status") {
    const instance = await readInstance();
    const status = instance && isAlive(instance.pid) ? await control(instance, "status") : { id: "", running: false, pid: undefined, origin: undefined, version: undefined };
    process.stdout.write(args.includes("--json") ? `${JSON.stringify(status)}\n` : status.running ? `VansPod ${status.version} 執行中（PID ${status.pid}）\n${status.origin}/\n` : "VansPod 未執行。\n");
    return;
  }
  if (command === "stop") {
    const instance = await readInstance();
    if (!instance || !isAlive(instance.pid)) { process.stdout.write("VansPod 未執行。\n"); return; }
    let result = await control(instance, "stop", {});
    if (result.confirmation && await confirm(result.message ?? "中斷目前回答並結束？")) result = await control(instance, "stop", { confirmed: true });
    if (!result.ok) throw new Error(result.message ?? "無法結束 VansPod。");
    for (let attempt = 0; attempt < 200 && isAlive(instance.pid); attempt++) await new Promise(resolve => setTimeout(resolve, 50));
    if (isAlive(instance.pid)) throw new Error("VansPod 尚未完成結束。");
    process.stdout.write("VansPod 已結束。\n");
    return;
  }
  if (command === "uninstall") {
    await registerInstallation();
    let instance = await readInstance();
    if (!instance || !isAlive(instance.pid)) { await runCli(["start"]); instance = await readInstance(); }
    if (!instance) throw new Error("無法啟動完整移除工具。");
    const preview = await control(instance, "uninstall-preview");
    if (!preview.ok) throw new Error(preview.message);
    process.stdout.write(`${preview.message}\n`);
    if (!await confirm("確定完整移除 VansPod？")) throw new Error("已取消移除。請在互動終端機或 VansPod 頁面確認移除。");
    const body = { confirmed: true, waitForPid: isSea() ? process.pid : undefined };
    let result = await control(instance, "uninstall", body);
    if (result.confirmation && await confirm(result.message ?? "中斷目前回答並移除？")) result = await control(instance, "uninstall", { ...body, interruptConfirmed: true });
    if (!result.ok) throw new Error(result.message);
    process.stdout.write(`${result.message}\n`);
    return;
  }
  await registerInstallation();
  const { instance, owner } = await reserveInstance();
  if (owner) {
    await fs.rm(path.join(managementDirectory(), "startup-error.json"), { force: true });
    if (process.env.CLASSROOM_APP_FOREGROUND === "1") { await (require("./start") as typeof import("./start")).main(instance); return; }
    const child = spawn(process.execPath, isSea() ? [] : [path.join(__dirname, "entry.js")], {
      detached: true, stdio: "ignore", windowsHide: true,
      env: { ...process.env, VANSPOD_WORKER_TOKEN: instance.token },
    });
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); }).catch(async error => { await releaseInstance(instance.id); throw error; });
    instance.pid = child.pid!;
    await saveInstance(instance);
    child.unref();
  }
  let ready;
  for (let attempt = 0; attempt < 200; attempt++) {
    const current = await readInstance();
    if (!current || !isAlive(current.pid)) {
      const failure = await fs.readFile(path.join(managementDirectory(), "startup-error.json"), "utf8").then(raw => (JSON.parse(raw) as {message: string}).message).catch(() => "請檢查本機環境與連接埠後重試。");
      throw new Error(`VansPod 啟動失敗：${failure}`);
    }
    if (current.origin) { ready = await control(current, "status"); break; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!ready) throw new Error("VansPod 啟動逾時，請稍後用 vanspod status 檢查。");
  const live = (await readInstance())!;
  await control(live, "open", { version: VERSION });
  openBrowser(`${ready.origin}/`);
  process.stdout.write(`VansPod ${ready.version}: ${ready.origin}/\n`);
  if (ready.version !== VERSION) process.stdout.write(`本次開啟版本 ${VERSION}，目前執行版本 ${ready.version}；換版請先結束 VansPod。\n`);
}

async function confirm(message: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try { return /^(y|yes|是)$/i.test((await input.question(`${message} [y/N] `)).trim()); }
  finally { input.close(); }
}

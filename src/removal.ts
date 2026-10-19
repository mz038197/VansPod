import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { asset } from "./desktop";
import { dataDirectory, managementDirectory } from "./instance";
import { installations } from "./installations";

export async function removalPreview(): Promise<string> {
  const installed = await installations();
  const legacy = path.join(process.env.LOCALAPPDATA || os.homedir(), "classroom-app", "connection.json");
  return `將刪除 VansPod 課堂憑證、偏好、模式記憶、日誌及暫存檔：\n${dataDirectory()}\n${managementDirectory()}\n${legacy}\n${installed.map(item => item.kind === "exe" ? item.file : item.root).join("\n")}\n保留學生專案、作品、Node、Git、VS Code 與個人設定。未登記的其他 exe 副本須自行刪除。`;
}

export async function prepareRemoval(waitForPid?: number, instanceId?: string): Promise<() => Promise<void>> {
  const root = managementDirectory();
  const script = path.join(root, "uninstall-tool.ps1");
  const plan = path.join(root, "uninstall-plan.json");
  await fs.writeFile(script, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), await asset("uninstall.ps1")]));
  await fs.writeFile(plan, JSON.stringify({ version: 1, root, dataRoot: dataDirectory(), instanceId, pid: process.pid, waitForPid, headless: process.env.CLASSROOM_APP_HEADLESS === "1", installations: await installations() }), { mode: 0o600 });
  return () => startHiddenTool(script, plan, path.join(root, "uninstall-ready"), "移除工具");
}

/** 啟動一個在 VansPod 結束後仍會繼續執行的 PowerShell 工具，等它寫出 ready 檔才返回。 */
export async function startHiddenTool(script: string, plan: string, ready: string, name: string): Promise<void> {
  await fs.rm(ready, { force: true });
  // Start-Process gives the helper its own hidden console. A PowerShell child
  // attached to the worker's console would die when that worker exits.
  const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const command = `Start-Process -FilePath powershell.exe -WindowStyle Hidden -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ${literal(`"${script}"`)}, '-Plan', ${literal(`"${plan}"`)})`;
  const child = spawn("powershell.exe", ["-NoProfile", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")], { windowsHide: true, stdio: "ignore" });
  await new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("exit", code => code === 0 ? resolve() : reject(new Error(`無法啟動${name}。`))); });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await fs.stat(ready).catch(() => undefined)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`${name}未回應，請重試。`);
}

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { startHiddenTool, writeTool } from "./desktop";
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
  await writeTool(script, "uninstall.ps1");
  await fs.writeFile(plan, JSON.stringify({ version: 1, root, dataRoot: dataDirectory(), instanceId, pid: process.pid, waitForPid, headless: process.env.CLASSROOM_APP_HEADLESS === "1", installations: await installations() }), { mode: 0o600 });
  return () => startHiddenTool(script, plan, path.join(root, "uninstall-ready"), "移除工具");
}

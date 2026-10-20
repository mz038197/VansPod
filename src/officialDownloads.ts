import { ENVIRONMENT_LABEL, type EnvironmentToolId } from "./classroomApp";
import type { OfficialInstaller } from "./officialInstaller";
import type { EnvironmentSystem } from "./windowsEnvironment";

/**
 * 每個工具的官方安裝檔從哪裡來、誰簽署、怎麼靜默安裝（ADR-0011）：
 * VS Code 一律直接下載；Git、Node.js、PowerShell 7 只在沒有 winget 時才查官方最新版本。
 */

export type WindowsArchitecture = "x64" | "arm64";

/** 平時走 winget、沒有 winget 時改從官方網站下載的工具。 */
export type WingetTool = Exclude<EnvironmentToolId, "uv" | "vscode">;

/** Authenticode 簽署者憑證主體裡的組織（O=）必須完全是這個名字。 */
function signedBy(organization: string): RegExp {
  const escaped = organization.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|,\\s*)O=${escaped}(?:,|$)`);
}

const MICROSOFT_SIGNER = signedBy("Microsoft Corporation");
const OPENJS_SIGNER = signedBy("OpenJS Foundation");
// Git for Windows 由維護者 Johannes Schindelin 個人簽署，不是「Git for Windows」。
const GIT_FOR_WINDOWS_SIGNER = signedBy("Johannes Schindelin");

/** VS Code User 版：裝在學生自己的帳號下，不需要系統管理員；不自動啟動，等驗證完由學生開啟。 */
export function vsCodeInstaller(architecture: WindowsArchitecture, setupLog: string): OfficialInstaller {
  return {
    label: ENVIRONMENT_LABEL.vscode,
    url: `https://update.code.visualstudio.com/latest/win32-${architecture}-user/stable`,
    fileName: `VSCodeUserSetup-${architecture}.exe`,
    signer: MICROSOFT_SIGNER,
    launch: (installer) => ({
      command: installer,
      // 參數不加引號：Node 會替含空白的參數整個加上引號，Inno Setup 解析時去掉。
      args: [
        "/VERYSILENT",
        "/SUPPRESSMSGBOXES",
        "/NORESTART",
        "/MERGETASKS=desktopicon,addcontextmenufiles,addcontextmenufolders,addtopath,!runcode",
        `/LOG=${setupLog}`,
      ],
    }),
  };
}

const NODE_INDEX_URL = "https://nodejs.org/dist/index.json";
const GITHUB_LATEST: Record<Exclude<WingetTool, "node">, { url: string; asset: Record<WindowsArchitecture, RegExp> }> = {
  git: {
    url: "https://api.github.com/repos/git-for-windows/git/releases/latest",
    asset: { x64: /^Git-\d[\d.]*-64-bit\.exe$/, arm64: /^Git-\d[\d.]*-arm64\.exe$/ },
  },
  pwsh: {
    url: "https://api.github.com/repos/PowerShell/PowerShell/releases/latest",
    asset: { x64: /^PowerShell-\d[\d.]*-win-x64\.msi$/, arm64: /^PowerShell-\d[\d.]*-win-arm64\.msi$/ },
  },
};

export type Download = { url: string; fileName: string };
/** 查詢官方來源的結果：找到的東西、學生看得懂且可以重試的失敗原因，或已中止。 */
type Lookup<T> = T | { failure: string } | { aborted: true };

/** 查詢官方來源的 JSON；失敗時回傳學生看得懂、可以重試的原因。 */
async function fetchLatest(system: EnvironmentSystem, label: string, url: string, signal?: AbortSignal): Promise<Lookup<{ body: unknown }>> {
  let response: { status: number; body: unknown };
  try {
    response = await system.fetchJson(url, { signal });
  } catch (error) {
    if (signal?.aborted) return { aborted: true };
    return { failure: `查詢 ${label} 最新版本失敗：${error instanceof Error ? error.message : String(error)}，請稍後再按重試` };
  }
  if (signal?.aborted) return { aborted: true };
  if ((response.status === 403 || response.status === 429) && url.startsWith("https://api.github.com/")) {
    // 未驗證的 GitHub API 每個對外 IP 每小時 60 次；教室共用 IP 時容易用完（ADR-0011）。
    return { failure: `查詢 ${label} 最新版本失敗：GitHub 查詢次數已達上限（同一個網路每小時 60 次），請稍後再按重試` };
  }
  if (response.status !== 200) return { failure: `查詢 ${label} 最新版本失敗（HTTP ${response.status}），請稍後再按重試` };
  return { body: response.body };
}

/** 沒有 winget 時，找出官方最新穩定版（Node.js 為 LTS）安裝檔的下載網址。 */
export async function lookupDownload(
  system: EnvironmentSystem,
  tool: WingetTool,
  architecture: WindowsArchitecture,
  signal?: AbortSignal,
): Promise<Lookup<{ download: Download }>> {
  const label = ENVIRONMENT_LABEL[tool];
  const missing = { failure: `找不到 ${label} 的 ${architecture} 安裝檔，請稍後再按重試` };
  if (tool === "node") {
    const latest = await fetchLatest(system, label, NODE_INDEX_URL, signal);
    if (!("body" in latest)) return latest;
    const releases = Array.isArray(latest.body) ? (latest.body as Array<{ version?: unknown; lts?: unknown }>) : [];
    // index.json 由新到舊排列；第一個 lts 為真的就是最新 LTS。
    const version = releases.find((release) => release?.lts && typeof release.version === "string" && /^v\d+\.\d+\.\d+$/.test(release.version))?.version as string | undefined;
    if (!version) return missing;
    const fileName = `node-${version}-${architecture}.msi`;
    return { download: { url: `https://nodejs.org/dist/${version}/${fileName}`, fileName } };
  }
  const source = GITHUB_LATEST[tool];
  const latest = await fetchLatest(system, label, source.url, signal);
  if (!("body" in latest)) return latest;
  const assets = (latest.body as { assets?: unknown } | null)?.assets;
  const asset = (Array.isArray(assets) ? (assets as Array<{ name?: unknown; browser_download_url?: unknown }>) : []).find(
    (candidate) => typeof candidate?.name === "string" && source.asset[architecture].test(candidate.name) && typeof candidate.browser_download_url === "string",
  );
  if (!asset) return missing;
  return { download: { url: asset.browser_download_url as string, fileName: asset.name as string } };
}

/** 官方安裝檔：Git 是 Inno Setup，Node.js 與 PowerShell 是 MSI；全部靜默、不自動重新開機，並寫安裝器自己的 log。 */
export function wingetToolInstaller(tool: WingetTool, download: Download, setupLog: string): OfficialInstaller {
  const base = { label: ENVIRONMENT_LABEL[tool], url: download.url, fileName: download.fileName };
  if (tool === "git") {
    return {
      ...base,
      signer: GIT_FOR_WINDOWS_SIGNER,
      launch: (installer) => ({
        command: installer,
        args: ["/VERYSILENT", "/NORESTART", "/NOCANCEL", "/SP-", "/SUPPRESSMSGBOXES", `/LOG=${setupLog}`],
      }),
    };
  }
  return {
    ...base,
    signer: tool === "node" ? OPENJS_SIGNER : MICROSOFT_SIGNER,
    launch: (installer) => ({
      command: "msiexec",
      args: ["/i", installer, "/qn", "/norestart", ...(tool === "pwsh" ? ["ADD_PATH=1"] : []), "/L*v", setupLog],
    }),
  };
}

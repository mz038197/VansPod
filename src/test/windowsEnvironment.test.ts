import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  createWindowsEnvironment,
  type EnvironmentSystem,
  type RunOptions,
  type RunResult,
} from "../windowsEnvironment";

type Reply = Partial<RunResult>;
type Call = { command: string; args: string[]; options: RunOptions };

/** 假的系統動作：依「指令 + 參數」回覆，記下每次呼叫；overrides 換掉下載、簽章等其他動作。 */
function fakeSystem(replies: Record<string, Reply | ((call: Call) => Reply | Promise<Reply>)>, overrides: Partial<EnvironmentSystem> = {}) {
  const calls: Call[] = [];
  const opened: string[] = [];
  const system: EnvironmentSystem = {
    async run(command, args, options = {}) {
      const call = { command, args, options };
      calls.push(call);
      const key = [command, ...args].join(" ");
      const reply = replies[key] ?? replies[command] ?? { notFound: true };
      const result = typeof reply === "function" ? await reply(call) : reply;
      return { exitCode: 0, output: "", notFound: false, timedOut: false, aborted: false, ...result };
    },
    async download() { throw new Error("not used"); },
    async signature() { throw new Error("not used"); },
    async fetchJson() { throw new Error("not used"); },
    async wingetAvailable() { return true; },
    async openFolder(folder) { opened.push(folder); },
    async start() {},
    ...overrides,
  };
  return { system, calls, opened };
}

const MICROSOFT = { status: "Valid", subject: "CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US" };
const X64 = { PROCESSOR_ARCHITECTURE: "AMD64" };
const VSCODE_READY: Reply = { output: "1.105.1\nabc\nx64\n" };

/** 路徑含中文、空白、驚嘆號、單引號的管理資料夾。 */
function weirdRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "學生 O'Neil! "));
}

async function exists(file: string): Promise<boolean> {
  return fs.stat(file).then(() => true, () => false);
}

/** 假的下載：每次呼叫依序取一個結果；"ok" 寫出檔案並回報進度。 */
function fakeDownloads(outcomes: Array<"ok" | Error | ((destination: string, signal?: AbortSignal) => Promise<void>)> = ["ok"]) {
  const downloads: Array<{ url: string; destination: string }> = [];
  const download: EnvironmentSystem["download"] = async (url, destination, options = {}) => {
    downloads.push({ url, destination });
    const outcome = outcomes[Math.min(downloads.length - 1, outcomes.length - 1)];
    if (outcome instanceof Error) throw outcome;
    if (typeof outcome === "function") return outcome(destination, options.signal);
    await fs.writeFile(destination, "MZ installer");
    options.onProgress?.(512, 1024);
    options.onProgress?.(1024, 1024);
  };
  return { downloads, download };
}

describe("Windows Environment Tool Readiness", () => {
  it("is ready when the version check exits 0 with the tool's version format", async () => {
    const { system } = fakeSystem({ "uv --version": { output: "uv 0.5.1 (abc 2024-10-01)\r\n" } });
    const environment = createWindowsEnvironment(system);
    assert.deepEqual(await environment.probe("uv"), { readiness: "ready", version: "uv 0.5.1 (abc 2024-10-01)" });
  });

  it("is missing when the command cannot be found", async () => {
    const { system } = fakeSystem({});
    const result = await createWindowsEnvironment(system).probe("git");
    assert.equal(result.readiness, "missing");
    assert.match(result.reason ?? "", /找不到 git/);
  });

  it("needs repair when the version check exits non-zero, even if it prints a version", async () => {
    const { system } = fakeSystem({ "uv --version": { exitCode: 1, output: "uv 1.2.3\n" } });
    const result = await createWindowsEnvironment(system).probe("uv");
    assert.equal(result.readiness, "needsRepair");
    assert.match(result.reason ?? "", /結束碼 1/);
  });

  it("needs repair when the version check exits 0 but prints an error instead of a version", async () => {
    const { system } = fakeSystem({ "pwsh --version": { output: "ERROR: startup failed 7.4.1\n" } });
    const result = await createWindowsEnvironment(system).probe("pwsh");
    assert.equal(result.readiness, "needsRepair");
    assert.equal(result.version, undefined);
  });

  it("limits every version check to 15 seconds and treats a hung check as needing repair", async () => {
    const { system, calls } = fakeSystem({ "git --version": { timedOut: true, exitCode: undefined, output: "git version 2.47.0\n" } });
    const result = await createWindowsEnvironment(system).probe("git");
    assert.equal(calls[0]?.options.timeoutMs, 15_000);
    assert.equal(result.readiness, "needsRepair");
    assert.match(result.reason ?? "", /超過 15 秒/);
  });

  it("accepts healthy LTS Node.js with a working npm", async () => {
    const { system, calls } = fakeSystem({
      "node --version": { output: "v24.1.0\n" },
      "node -p Boolean(process.release.lts)": { output: "true\n" },
      "npm --version": { output: "11.1.0\n" },
    });
    assert.deepEqual(await createWindowsEnvironment(system).probe("node"), { readiness: "ready", version: "v24.1.0" });
    assert.ok(calls.every((call) => call.options.timeoutMs === 15_000));
  });

  it("needs repair when Node.js is not an LTS release", async () => {
    const { system } = fakeSystem({
      "node --version": { output: "v25.0.0\n" },
      "node -p Boolean(process.release.lts)": { output: "false\n" },
      "npm --version": { output: "11.1.0\n" },
    });
    const result = await createWindowsEnvironment(system).probe("node");
    assert.equal(result.readiness, "needsRepair");
    assert.match(result.reason ?? "", /LTS/);
  });

  it("needs repair when npm is broken or missing", async () => {
    for (const npm of [{ exitCode: 1, output: "npm ERR! cannot find module\n" }, { output: "Error: 11.1.0\n" }, { notFound: true }]) {
      const { system } = fakeSystem({
        "node --version": { output: "v24.1.0\n" },
        "node -p Boolean(process.release.lts)": { output: "true\n" },
        "npm --version": npm,
      });
      const result = await createWindowsEnvironment(system).probe("node");
      assert.equal(result.readiness, "needsRepair", JSON.stringify(npm));
      assert.match(result.reason ?? "", /npm/);
    }
  });

  it("accepts each tool's real version output", async () => {
    const { system } = fakeSystem({
      "git --version": { output: "git version 2.47.0.windows.1\n" },
      "pwsh --version": { output: "PowerShell 7.4.6\n" },
    });
    const environment = createWindowsEnvironment(system);
    assert.equal((await environment.probe("git")).readiness, "ready");
    assert.equal((await environment.probe("pwsh")).readiness, "ready");
  });

  it("accepts VS Code's multi-line version output and shows its first line", async () => {
    const { system, calls } = fakeSystem({ "code --version": { output: "1.105.1\r\n7d842fb85a0275a4a8e4d7e040d2625abbf7f084\r\nx64\r\n" } });
    assert.deepEqual(await createWindowsEnvironment(system).probe("vscode"), { readiness: "ready", version: "1.105.1" });
    assert.equal(calls[0]?.options.timeoutMs, 15_000);
  });

  it("needs repair when code --version prints something other than a version", async () => {
    const { system } = fakeSystem({ "code --version": { output: "Error: 1.2.3\nx64\n" } });
    assert.equal((await createWindowsEnvironment(system).probe("vscode")).readiness, "needsRepair");
  });
});

describe("Windows Environment Install", () => {
  it("installs Git, Node.js LTS, and PowerShell 7 with silent winget", async () => {
    const { system, calls } = fakeSystem({ winget: { output: "Successfully installed\n" } });
    const environment = createWindowsEnvironment(system);
    for (const tool of ["git", "node", "pwsh"] as const) await environment.install(tool);
    assert.deepEqual(calls.map((call) => [call.command, ...call.args].join(" ")), [
      "winget install --id Git.Git -e --source winget --disable-interactivity -h --accept-package-agreements --accept-source-agreements",
      "winget install --id OpenJS.NodeJS.LTS -e --source winget --disable-interactivity -h --accept-package-agreements --accept-source-agreements",
      "winget install --id Microsoft.PowerShell -e --source winget --disable-interactivity -h --accept-package-agreements --accept-source-agreements",
    ]);
    assert.ok(calls.every((call) => call.options.timeoutMs === undefined), "installs never time out (ADR-0008)");
  });

  it("installs uv with the official install script", async () => {
    const { system, calls } = fakeSystem({ "powershell.exe": { output: "" } });
    await createWindowsEnvironment(system).install("uv");
    assert.deepEqual(calls.map((call) => [call.command, ...call.args]), [
      ["powershell.exe", "-ExecutionPolicy", "ByPass", "-c", "irm https://astral.sh/uv/install.ps1 | iex"],
    ]);
  });

  it("accepts winget exit codes 0, 3010, and already-installed, and rejects the rest", async () => {
    const accepted = [0, 3010, -1978335189, 2316632107];
    const rejected = [1, -1978335216, 2316632080];
    for (const exitCode of [...accepted, ...rejected]) {
      const { system } = fakeSystem({ winget: { exitCode, output: "winget output\n" } });
      const result = await createWindowsEnvironment(system).install("git");
      assert.equal(result.exitCode, exitCode);
      assert.equal(result.exitAccepted, accepted.includes(exitCode), String(exitCode));
      assert.equal(result.rebootRequired ?? false, exitCode === 3010, String(exitCode));
    }
  });

  it("reports a launch failure when winget cannot be found", async () => {
    const { system } = fakeSystem({});
    const result = await createWindowsEnvironment(system).install("pwsh");
    assert.equal(result.exitAccepted, false);
    assert.match(result.output, /無法啟動/);
  });

  it("reports installing while the installer runs and verifying once it exits", async () => {
    const reports: string[] = [];
    const { system } = fakeSystem({ winget: () => { reports.push("run"); return { output: "" }; } });
    await createWindowsEnvironment(system).install("git", undefined, (progress) => reports.push(progress.stage));
    assert.deepEqual(reports, ["installing", "run", "verifying"]);
  });

  it("does not report verifying after Abort Install", async () => {
    const reports: string[] = [];
    const { system } = fakeSystem({ winget: { aborted: true, exitCode: undefined } });
    await createWindowsEnvironment(system).install("git", new AbortController().signal, (progress) => reports.push(progress.stage));
    assert.deepEqual(reports, ["installing"]);
  });

  it("passes Abort Install through to the running installer", async () => {
    const controller = new AbortController();
    const { system, calls } = fakeSystem({ winget: { aborted: true, exitCode: undefined, output: "partial" } });
    const result = await createWindowsEnvironment(system).install("node", controller.signal);
    assert.equal(calls[0]?.options.signal, controller.signal);
    assert.equal(result.aborted, true);
    assert.equal(result.exitAccepted, false);
  });
});

describe("Windows Environment Install: VS Code", () => {
  it("downloads the User installer, checks Microsoft's signature, installs silently, and deletes it once VS Code is ready", async () => {
    const root = await weirdRoot();
    const { downloads, download } = fakeDownloads();
    const installer = path.join(root, "Downloads", "VSCodeUserSetup-x64.exe");
    let wingetAsked = false;
    const { system, calls } = fakeSystem(
      { [installer]: { exitCode: 0 }, "code --version": VSCODE_READY },
      { download, signature: async () => MICROSOFT, wingetAvailable: async () => { wingetAsked = true; return false; } },
    );
    const environment = createWindowsEnvironment(system, { managementDirectory: root, env: X64, retryDelayMs: 0 });
    const log = await environment.startLog();
    const reports: unknown[] = [];

    const result = await environment.install("vscode", undefined, (progress) => reports.push(progress));

    assert.deepEqual(downloads, [{ url: "https://update.code.visualstudio.com/latest/win32-x64-user/stable", destination: installer }]);
    const run = calls.find((call) => call.command === installer);
    assert.deepEqual(run?.args, [
      "/VERYSILENT",
      "/SUPPRESSMSGBOXES",
      "/NORESTART",
      "/MERGETASKS=desktopicon,addcontextmenufiles,addcontextmenufolders,addtopath,!runcode",
      `/LOG=${path.join(log.folder, "vscode-setup.log")}`,
    ]);
    assert.equal(run?.options.timeoutMs, undefined, "installs never time out (ADR-0008)");
    assert.deepEqual(reports, [
      { stage: "downloading", downloaded: 512, total: 1024 },
      { stage: "downloading", downloaded: 1024, total: 1024 },
      { stage: "installing" },
      { stage: "verifying" },
    ]);
    assert.equal(result.exitAccepted, true);
    assert.equal(result.exitCode, 0);
    assert.equal(await exists(installer), false);
    assert.equal(wingetAsked, false, "VS Code does not need winget");
    const text = await fs.readFile(path.join(log.folder, "install.log"), "utf8");
    assert.match(text, /win32-x64-user/);
    assert.match(text, /VSCodeUserSetup-x64\.exe/);
  });

  /** 一次 VS Code 安裝：回傳結果、下載紀錄與安裝檔路徑。 */
  async function installVsCode(setup: {
    env?: NodeJS.ProcessEnv;
    root?: string;
    downloads?: Parameters<typeof fakeDownloads>[0];
    signature?: EnvironmentSystem["signature"];
    installer?: Reply | ((call: Call) => Reply | Promise<Reply>);
    code?: Reply;
    signal?: AbortSignal;
  } = {}) {
    const root = setup.root ?? await weirdRoot();
    const fake = fakeDownloads(setup.downloads);
    const architecture = setup.env?.PROCESSOR_ARCHITECTURE === "ARM64" ? "arm64" : "x64";
    const installer = path.join(root, "Downloads", `VSCodeUserSetup-${architecture}.exe`);
    const signatures: string[] = [];
    const { system, calls } = fakeSystem(
      { [installer]: setup.installer ?? { exitCode: 0 }, "code --version": setup.code ?? VSCODE_READY },
      {
        download: fake.download,
        signature: async (file) => { signatures.push(file); return setup.signature ? setup.signature(file) : MICROSOFT; },
      },
    );
    const environment = createWindowsEnvironment(system, { managementDirectory: root, env: setup.env ?? X64, retryDelayMs: 0 });
    const result = await environment.install("vscode", setup.signal);
    const ran = calls.filter((call) => call.command === installer);
    return { root, result, downloads: fake.downloads, installer, ran, signatures, calls };
  }

  it("downloads the arm64 installer on ARM64 Windows", async () => {
    const { downloads } = await installVsCode({ env: { PROCESSOR_ARCHITECTURE: "ARM64" } });
    assert.equal(downloads[0]?.url, "https://update.code.visualstudio.com/latest/win32-arm64-user/stable");
  });

  it("downloads the x64 installer when a 32-bit VansPod runs on 64-bit Windows", async () => {
    const { downloads } = await installVsCode({ env: { PROCESSOR_ARCHITECTURE: "x86", PROCESSOR_ARCHITEW6432: "AMD64" } });
    assert.equal(downloads[0]?.url, "https://update.code.visualstudio.com/latest/win32-x64-user/stable");
  });

  it("fails without downloading on an architecture VS Code has no installer for", async () => {
    const { downloads, result } = await installVsCode({ env: { PROCESSOR_ARCHITECTURE: "x86" } });
    assert.equal(downloads.length, 0);
    assert.match(result.failure ?? "", /架構/);
  });

  it("does not run an installer whose signature is not valid, and deletes it", async () => {
    const { result, ran, installer } = await installVsCode({ signature: async () => ({ status: "HashMismatch", subject: MICROSOFT.subject }) });
    assert.equal(ran.length, 0);
    assert.equal(result.exitAccepted, false);
    assert.match(result.failure ?? "", /簽章/);
    assert.equal(await exists(installer), false);
  });

  it("does not run a validly signed installer from a publisher other than Microsoft", async () => {
    const { result, ran } = await installVsCode({ signature: async () => ({ status: "Valid", subject: "CN=Microsoft Corporation Fake, O=Contoso, C=US" }) });
    assert.equal(ran.length, 0);
    assert.match(result.failure ?? "", /簽章/);
  });

  it("retries a temporary download failure until it succeeds", async () => {
    const { downloads, ran, result } = await installVsCode({ downloads: [new Error("ECONNRESET"), new Error("ECONNRESET"), "ok"] });
    assert.equal(downloads.length, 3);
    assert.equal(ran.length, 1);
    assert.equal(result.exitAccepted, true);
  });

  it("gives up after 3 failed downloads and reports why", async () => {
    const { downloads, ran, result } = await installVsCode({ downloads: [new Error("下載失敗（HTTP 503）")] });
    assert.equal(downloads.length, 3);
    assert.equal(ran.length, 0);
    assert.equal(result.exitAccepted, false);
    assert.match(result.failure ?? "", /下載失敗.*HTTP 503/);
  });

  it("cancels a download on Abort Install without retrying and leaves no partial file", async () => {
    const controller = new AbortController();
    const { downloads, ran, result, installer } = await installVsCode({
      signal: controller.signal,
      downloads: [async (destination) => {
        await fs.writeFile(destination, "MZ half");
        controller.abort();
        throw new DOMException("aborted", "AbortError");
      }],
    });
    assert.equal(downloads.length, 1);
    assert.equal(ran.length, 0);
    assert.equal(result.aborted, true);
    assert.equal(await exists(installer), false);
  });

  it("deletes the installer right away when Abort Install stops it after launch", async () => {
    const { result, installer, ran } = await installVsCode({ installer: { aborted: true, exitCode: undefined, output: "partial" } });
    assert.equal(ran.length, 1);
    assert.equal(result.aborted, true);
    assert.equal(result.exitAccepted, false);
    assert.equal(await exists(installer), false);
  });

  it("passes Abort Install through to the running installer", async () => {
    const controller = new AbortController();
    const { ran } = await installVsCode({ signal: controller.signal });
    assert.equal(ran[0]?.options.signal, controller.signal);
  });

  it("fails when the installer exits non-zero and VS Code still does not verify, keeping the installer for a retry", async () => {
    const { result, installer } = await installVsCode({ installer: { exitCode: 1, output: "Setup failed" }, code: { exitCode: 1, output: "1.90.0\n" } });
    assert.equal(result.exitCode, 1);
    assert.equal(result.exitAccepted, false);
    assert.equal(await exists(installer), true);
  });

  it("reuses a kept installer on retry after checking its signature again", async () => {
    const first = await installVsCode({ code: { notFound: true } });
    assert.equal(await exists(first.installer), true);
    const retry = await installVsCode({ root: first.root });
    assert.equal(retry.downloads.length, 0);
    assert.deepEqual(retry.signatures, [first.installer]);
    assert.equal(retry.ran.length, 1);
    assert.equal(await exists(first.installer), false);
  });

  it("downloads again when the kept installer's signature no longer checks out", async () => {
    const first = await installVsCode({ code: { notFound: true } });
    let checks = 0;
    const retry = await installVsCode({
      root: first.root,
      signature: async () => (checks++ === 0 ? { status: "HashMismatch", subject: MICROSOFT.subject } : MICROSOFT),
    });
    assert.equal(retry.downloads.length, 1);
    assert.equal(retry.ran.length, 1);
  });

  it("verifies VS Code exactly once after installing and returns that verdict", async () => {
    const ready = await installVsCode();
    assert.equal(ready.calls.filter((call) => call.command === "code").length, 1);
    assert.deepEqual(ready.result.verified, { readiness: "ready", version: "1.105.1" });
    const broken = await installVsCode({ code: { notFound: true } });
    assert.equal(broken.calls.filter((call) => call.command === "code").length, 1);
    assert.equal(broken.result.verified?.readiness, "missing");
  });

  it("asks for a reboot when the installer exits 3010", async () => {
    const { result } = await installVsCode({ installer: { exitCode: 3010 } });
    assert.equal(result.exitAccepted, true);
    assert.equal(result.rebootRequired, true);
  });
});

describe("Environment Install logs", () => {
  async function tempRoot(): Promise<string> {
    return fs.mkdtemp(path.join(os.tmpdir(), "vanspod 安裝紀錄 "));
  }

  async function readLog(folder: string): Promise<string> {
    return fs.readFile(path.join(folder, "install.log"), "utf8");
  }

  it("writes each tool's command, output, exit code, and verification into InstallLogs\\<time>", async () => {
    const root = await tempRoot();
    const { system } = fakeSystem({
      winget: { exitCode: 3010, output: "Successfully installed Git\n" },
      "git --version": { output: "git version 2.47.0.windows.1\n" },
    });
    const environment = createWindowsEnvironment(system, {
      managementDirectory: root,
      now: () => new Date(2026, 9, 20, 23, 5, 9),
    });

    const log = await environment.startLog();
    await environment.install("git");
    await log.verified("git", await environment.probe("git"));
    await log.finish("完成");

    assert.equal(log.folder, path.join(root, "InstallLogs", "2026-10-20_230509"));
    const text = await readLog(log.folder);
    assert.match(text, /winget install --id Git\.Git -e/);
    assert.match(text, /Successfully installed Git/);
    assert.match(text, /結束碼：3010/);
    assert.match(text, /已就緒.*git version 2\.47\.0/);
    assert.match(text, /完成/);
  });

  it("keeps only the 10 most recent install logs", async () => {
    const root = await tempRoot();
    const { system } = fakeSystem({});
    let minute = 0;
    const environment = createWindowsEnvironment(system, {
      managementDirectory: root,
      now: () => new Date(2026, 9, 20, 10, minute++, 0),
    });
    const folders: string[] = [];
    for (let run = 0; run < 12; run += 1) folders.push((await environment.startLog()).folder);

    const kept = (await fs.readdir(path.join(root, "InstallLogs"))).sort();
    assert.deepEqual(kept, folders.slice(2).map((folder) => path.basename(folder)));
  });

  it("gives two installs started in the same second separate folders", async () => {
    const root = await tempRoot();
    const { system } = fakeSystem({});
    const environment = createWindowsEnvironment(system, { managementDirectory: root, now: () => new Date(2026, 9, 20, 10, 0, 0) });
    const first = await environment.startLog();
    const second = await environment.startLog();
    assert.notEqual(first.folder, second.folder);
  });

  it("records an aborted install", async () => {
    const root = await tempRoot();
    const { system } = fakeSystem({ winget: { aborted: true, exitCode: undefined, output: "Downloading 40%" } });
    const environment = createWindowsEnvironment(system, { managementDirectory: root });
    const log = await environment.startLog();
    await environment.install("node", new AbortController().signal);
    await log.finish("已中止");

    const text = await readLog(log.folder);
    assert.match(text, /OpenJS\.NodeJS\.LTS/);
    assert.match(text, /Downloading 40%/);
    assert.match(text, /結束碼：已中止/);
    assert.match(text, /結果：已中止/);
  });

  it("records a failed install with its exit code and failed verification", async () => {
    const root = await tempRoot();
    const { system } = fakeSystem({ winget: { exitCode: 1, output: "Installer failed\n" } });
    const environment = createWindowsEnvironment(system, { managementDirectory: root });
    const log = await environment.startLog();
    await environment.install("pwsh");
    await log.verified("pwsh", await environment.probe("pwsh"));

    const text = await readLog(log.folder);
    assert.match(text, /結束碼：1/);
    assert.match(text, /Installer failed/);
    assert.match(text, /驗證 PowerShell 7：未安裝：找不到 pwsh/);
  });

  it("opens an install log folder in File Explorer", async () => {
    const { system, opened } = fakeSystem({});
    await createWindowsEnvironment(system).openLogFolder("C:\\Users\\學生 A\\VansPod\\InstallLogs\\2026-10-20_100000");
    assert.deepEqual(opened, ["C:\\Users\\學生 A\\VansPod\\InstallLogs\\2026-10-20_100000"]);
  });
});

describe("Windows Environment Install without winget", () => {
  const GIT_SIGNER = { status: "Valid", subject: "CN=Johannes Schindelin, O=Johannes Schindelin, L=Bruehl, C=DE" };
  const OPENJS = { status: "Valid", subject: "CN=OpenJS Foundation, O=OpenJS Foundation, L=San Francisco, S=California, C=US" };
  const GIT_RELEASE = {
    tag_name: "v2.51.0.windows.1",
    assets: [
      { name: "Git-2.51.0-64-bit.tar.bz2", browser_download_url: "https://github.com/git-for-windows/git/releases/download/v2.51.0.windows.1/Git-2.51.0-64-bit.tar.bz2" },
      { name: "Git-2.51.0-64-bit.exe", browser_download_url: "https://github.com/git-for-windows/git/releases/download/v2.51.0.windows.1/Git-2.51.0-64-bit.exe" },
      { name: "Git-2.51.0-arm64.exe", browser_download_url: "https://github.com/git-for-windows/git/releases/download/v2.51.0.windows.1/Git-2.51.0-arm64.exe" },
      { name: "PortableGit-2.51.0-64-bit.7z.exe", browser_download_url: "https://github.com/git-for-windows/git/releases/download/v2.51.0.windows.1/PortableGit-2.51.0-64-bit.7z.exe" },
    ],
  };
  const PWSH_RELEASE = {
    tag_name: "v7.5.3",
    assets: [
      { name: "PowerShell-7.5.3-win-x64.zip", browser_download_url: "https://github.com/PowerShell/PowerShell/releases/download/v7.5.3/PowerShell-7.5.3-win-x64.zip" },
      { name: "PowerShell-7.5.3-win-x64.msi", browser_download_url: "https://github.com/PowerShell/PowerShell/releases/download/v7.5.3/PowerShell-7.5.3-win-x64.msi" },
      { name: "PowerShell-7.5.3-win-arm64.msi", browser_download_url: "https://github.com/PowerShell/PowerShell/releases/download/v7.5.3/PowerShell-7.5.3-win-arm64.msi" },
    ],
  };
  const NODE_INDEX = [
    { version: "v25.1.0", lts: false },
    { version: "v24.11.0", lts: "Krypton" },
    { version: "v22.21.1", lts: "Jod" },
  ];
  const LOOKUPS: Record<string, unknown> = {
    "https://api.github.com/repos/git-for-windows/git/releases/latest": GIT_RELEASE,
    "https://api.github.com/repos/PowerShell/PowerShell/releases/latest": PWSH_RELEASE,
    "https://nodejs.org/dist/index.json": NODE_INDEX,
  };
  const READY: Record<string, Reply> = {
    "git --version": { output: "git version 2.51.0.windows.1\n" },
    "pwsh --version": { output: "PowerShell 7.5.3\n" },
    "node --version": { output: "v24.11.0\n" },
    "node -p Boolean(process.release.lts)": { output: "true\n" },
    "npm --version": { output: "11.6.1\n" },
    "code --version": VSCODE_READY,
  };

  /** 沒有 winget 的電腦（winget: true 時有）：fetchJson 依網址回覆最新版本資訊。 */
  async function noWinget(setup: {
    env?: NodeJS.ProcessEnv;
    replies?: Record<string, Reply>;
    signature?: EnvironmentSystem["signature"];
    fetchJson?: EnvironmentSystem["fetchJson"];
    winget?: boolean;
  } = {}) {
    const root = await weirdRoot();
    const fake = fakeDownloads();
    const lookups: string[] = [];
    const cache = path.join(root, "Downloads");
    const { system, calls } = fakeSystem(
      {
        winget: { output: "Successfully installed\n" },
        msiexec: { exitCode: 0 },
        "powershell.exe": { output: "" },
        [path.join(cache, "Git-2.51.0-64-bit.exe")]: { exitCode: 0 },
        [path.join(cache, "Git-2.51.0-arm64.exe")]: { exitCode: 0 },
        [path.join(cache, "VSCodeUserSetup-x64.exe")]: { exitCode: 0 },
        ...READY,
        ...setup.replies,
      },
      {
        download: fake.download,
        signature: setup.signature ?? (async (file) => (/node-/.test(file) ? OPENJS : /Git-/.test(file) ? GIT_SIGNER : MICROSOFT)),
        wingetAvailable: async () => setup.winget ?? false,
        fetchJson: async (url, options) => {
          lookups.push(url);
          if (setup.fetchJson) return setup.fetchJson(url, options);
          return { status: 200, body: LOOKUPS[url] };
        },
      },
    );
    const environment = createWindowsEnvironment(system, { managementDirectory: root, env: setup.env ?? X64, retryDelayMs: 0 });
    const log = await environment.startLog();
    return { root, environment, log, calls, downloads: fake.downloads, lookups, cache };
  }

  it("downloads Git for Windows from its latest GitHub release and installs it silently", async () => {
    const { environment, calls, downloads, cache, log } = await noWinget();
    const result = await environment.install("git");
    const installer = path.join(cache, "Git-2.51.0-64-bit.exe");
    assert.deepEqual(downloads, [{ url: GIT_RELEASE.assets[1]!.browser_download_url, destination: installer }]);
    assert.ok(!calls.some((call) => call.command === "winget"));
    const run = calls.find((call) => call.command === installer);
    assert.deepEqual(run?.args, ["/VERYSILENT", "/NORESTART", "/NOCANCEL", "/SP-", "/SUPPRESSMSGBOXES", `/LOG=${path.join(log.folder, "git-setup.log")}`]);
    assert.equal(result.exitAccepted, true);
    assert.equal(await exists(installer), false);
  });

  it("downloads the latest Node.js LTS MSI from nodejs.org and installs it with msiexec", async () => {
    const { environment, calls, downloads, cache, log, lookups } = await noWinget();
    const result = await environment.install("node");
    const installer = path.join(cache, "node-v24.11.0-x64.msi");
    assert.deepEqual(lookups, ["https://nodejs.org/dist/index.json"]);
    assert.deepEqual(downloads, [{ url: "https://nodejs.org/dist/v24.11.0/node-v24.11.0-x64.msi", destination: installer }]);
    const run = calls.find((call) => call.command === "msiexec");
    assert.deepEqual(run?.args, ["/i", installer, "/qn", "/norestart", "/L*v", path.join(log.folder, "node-setup.log")]);
    assert.equal(result.exitAccepted, true);
  });

  it("downloads the latest PowerShell 7 MSI from its GitHub release and installs it with msiexec", async () => {
    const { environment, calls, downloads, cache, log } = await noWinget();
    const result = await environment.install("pwsh");
    const installer = path.join(cache, "PowerShell-7.5.3-win-x64.msi");
    assert.deepEqual(downloads, [{ url: PWSH_RELEASE.assets[1]!.browser_download_url, destination: installer }]);
    const run = calls.find((call) => call.command === "msiexec");
    assert.deepEqual(run?.args, ["/i", installer, "/qn", "/norestart", "ADD_PATH=1", "/L*v", path.join(log.folder, "pwsh-setup.log")]);
    assert.equal(result.exitAccepted, true);
  });

  it("picks each tool's arm64 installer on ARM64 Windows", async () => {
    const { environment, downloads } = await noWinget({ env: { PROCESSOR_ARCHITECTURE: "ARM64" } });
    for (const tool of ["git", "node", "pwsh"] as const) await environment.install(tool);
    assert.deepEqual(downloads.map((download) => download.url), [
      GIT_RELEASE.assets[2]!.browser_download_url,
      "https://nodejs.org/dist/v24.11.0/node-v24.11.0-arm64.msi",
      PWSH_RELEASE.assets[2]!.browser_download_url,
    ]);
  });

  it("keeps using winget, without looking up versions, when winget is available", async () => {
    const { environment, calls, downloads, lookups } = await noWinget({ winget: true });
    for (const tool of ["git", "node", "pwsh"] as const) await environment.install(tool);
    assert.equal(calls.filter((call) => call.command === "winget").length, 3);
    assert.deepEqual(lookups, []);
    assert.deepEqual(downloads, []);
  });

  it("installs uv with its install script whether or not winget is available", async () => {
    const { environment, calls, lookups } = await noWinget();
    await environment.install("uv");
    assert.deepEqual(calls.map((call) => call.command), ["powershell.exe"]);
    assert.deepEqual(lookups, []);
  });

  it("still installs VS Code when Git cannot be installed without winget", async () => {
    const { environment, calls, cache } = await noWinget({ fetchJson: async (url) => ({ status: url.includes("api.github.com") ? 503 : 200, body: undefined }) });
    const git = await environment.install("git");
    const vscode = await environment.install("vscode");
    assert.equal(git.exitAccepted, false);
    assert.match(git.failure ?? "", /git.*HTTP 503.*重試/);
    assert.equal(vscode.exitAccepted, true);
    assert.ok(calls.some((call) => call.command === path.join(cache, "VSCodeUserSetup-x64.exe")));
  });

  it("does not run an installer signed by someone other than the tool's publisher", async () => {
    const wrong = { status: "Valid", subject: "CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US" };
    for (const tool of ["git", "node"] as const) {
      const { environment, calls } = await noWinget({ signature: async () => wrong });
      const result = await environment.install(tool);
      assert.ok(!calls.some((call) => call.command === "msiexec" || /Git-/.test(call.command)), tool);
      assert.match(result.failure ?? "", /簽章/, tool);
    }
    const { environment, calls } = await noWinget({ signature: async () => ({ status: "Valid", subject: "CN=OpenJS Foundation, O=OpenJS Foundation" }) });
    const result = await environment.install("pwsh");
    assert.ok(!calls.some((call) => call.command === "msiexec"));
    assert.match(result.failure ?? "", /簽章/);
  });

  it("shows a GitHub rate limit as a failure the student can retry", async () => {
    for (const status of [403, 429]) {
      const { environment, downloads, log } = await noWinget({ fetchJson: async () => ({ status, body: { message: "API rate limit exceeded" } }) });
      const result = await environment.install("pwsh");
      assert.deepEqual(downloads, []);
      assert.equal(result.exitAccepted, false);
      assert.match(result.failure ?? "", /GitHub 查詢次數已達上限.*重試/);
      assert.match(await fs.readFile(path.join(log.folder, "install.log"), "utf8"), /GitHub 查詢次數已達上限/);
    }
  });

  it("shows a failed or unusable version lookup as a failure the student can retry", async () => {
    const cases: Array<EnvironmentSystem["fetchJson"]> = [
      async () => { throw new Error("getaddrinfo ENOTFOUND nodejs.org"); },
      async () => ({ status: 500, body: undefined }),
      async () => ({ status: 200, body: [{ version: "v25.1.0", lts: false }] }),
    ];
    for (const fetchJson of cases) {
      const { environment, downloads } = await noWinget({ fetchJson });
      const result = await environment.install("node");
      assert.deepEqual(downloads, []);
      assert.match(result.failure ?? "", /Node\.js.*重試/);
    }
  });

  it("stops at the version lookup on Abort Install", async () => {
    const controller = new AbortController();
    const { environment, downloads } = await noWinget({
      fetchJson: async () => { controller.abort(); throw new DOMException("aborted", "AbortError"); },
    });
    const result = await environment.install("git", controller.signal);
    assert.equal(result.aborted, true);
    assert.deepEqual(downloads, []);
  });
});

describe("Open VS Code", () => {
  it("starts VS Code on a folder whose path has Chinese, spaces, and punctuation, without waiting for it", async () => {
    const started: Array<{ command: string; args: string[] }> = [];
    const { system, calls } = fakeSystem({}, { async start(command, args) { started.push({ command, args }); } });
    const environment = createWindowsEnvironment(system);

    await environment.openVsCode("D:\\課程 O'Neil!\\lesson 1");
    await environment.openVsCode();

    assert.deepEqual(started, [
      { command: "code", args: ["D:\\課程 O'Neil!\\lesson 1"] },
      { command: "code", args: [] },
    ]);
    assert.deepEqual(calls, [], "opening VS Code does not run and wait on a process");
  });
});

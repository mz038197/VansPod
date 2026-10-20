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
    async wingetAvailable() { return true; },
    async openFolder(folder) { opened.push(folder); },
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

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createWindowsEnvironment,
  type EnvironmentSystem,
  type RunOptions,
  type RunResult,
} from "../windowsEnvironment";

type Reply = Partial<RunResult>;
type Call = { command: string; args: string[]; options: RunOptions };

/** 假的系統動作：依「指令 + 參數」回覆，記下每次呼叫。 */
function fakeSystem(replies: Record<string, Reply | ((call: Call) => Reply | Promise<Reply>)>) {
  const calls: Call[] = [];
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
  };
  return { system, calls };
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

  it("passes Abort Install through to the running installer", async () => {
    const controller = new AbortController();
    const { system, calls } = fakeSystem({ winget: { aborted: true, exitCode: undefined, output: "partial" } });
    const result = await createWindowsEnvironment(system).install("node", controller.signal);
    assert.equal(calls[0]?.options.signal, controller.signal);
    assert.equal(result.aborted, true);
    assert.equal(result.exitAccepted, false);
  });
});

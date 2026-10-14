import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test("removal waits for the worker to release transient runtime entries before inspecting descendants", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "vanspod-removal-wait-"));
  const root = path.join(home, "local", "VansPod");
  const runtime = path.join(root, "runtime");
  const dataRoot = path.join(home, ".vanspod");
  const project = path.join(home, "student-project");
  const transient = path.join(runtime, "retiring");
  const worker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
  const workerExit = new Promise(resolve => worker.once("exit", resolve));
  await new Promise<void>((resolve, reject) => { worker.once("spawn", resolve); worker.once("error", reject); });
  let helper: ReturnType<typeof spawn> | undefined;
  try {
    await fs.mkdir(runtime, { recursive: true });
    await fs.mkdir(dataRoot);
    await fs.mkdir(project);
    await fs.writeFile(path.join(project, "work.txt"), "student work");
    // A descendant that is unsafe to traverse now will be retired before the
    // worker exits. The helper must wait, then validate the final directory tree.
    await fs.symlink(project, transient, "junction");
    const tool = await fs.readFile(path.join(__dirname, "..", "..", "scripts", "uninstall.ps1"));
    await fs.writeFile(path.join(root, "uninstall-tool.ps1"), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), tool]));
    await fs.writeFile(path.join(root, "uninstall-plan.json"), JSON.stringify({
      version: 1, root, dataRoot, pid: worker.pid, headless: true, installations: [],
    }));
    helper = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "uninstall-tool.ps1")], {
      env: { ...process.env, USERPROFILE: home, LOCALAPPDATA: path.join(home, "local") }, stdio: "ignore", windowsHide: true,
    });
    const helperExit = new Promise(resolve => helper!.once("exit", resolve));
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await fs.stat(path.join(root, "uninstall-ready")).catch(() => undefined)) break;
      assert.equal(helper.exitCode, null, "helper exited before becoming ready");
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(await fs.stat(path.join(root, "uninstall-ready")));
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(helper.exitCode, null, "helper inspected mutable descendants before the worker exited");
    await fs.unlink(transient);
    await fs.rmdir(runtime);
    worker.kill();
    await workerExit;
    for (let attempt = 0; attempt < 100 && helper.exitCode === null; attempt++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(helper.exitCode, 0, "helper did not finish after the worker released its runtime");
    await helperExit;
    assert.equal(await fs.stat(root).catch(() => undefined), undefined);
    assert.equal(await fs.stat(dataRoot).catch(() => undefined), undefined);
    assert.equal(await fs.readFile(path.join(project, "work.txt"), "utf8"), "student work");
  } finally {
    if (helper && helper.exitCode === null) { helper.kill(); await new Promise(resolve => helper!.once("exit", resolve)); }
    if (worker.exitCode === null && worker.signalCode === null) { worker.kill(); await workerExit; }
    await fs.unlink(transient).catch(() => undefined);
    assert.equal(path.dirname(home), os.tmpdir());
    await fs.rm(home, { recursive: true, force: true });
  }
});

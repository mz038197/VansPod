import assert from "node:assert/strict";
import { it } from "node:test";
import vm from "node:vm";
import { environmentProgressScript } from "../environmentProgress";

type Status = { running: boolean; tools: Array<{ id: string; stage: string }> } | Error;

function harness(polling: boolean, statuses: Status[]) {
  let tick: (() => Promise<void>) | undefined;
  let reloads = 0;
  const requested: string[] = [];
  const stages: Record<string, { textContent: string }> = { uv: { textContent: "等待中" }, git: { textContent: "等待中" } };
  vm.runInNewContext(environmentProgressScript, {
    document: {
      querySelector: (selector: string) => (selector === "[data-environment-progress]" && polling ? {} : null),
      querySelectorAll: (selector: string) => {
        const id = selector.match(/data-environment-stage="([^"]+)"/)?.[1];
        return id && stages[id] ? [stages[id]] : [];
      },
    },
    window: { location: { reload() { reloads += 1; } } },
    fetch: async (url: string) => {
      requested.push(url);
      const status = statuses.shift();
      if (!status || status instanceof Error) throw status ?? new Error("no status");
      return { ok: true, json: async () => status };
    },
    setTimeout: (next: () => Promise<void>) => { tick = next; return 1; },
  });
  return {
    stages,
    requested,
    reloads: () => reloads,
    tick: async () => {
      const next = tick;
      tick = undefined;
      assert.ok(next, "a poll is scheduled");
      await next();
    },
    scheduled: () => tick !== undefined,
  };
}

it("polls the Environment Install status and updates each tool's stage in place", async () => {
  const ui = harness(true, [
    { running: true, tools: [{ id: "uv", stage: "下載中 1.0 MB" }, { id: "git", stage: "等待中" }] },
    { running: true, tools: [{ id: "uv", stage: "完成" }, { id: "git", stage: "安裝中" }] },
  ]);
  await ui.tick();
  assert.equal(ui.stages.uv.textContent, "下載中 1.0 MB");
  await ui.tick();
  assert.equal(ui.stages.uv.textContent, "完成");
  assert.equal(ui.stages.git.textContent, "安裝中");
  assert.deepEqual(ui.requested, ["/environment-status", "/environment-status"]);
  assert.equal(ui.reloads(), 0);
  assert.equal(ui.scheduled(), true);
});

it("reloads the page to show the result once the Environment Install has finished", async () => {
  const ui = harness(true, [{ running: false, tools: [] }]);
  await ui.tick();
  assert.equal(ui.reloads(), 1);
  assert.equal(ui.scheduled(), false);
});

it("keeps polling through a temporary connection failure", async () => {
  const ui = harness(true, [new Error("offline"), { running: true, tools: [{ id: "git", stage: "驗證中" }] }]);
  await ui.tick();
  assert.equal(ui.scheduled(), true);
  await ui.tick();
  assert.equal(ui.stages.git.textContent, "驗證中");
});

it("does not poll when no Environment Install runs", () => {
  const ui = harness(false, []);
  assert.equal(ui.scheduled(), false);
});

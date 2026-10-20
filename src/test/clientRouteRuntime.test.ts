import assert from "node:assert/strict";
import http from "node:http";
import { afterEach, it } from "node:test";
import { createClientRouteRuntime } from "../clientRouteRuntime";

const runtimes: Array<{ stop(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.stop()));
});

it("assigns Codex identity from the accepting listener regardless of request hints", async () => {
  const runtime = createClientRouteRuntime({
    basePort: 0,
    async handle(accepted, _request, response) {
      response.end(accepted.route ?? "ui-only");
    },
  });
  runtimes.push(runtime);

  const started = await runtime.start("codex");
  const response = await fetch(`${started.origin}/v1/messages`, {
    method: "POST",
    headers: { "user-agent": "copilot", "anthropic-version": "2023-06-01" },
  });

  assert.equal(started.health, "green");
  assert.equal(await response.text(), "codex");
});

it("keeps the shared UI listener incapable of Codex traffic until that route is activated", async () => {
  const runtime = createClientRouteRuntime({
    basePort: 0,
    async handle(accepted, _request, response) {
      response.end(accepted.route ?? "ui-only");
    },
  });
  runtimes.push(runtime);

  const ui = await runtime.startUi!();
  assert.equal(runtime.current!("codex"), undefined);
  assert.equal(await (await fetch(`${ui.origin}/v1/responses`, { method: "POST" })).text(), "ui-only");

  const codex = await runtime.start("codex");
  assert.equal(codex.origin, ui.origin);
  assert.equal(await (await fetch(`${ui.origin}/v1/responses`, { method: "POST" })).text(), "codex");

  await runtime.stop("codex");
  assert.equal(runtime.current!("codex"), undefined);
  assert.equal(await (await fetch(`${ui.origin}/v1/responses`, { method: "POST" })).text(), "ui-only");
});

it("assigns Claude Code identity from its own listener regardless of request hints", async () => {
  const runtime = createClientRouteRuntime({
    basePort: 0,
    async handle(accepted, _request, response) {
      response.end(accepted.route ?? "ui-only");
    },
  });
  runtimes.push(runtime);

  const started = await runtime.start("claudeCode");
  const response = await fetch(`${started.origin}/v1/messages`, {
    method: "POST",
    headers: { "user-agent": "codex", "anthropic-version": "2023-06-01" },
  });

  assert.equal(started.health, "green");
  assert.equal(await response.text(), "claudeCode");
});

it("assigns VS Code Chat identity from its accepting listener regardless of request hints", async () => {
  const runtime = createClientRouteRuntime({
    basePort: 0,
    async handle(accepted, _request, response) {
      response.end(accepted.route ?? "ui-only");
    },
  });
  runtimes.push(runtime);

  const started = await runtime.start("vsCodeChat");
  const response = await fetch(`${started.origin}/v1/responses`, {
    method: "POST",
    headers: { "user-agent": "codex", authorization: "Bearer misleading" },
  });

  assert.equal(started.health, "green");
  assert.equal(await response.text(), "vsCodeChat");
});

function listen(server: http.Server, port: number): Promise<boolean> {
  return new Promise(resolve => {
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => resolve(true));
  });
}

/** 占住一個埠，並確認它前一個埠是空的；系統給的埠前一個常被別的連線用掉，就換一組再試。 */
async function occupyPortAfterFreeOne(): Promise<{ occupied: http.Server; port: number }> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const occupied = http.createServer((_request, response) => response.end("occupied"));
    assert.ok(await listen(occupied, 0));
    const address = occupied.address();
    assert.ok(address && typeof address === "object");
    const probe = http.createServer();
    if (address.port > 1 && await listen(probe, address.port - 1)) {
      await new Promise<void>(resolve => probe.close(() => resolve()));
      return { occupied, port: address.port };
    }
    await new Promise<void>(resolve => occupied.close(() => resolve()));
  }
  throw new Error("找不到前一個埠是空的連接埠");
}

it("reports only Claude Code red when its base-port-plus-one listener is occupied", async () => {
  const { occupied, port } = await occupyPortAfterFreeOne();
  const runtime = createClientRouteRuntime({
    basePort: port - 1,
    async handle(accepted, _request, response) {
      response.end(accepted.route ?? "ui-only");
    },
  });
  runtimes.push(runtime);

  try {
    const codex = await runtime.start("codex");
    const claude = await runtime.start("claudeCode");

    assert.equal(codex.health, "green");
    assert.equal(claude.health, "red");
    assert.equal(await (await fetch(codex.origin)).text(), "codex");
  } finally {
    await new Promise<void>(resolve => occupied.close(() => resolve()));
  }
});

it("publishes exactly the current Claude Code allowlist through gateway model discovery", async () => {
  let models = ["lesson-one", "ollama_cloud@minimax-m3:cloud"];
  const runtime = createClientRouteRuntime({
    basePort: 0,
    models(route) { return route === "claudeCode" ? models : undefined; },
    async handle(_accepted, _request, response) {
      response.writeHead(404).end();
    },
  });
  runtimes.push(runtime);
  const started = await runtime.start("claudeCode");

  const first = await (await fetch(`${started.origin}/v1/models`, {
    headers: { "anthropic-version": "2023-06-01" },
  })).json() as { data: Array<{ id: string; display_name: string; type: string }> };
  assert.deepEqual(first.data.map(model => model.id), models);
  assert.deepEqual(first.data.map(model => model.display_name), models);
  assert.equal(first.data.every(model => model.type === "model"), true);

  models = ["lesson-two"];
  const refreshed = await (await fetch(`${started.origin}/v1/models`)).json() as { data: Array<{ id: string }> };
  assert.deepEqual(refreshed.data.map(model => model.id), ["lesson-two"]);
});

it("opens an emergency UI on a free loopback port when the Codex base port is occupied", async () => {
  const occupied = http.createServer((_request, response) => response.end("occupied"));
  await new Promise<void>((resolve, reject) => {
    occupied.once("error", reject);
    occupied.listen(0, "127.0.0.1", resolve);
  });
  const address = occupied.address();
  assert.ok(address && typeof address === "object");
  const runtime = createClientRouteRuntime({
    basePort: address.port,
    async handle(accepted, _request, response) {
      response.end(accepted.route ?? "ui-only");
    },
  });
  runtimes.push(runtime);
  let occupiedOpen = true;

  try {
    const started = await runtime.start("codex");
    assert.equal(started.health, "red");
    assert.notEqual(started.origin, `http://127.0.0.1:${address.port}`);
    assert.equal(await (await fetch(started.origin)).text(), "ui-only");
    await new Promise<void>(resolve => occupied.close(() => resolve()));
    occupiedOpen = false;

    const recovered = await runtime.start("codex");
    assert.equal(recovered.health, "green");
    assert.equal(recovered.origin, `http://127.0.0.1:${address.port}`);
    assert.equal(await (await fetch(recovered.origin)).text(), "codex");
    assert.equal(await (await fetch(started.origin)).text(), "ui-only");
  } finally {
    if (occupiedOpen) await new Promise<void>(resolve => occupied.close(() => resolve()));
  }
});

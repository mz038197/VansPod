import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, it } from "node:test";
import { createVsCodeRouteSettings } from "../vsCodeRouteSettings";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function files(initial: unknown[] = []) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vanspod-vscode-route-"));
  roots.push(root);
  const settingsFile = path.join(root, "Code", "User", "chatLanguageModels.json");
  const journalFile = path.join(root, ".vanspod", "vscode-route-journal.json");
  await fs.mkdir(path.dirname(settingsFile), { recursive: true });
  await fs.writeFile(settingsFile, `${JSON.stringify(initial, null, 2)}\n`, "utf8");
  return { root, settingsFile, journalFile };
}

it("publishes a complete credential-free VCRouter provider after journaling and preserves personal providers", async () => {
  const personal = { name: "Personal", vendor: "customendpoint", apiKey: "keep", models: [{ id: "mine" }] };
  const target = await files([personal]);
  const route = createVsCodeRouteSettings(target);
  const model = {
    id: "lesson-model",
    name: "Lesson Model",
    toolCalling: true,
    vision: true,
    maxInputTokens: 128000,
    maxOutputTokens: 8192,
    requestHeaders: { "x-capability": "keep" },
    url: "https://router.example/v1",
    apiType: "chat",
  };

  const result = await route.publish({ providers: [{ name: "VCRouter", vendor: "customendpoint", models: [model] }], adapter: "responses", origin: "http://127.0.0.1:47823" });

  assert.deepEqual(result, { changed: true });
  const written = JSON.parse(await fs.readFile(target.settingsFile, "utf8")) as Array<Record<string, unknown>>;
  assert.deepEqual(written[0], personal);
  assert.deepEqual(written[1], {
    name: "VCRouter",
    vendor: "customendpoint",
    apiType: "responses",
    models: [{ ...model, url: "http://127.0.0.1:47823/v1", apiType: "responses" }],
  });
  assert.equal(JSON.stringify(written).includes("apiKey"), true);
  assert.equal(Object.hasOwn(written[1]!, "apiKey"), false);
  const journal = JSON.parse(await fs.readFile(target.journalFile, "utf8")) as Record<string, unknown>;
  assert.equal(journal.route, "vsCodeChat");
  assert.equal(JSON.stringify(journal).includes("lesson-model"), true);
});

it("updates only the journal-owned provider and treats identical effective content as unchanged", async () => {
  const personal = { name: "Other", vendor: "customendpoint", models: [{ id: "personal" }] };
  const target = await files([personal]);
  const route = createVsCodeRouteSettings(target);
  const providers = [{
    name: "VCRouter",
    vendor: "customendpoint",
    models: [{ id: "lesson", name: "Lesson", toolCalling: true, vision: false, maxInputTokens: 32000 }],
  }];

  assert.deepEqual(await route.publish({ providers, adapter: "chat", origin: "http://127.0.0.1:49002" }), { changed: true });
  assert.deepEqual(await route.publish({ providers, adapter: "chat", origin: "http://127.0.0.1:49002" }), { changed: false });
  const changed = structuredClone(providers);
  (changed[0]!.models[0] as Record<string, unknown>).vision = true;
  assert.deepEqual(await route.publish({ providers: changed, adapter: "responses", origin: "http://127.0.0.1:47823" }), { changed: true });

  const written = JSON.parse(await fs.readFile(target.settingsFile, "utf8")) as Array<Record<string, unknown>>;
  assert.deepEqual(written[0], personal);
  assert.equal(written.length, 2);
  assert.equal(written[1]!.apiType, "responses");
  assert.equal((written[1]!.models as Array<Record<string, unknown>>)[0]!.vision, true);
  assert.equal((written[1]!.models as Array<Record<string, unknown>>)[0]!.url, "http://127.0.0.1:47823/v1");
});

it("reports old-extension and unproven same-name providers as conflicts without changing them", async () => {
  const template = [{ name: "VCRouter", vendor: "customendpoint", models: [{ id: "lesson" }] }];
  for (const existing of [
    { name: "VCRouter", vendor: "customendpoint", apiKey: "${input:chat.lm.secret.-7a55c1a5}", models: [] },
    { name: "VCRouter", vendor: "customendpoint", models: [{ id: "personal" }] },
    { name: "VCRouter", models: [{ id: "personal-without-vendor" }] },
    { name: "VCRouter", vendor: "other", models: [{ id: "personal-other-vendor" }] },
  ]) {
    const target = await files([existing]);
    const before = await fs.readFile(target.settingsFile, "utf8");
    const route = createVsCodeRouteSettings(target);
    await assert.rejects(
      route.publish({ providers: template, adapter: "responses", origin: "http://127.0.0.1:47823" }),
      /清除舊擴充的 Classroom Connection.*重新載入|ownership 無法確認/,
    );
    assert.equal(await fs.readFile(target.settingsFile, "utf8"), before);
    await assert.rejects(fs.stat(target.journalFile), /ENOENT/);
  }
});

it("Native removes only the provider proven by its journal and preserves later personal edits", async () => {
  const target = await files([{ name: "Personal", vendor: "openrouter", apiKey: "keep" }]);
  const route = createVsCodeRouteSettings(target);
  const template = [{ name: "VCRouter", vendor: "customendpoint", models: [{ id: "lesson" }] }];
  await route.publish({ providers: template, adapter: "responses", origin: "http://127.0.0.1:47823" });

  assert.deepEqual(await route.restore(), { changed: true });
  assert.deepEqual(JSON.parse(await fs.readFile(target.settingsFile, "utf8")), [{ name: "Personal", vendor: "openrouter", apiKey: "keep" }]);
  await assert.rejects(fs.stat(target.journalFile), /ENOENT/);

  await route.publish({ providers: template, adapter: "responses", origin: "http://127.0.0.1:47823" });
  const edited = JSON.parse(await fs.readFile(target.settingsFile, "utf8")) as Array<Record<string, unknown>>;
  (edited[1]!.models as Array<Record<string, unknown>>)[0]!.name = "My edit";
  await fs.writeFile(target.settingsFile, `${JSON.stringify(edited, null, 2)}\n`);
  await assert.rejects(route.restore(), /已被其他程式修改/);
  assert.equal(((JSON.parse(await fs.readFile(target.settingsFile, "utf8")) as Array<Record<string, unknown>>)[1]!.models as Array<Record<string, unknown>>)[0]!.name, "My edit");
  await fs.stat(target.journalFile);
});

it("first Native initialization removes only the exact legacy VansPod localhost provider", async () => {
  const personalSameName = { name: "VCRouter", vendor: "customendpoint", url: "http://127.0.0.1:47821", models: [{ id: "personal" }] };
  const oldExtension = { name: "VCRouter", vendor: "customendpoint", apiKey: "${input:chat.lm.secret.old}", models: [] };
  const legacy = { name: "VCRouter", url: "http://127.0.0.1:47821" };
  const target = await files([legacy, personalSameName, oldExtension, { name: "Other" }]);
  const route = createVsCodeRouteSettings({ ...target, legacyOrigins: ["http://127.0.0.1:47821"] });

  assert.deepEqual(await route.initializeNative(), { changed: true });

  assert.deepEqual(JSON.parse(await fs.readFile(target.settingsFile, "utf8")), [personalSameName, oldExtension, { name: "Other" }]);
  await assert.rejects(fs.stat(target.journalFile), /ENOENT/);
});

it("recursively removes credential fields and secret references from Router metadata", async () => {
  const target = await files();
  const route = createVsCodeRouteSettings(target);
  const secretRef = "${input:chat.lm.secret.router}";
  await route.publish({
    adapter: "responses",
    origin: "http://127.0.0.1:47823",
    providers: [{
      name: "VCRouter",
      vendor: "customendpoint",
      apiKey: "vcr_sk_provider",
      requestHeaders: { Authorization: "Bearer vcr_sk_header", "x-api-key": "vcr_sk_x", "x-capability": "keep" },
      nested: { secretRef, safe: "keep-nested" },
      models: [{ id: "lesson", api_key: "vcr_sk_model", headers: { authorization: "Bearer nested", accept: "application/json" } }],
    }],
  });

  const raw = await fs.readFile(target.settingsFile, "utf8");
  assert.doesNotMatch(raw, /vcr_sk_|chat\.lm\.secret|authorization|apiKey|api_key|x-api-key/i);
  assert.match(raw, /x-capability/);
  assert.match(raw, /keep-nested/);
  assert.match(raw, /application\/json/);
});

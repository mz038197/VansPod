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
  (edited[1]!.models as Array<Record<string, unknown>>)[0]!.url = "https://my-endpoint.example/v1";
  await fs.writeFile(target.settingsFile, `${JSON.stringify(edited, null, 2)}\n`);
  assert.deepEqual(await route.restore(), { changed: false, kept: true });
  assert.deepEqual(JSON.parse(await fs.readFile(target.settingsFile, "utf8")), edited);
  await assert.rejects(fs.stat(target.journalFile), /ENOENT/);
});

it("Native still removes the provider after VS Code adds its own fields to it", async () => {
  const target = await files([{ name: "Personal", vendor: "openrouter" }]);
  const route = createVsCodeRouteSettings(target);
  await route.publish({ providers: [{ name: "VCRouter", vendor: "customendpoint", models: [{ id: "vcr-auto" }] }], adapter: "responses", origin: "http://127.0.0.1:47823" });
  const edited = JSON.parse(await fs.readFile(target.settingsFile, "utf8")) as Array<Record<string, unknown>>;
  edited[1]!.settings = { "vcr-auto": { reasoningEffort: "none" } };
  (edited[1]!.models as Array<Record<string, unknown>>)[0]!.name = "My edit";
  await fs.writeFile(target.settingsFile, `${JSON.stringify(edited, null, 2)}\n`);

  assert.deepEqual(await route.restore(), { changed: true });
  assert.deepEqual(JSON.parse(await fs.readFile(target.settingsFile, "utf8")), [{ name: "Personal", vendor: "openrouter" }]);
  await assert.rejects(fs.stat(target.journalFile), /ENOENT/);
});

it("treats a provider already removed from VS Code as restored, and publishes it again as a first takeover", async () => {
  const target = await files([]);
  const route = createVsCodeRouteSettings(target);
  const template = [{ name: "VCRouter", vendor: "customendpoint", models: [{ id: "vcr-auto" }] }];
  await route.publish({ providers: template, adapter: "responses", origin: "http://127.0.0.1:47823" });
  await fs.writeFile(target.settingsFile, "[]\n");

  assert.deepEqual(await route.publish({ providers: template, adapter: "responses", origin: "http://127.0.0.1:47823" }), { changed: true });
  assert.equal((JSON.parse(await fs.readFile(target.settingsFile, "utf8")) as unknown[]).length, 1);
  assert.equal((JSON.parse(await fs.readFile(target.journalFile, "utf8")) as Record<string, unknown>).original, null);

  await fs.writeFile(target.settingsFile, "[]\n");
  assert.deepEqual(await route.restore(), { changed: false });
  assert.equal(await fs.readFile(target.settingsFile, "utf8"), "[]\n");
  await assert.rejects(fs.stat(target.journalFile), /ENOENT/);
});

it("still recognizes an unchanged provider that has no models to compare addresses with", async () => {
  const target = await files([]);
  const route = createVsCodeRouteSettings(target);
  const template = [{ name: "VCRouter", vendor: "customendpoint", models: [] }];
  await route.publish({ providers: template, adapter: "responses", origin: "http://127.0.0.1:47823" });

  assert.deepEqual(await route.publish({ providers: template, adapter: "chat", origin: "http://127.0.0.1:47823" }), { changed: true });
  assert.deepEqual(await route.restore(), { changed: true });
  assert.equal(await fs.readFile(target.settingsFile, "utf8"), "[]\n");
});

it("republishing keeps fields VS Code added and overwrites the ones VansPod wrote", async () => {
  const target = await files([]);
  const route = createVsCodeRouteSettings(target);
  const template = [{ name: "VCRouter", vendor: "customendpoint", models: [{ id: "vcr-auto", vision: false }] }];
  await route.publish({ providers: template, adapter: "responses", origin: "http://127.0.0.1:47823" });
  const edited = JSON.parse(await fs.readFile(target.settingsFile, "utf8")) as Array<Record<string, unknown>>;
  edited[0]!.settings = { "vcr-auto": { reasoningEffort: "high" } };
  await fs.writeFile(target.settingsFile, `${JSON.stringify(edited, null, 2)}\n`);

  assert.deepEqual(await route.publish({ providers: template, adapter: "responses", origin: "http://127.0.0.1:47823" }), { changed: false });
  const changed = [{ ...template[0]!, models: [{ id: "vcr-auto", vision: true }] }];
  assert.deepEqual(await route.publish({ providers: changed, adapter: "chat", origin: "http://127.0.0.1:47823" }), { changed: true });

  const written = (JSON.parse(await fs.readFile(target.settingsFile, "utf8")) as Array<Record<string, unknown>>)[0]!;
  assert.deepEqual(written.settings, { "vcr-auto": { reasoningEffort: "high" } });
  assert.equal(written.apiType, "chat");
  assert.equal((written.models as Array<Record<string, unknown>>)[0]!.vision, true);
  assert.equal(Object.hasOwn((JSON.parse(await fs.readFile(target.journalFile, "utf8")) as { intended: object }).intended, "settings"), false);
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

async function withUserSettings(text: string | null) {
  const target = await files([]);
  const userSettingsFile = path.join(target.root, "Code", "User", "settings.json");
  if (text !== null) await fs.writeFile(userSettingsFile, text, "utf8");
  return { ...target, userSettingsFile };
}

const lessonProviders = [{ name: "VCRouter", vendor: "customendpoint", models: [{ id: "vcr-auto" }, { id: "lesson-two" }] }];
const publishLesson = (route: ReturnType<typeof createVsCodeRouteSettings>, providers: Array<Record<string, unknown>> = lessonProviders) =>
  route.publish({ providers, adapter: "responses", origin: "http://127.0.0.1:47823" });

it("Classroom sets chat.defaultModel to the first VCRouter model and keeps the student's comments", async () => {
  const original = '{\n  // my note\n  "editor.fontSize": 14,\n}\n';
  const target = await withUserSettings(original);
  await publishLesson(createVsCodeRouteSettings(target));

  const text = await fs.readFile(target.userSettingsFile, "utf8");
  assert.match(text, /"chat\.defaultModel": "vcr-auto"/);
  assert.match(text, /\/\/ my note/);
  assert.match(text, /"editor\.fontSize": 14/);
});

it("Native removes chat.defaultModel when the student had none, leaving the file as it was", async () => {
  const original = '{\n  // my note\n  "editor.fontSize": 14\n}\n';
  const target = await withUserSettings(original);
  const route = createVsCodeRouteSettings(target);
  await publishLesson(route);
  await route.restore();

  assert.equal(await fs.readFile(target.userSettingsFile, "utf8"), original);
});

it("Native puts back the student's own chat.defaultModel, even after publishing twice", async () => {
  const target = await withUserSettings('{\n  "chat.defaultModel": "gpt-5-mini"\n}\n');
  const route = createVsCodeRouteSettings(target);
  await publishLesson(route);
  await publishLesson(route, [{ name: "VCRouter", vendor: "customendpoint", models: [{ id: "lesson-two" }] }]);
  assert.match(await fs.readFile(target.userSettingsFile, "utf8"), /"chat\.defaultModel": "lesson-two"/);

  await route.restore();
  assert.match(await fs.readFile(target.userSettingsFile, "utf8"), /"chat\.defaultModel": "gpt-5-mini"/);
});

it("Native leaves a chat.defaultModel the student changed while in Classroom", async () => {
  const target = await withUserSettings("{}\n");
  const route = createVsCodeRouteSettings(target);
  await publishLesson(route);
  const edited = (await fs.readFile(target.userSettingsFile, "utf8")).replace('"vcr-auto"', '"claude-sonnet-5.5"');
  await fs.writeFile(target.userSettingsFile, edited, "utf8");

  await route.restore();
  assert.equal(await fs.readFile(target.userSettingsFile, "utf8"), edited);
});

it("Classroom creates the user settings file when VS Code has none yet", async () => {
  const target = await withUserSettings(null);
  const route = createVsCodeRouteSettings(target);
  await publishLesson(route);
  assert.match(await fs.readFile(target.userSettingsFile, "utf8"), /"chat\.defaultModel": "vcr-auto"/);
  await route.restore();
  assert.equal(JSON.parse(await fs.readFile(target.userSettingsFile, "utf8"))["chat.defaultModel"], undefined);
});

it("restarting in Classroom with the same model leaves a default the student picked themselves", async () => {
  const target = await withUserSettings("{}\n");
  await publishLesson(createVsCodeRouteSettings(target));
  const edited = (await fs.readFile(target.userSettingsFile, "utf8")).replace('"vcr-auto"', '"claude-sonnet-5.5"');
  await fs.writeFile(target.userSettingsFile, edited, "utf8");

  await publishLesson(createVsCodeRouteSettings(target));
  assert.equal(await fs.readFile(target.userSettingsFile, "utf8"), edited);
});

it("keeps the student's original value in the journal when settings.json cannot be read", async () => {
  const target = await withUserSettings('{ "chat.defaultModel": "gpt-5-mini" }\n');
  const route = createVsCodeRouteSettings(target);
  await publishLesson(route);
  await fs.rm(target.userSettingsFile);
  await fs.mkdir(target.userSettingsFile);
  await publishLesson(route, [{ name: "VCRouter", vendor: "customendpoint", models: [{ id: "lesson-two" }] }]);

  const journal = JSON.parse(await fs.readFile(target.journalFile, "utf8")) as Record<string, unknown>;
  assert.deepEqual(journal.defaultModel, { previous: "gpt-5-mini", written: "vcr-auto" });
});

it("edits only the real top-level chat.defaultModel, not comments or language blocks", async () => {
  const original = [
    "// my settings {see notes}",
    "{",
    '  /* "chat.defaultModel": "old" */',
    '  "u": "http://x", "editor.tabSize": 2,',
    '  "[python]": { "chat.defaultModel": "nested" }',
    "}",
    "",
  ].join("\n");
  const target = await withUserSettings(original);
  const route = createVsCodeRouteSettings(target);
  await publishLesson(route);

  const text = await fs.readFile(target.userSettingsFile, "utf8");
  assert.match(text, /\/\* "chat\.defaultModel": "old" \*\//);
  assert.match(text, /"\[python\]": \{ "chat\.defaultModel": "nested" \}/);
  assert.match(text, /^\/\/ my settings \{see notes\}$/m);
  assert.equal(text.match(/"chat\.defaultModel": "vcr-auto"/g)?.length, 1);
  await route.restore();
  assert.equal(await fs.readFile(target.userSettingsFile, "utf8"), original);
});

it("removes a last-property chat.defaultModel without leaving a trailing comma", async () => {
  const target = await withUserSettings('{\n  "editor.tabSize": 2\n}\n');
  const route = createVsCodeRouteSettings(target);
  await publishLesson(route);
  // The student moved the line to the end; it still holds the value VansPod wrote.
  await fs.writeFile(target.userSettingsFile, '{\n  "editor.tabSize": 2,\n  "chat.defaultModel": "vcr-auto"\n}\n', "utf8");
  await route.restore();
  assert.equal(await fs.readFile(target.userSettingsFile, "utf8"), '{\n  "editor.tabSize": 2\n}\n');
});

it("follows VS Code and treats the last duplicate chat.defaultModel as the setting", async () => {
  const target = await withUserSettings('{\n  "chat.defaultModel": "first",\n  "chat.defaultModel": "last"\n}\n');
  const route = createVsCodeRouteSettings(target);
  await publishLesson(route);
  assert.equal(await fs.readFile(target.userSettingsFile, "utf8"), '{\n  "chat.defaultModel": "first",\n  "chat.defaultModel": "vcr-auto"\n}\n');
  await route.restore();
  assert.equal(await fs.readFile(target.userSettingsFile, "utf8"), '{\n  "chat.defaultModel": "first",\n  "chat.defaultModel": "last"\n}\n');
});

it("keeps a comments-only settings.json and adds the object after it", async () => {
  const target = await withUserSettings("// all disabled\n");
  const route = createVsCodeRouteSettings(target);
  await publishLesson(route);
  const text = await fs.readFile(target.userSettingsFile, "utf8");
  assert.match(text, /^\/\/ all disabled\n\{\n {2}"chat\.defaultModel": "vcr-auto"\n\}\n$/);
});

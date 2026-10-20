import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ClassroomAppView } from "../classroomApp";
import { environmentStageText, environmentStatus, modelStatus, renderInspectorPage, renderPage } from "../page";
import { environmentProgressScript } from "../environmentProgress";
import { patrolKeyframes } from "../connectionMascot";
import { modelStatusScript } from "../modelStatus";
import { renderPrototypePage } from "../pagePrototype";
import vm from "node:vm";
import { settingsActionsScript } from "../settingsActions";
import { connectionMascotScript } from "../connectionMascot";
import { createPromptCapture } from "../promptCapture";
import { inspectorBody } from "../inspectorView";

const KEY = "vcr_sk_nick";

function view(extra?: Partial<ClassroomAppView>): ClassroomAppView {
  return {
    connected: true,
    detail: "Classroom API Key 已設定。",
    canCopyKey: true,
    installAvailable: false,
    commandRunning: false,
    mode: "native",
    tools: [
      { id: "uv", label: "uv", readiness: "missing", selected: false },
      { id: "git", label: "git", readiness: "missing", selected: false },
      { id: "node", label: "Node.js", readiness: "missing", selected: false },
      { id: "pwsh", label: "PowerShell 7", readiness: "missing", selected: false },
    ],
    environmentInstalling: false,
    ...extra,
  };
}

it("renders independent adapter choices with Responses defaults and Claude Messages", () => {
  const html = renderPage(view());
  const forms = [...html.matchAll(/<form[^>]*action="\/adapter"[\s\S]*?<\/form>/g)].map(match => match[0]);
  assert.equal(forms.length, 3);
  assert.match(forms[0], /value="codex"/); assert.match(forms[1], /value="claude"/); assert.match(forms[2], /value="vscode"/);
  assert.match(forms[0], /value="responses" selected/); assert.match(forms[1], /value="responses" selected/); assert.match(forms[2], /value="responses" selected/);
  assert.doesNotMatch(forms[0], /value="messages"/); assert.match(forms[1], /value="messages"/); assert.doesNotMatch(forms[2], /value="messages"/);
  assert.match(settingsActionsScript, /form\[action="\/adapter"\]/);
});

describe("VansPod page", () => {
  it("lists VS Code with its icon after the existing tools", () => {
    const tools = [...view().tools, { id: "vscode" as const, label: "VS Code", readiness: "missing" as const, selected: true }];
    const html = renderPage(view({ tools }));
    const row = html.match(/<label class="tool"><input type="checkbox" name="tool" value="vscode"[^]*?<\/label>/)?.[0] ?? "";
    assert.match(row, /<svg[^]*?<\/svg><span[^>]*>VS Code<\/span>/);
    assert.ok(html.indexOf('name="tool" value="pwsh"') < html.indexOf('name="tool" value="vscode"'));
  });

  it("lets the mascot announce a copied Classroom API Key without exposing the key", () => {
    const notice = "已複製 Classroom API Key。請勿分享給不信任的人。";
    const html = renderPage(view({ connectionNotice: notice, notice }));
    const card = html.match(/<section[^>]*data-setting="連線"[\s\S]*?<\/section>/)?.[0] ?? "";
    assert.match(card, /mascot-speaking/);
    assert.match(card, /複製好了！API Key 不是群組伴手禮，別發給不信任的人喔。/);
    assert.match(card, /role="status"/);
    assert.match(card, /aria-label="收起法鬥台詞"/);
    assert.doesNotMatch(card, /已複製 Classroom API Key。/);
    assert.equal(html.includes(KEY), false);
  });

  it("keeps the disconnected mascot outside the redeem form and its connect button attached to that form", () => {
    const html = renderPage(view({ connected: false, canCopyKey: false, detail: "" }));
    const card = html.match(/<section[^>]*data-setting="連線"[\s\S]*?<\/section>/)?.[0] ?? "";
    const form = card.match(/<form[^>]*action="\/redeem"[\s\S]*?<\/form>/)?.[0] ?? "";
    assert.match(form, /id="settings-redeem"/);
    assert.match(form, /name="invite_code"/);
    assert.match(form, /name="nickname"/);
    assert.doesNotMatch(form, /和法鬥超人打招呼|mascot-pause/);
    assert.match(card, /<button form="settings-redeem" type="submit"[^>]*>連線<\/button>/);
    assert.match(card, /aria-label="和法鬥超人打招呼"/);
    assert.ok(card.indexOf('class="connection-mascot mascot-waiting"') > card.indexOf("</form>"));
  });

  it("preserves the real connection error and input draft safely inside the mascot dialogue", () => {
    const error = '連線失敗，請確認邀請碼。<script>alert("oops")</script>';
    const html = renderPage(view({
      connected: false, canCopyKey: false, detail: "", connectionError: error,
      connectionDraft: { inviteCode: 'bad"<code>', nickname: 'Nick & "Name"' },
    }));
    const card = html.match(/<section[^>]*data-setting="連線"[\s\S]*?<\/section>/)?.[0] ?? "";
    assert.match(card, /class="mascot-speech"/);
    assert.match(card, /role="alert"/);
    assert.match(card, /披風倒是先上班了/);
    assert.equal(card.split('連線失敗，請確認邀請碼。').length - 1, 1);
    assert.match(card, /&lt;script&gt;alert\(&quot;oops&quot;\)&lt;\/script&gt;/);
    assert.match(card, /value="bad&quot;&lt;code&gt;"/);
    assert.match(card, /value="Nick &amp; &quot;Name&quot;"/);
    assert.doesNotMatch(card, /<script>/);
  });

  it("shows independent switches, subtle detection lights, gated adapters and the escaped classroom list", () => {
    const html = renderPage(view({
      clientModes: { codex: "native", claude: "classroom" },
      detectedClients: { codex: true, claude: false },
      allowedModels: ["lesson-one", "lesson<&two"],
    }));
    const adapters = [...html.matchAll(/<form[^>]*action="\/adapter"[\s\S]*?<\/form>/g)].map(item => item[0]);
    assert.doesNotMatch(adapters[0], /<select[^>]*disabled/);
    assert.match(adapters[1], /<select[^>]*disabled/);
    assert.match(html, /class="client-light detected"[^>]*title="Codex 已偵測"/);
    assert.match(html, /class="client-light"[^>]*title="Claude Code CLI 未偵測"/);
    assert.equal((html.match(/<form[^>]*action="\/switch"/g) ?? []).length, 3);
    assert.match(html, /<li>lesson&lt;&amp;two<\/li>/);
  });
  it("shows red Codex health and disables its Classroom controls", () => {
    const html = renderPage(view({
      connected: true,
      allowedModels: ["lesson-one"],
      detectedClients: { codex: true, claude: false },
      clientRoutes: {
        codex: { id: "codex", mode: "native", adapter: "responses", health: "red", restart: "ready" },
        claudeCode: { id: "claudeCode", mode: "native", adapter: "responses", health: "gray", restart: "ready" },
        vsCodeChat: { id: "vsCodeChat", mode: "native", adapter: "responses", health: "gray", restart: "ready" },
      },
    }));
    const codexSwitch = html.match(/<form class="modes client-modes"[^>]*>[\s\S]*?<\/form>/)?.[0] ?? "";
    const codexAdapter = html.match(/<form class="adapter-row"[^>]*>[\s\S]*?<\/form>/)?.[0] ?? "";
    assert.match(html, /class="client-light health-red"[^>]*title="Codex 入口失敗"/);
    assert.match(codexSwitch, /value="classroom"[^>]*disabled/);
    assert.match(codexAdapter, /<select[^>]*disabled/);
  });
  it("keeps all connection feedback inside the connection card above its actions, without duplicates", () => {
    const messages = [
      { connected: true, canCopyKey: true, notice: "已複製 Classroom API Key。請勿分享給不信任的人。" },
      { connected: true, canCopyKey: true, notice: "無法複製 Classroom API Key。請重新連線後再試。" },
      { connected: true, canCopyKey: true, notice: "無法清除課堂連線。已保留原本連線。" },
      { connected: false, canCopyKey: false, notice: "無法安全保存原有課堂連線。" },
    ];
    for (const state of messages) {
      const html = renderPage(view({ ...state, connectionNotice: state.notice }));
      const card = html.match(/<section[^>]*data-setting="連線"[\s\S]*?<\/section>/)?.[0] ?? "";
      const expected = state.notice === "已複製 Classroom API Key。請勿分享給不信任的人。"
        ? "複製好了！API Key 不是群組伴手禮，別發給不信任的人喔。" : state.notice;
      assert.ok(card.includes(expected));
      assert.ok(card.indexOf('class="connection-feedback"') < card.indexOf('class="settings-actions"'));
      assert.equal(html.split(expected).length - 1, 1);
      assert.equal(html.includes(`<p class="notice">${state.notice}</p>`), false);
    }
    for (const state of [
      { connectionError: "連線失敗，請再試一次。", detail: "" },
      { detail: "課堂連線無法解密。請重新連線。" },
    ]) {
      const html = renderPage(view({ connected: false, canCopyKey: false, ...state }));
      const card = html.match(/<section[^>]*data-setting="連線"[\s\S]*?<\/section>/)?.[0] ?? "";
      assert.ok(card.includes(state.connectionError || state.detail));
      assert.equal(html.split(state.connectionError || state.detail).length - 1, 1);
    }
  });
  it("submits the selected mode in place and preserves scroll and collapsed sections", async () => {
    let submit!: (event: unknown) => Promise<void>;
    let replaced = false;
    let requestBody = "";
    const button = { disabled: false };
    const oldDetails = [{ open: true }, { open: false }];
    const newDetails = [{ open: false }, { open: true }];
    const main = {
      querySelectorAll(selector: string) { return selector === "button, select" ? [button] : replaced ? newDetails : oldDetails; },
      replaceChildren() { replaced = true; },
    };
    const card = { querySelector: () => null, setAttribute() {}, removeAttribute() {} };
    const form = { action: "/switch", matches: (selector: string) => selector.includes('form[action="/switch"]'), querySelector: () => null, closest: () => card };
    const window = { scrollY: 240, scrollTo({ top }: { top: number }) { this.scrollY = top; } };
    vm.runInNewContext(settingsActionsScript, {
      document: { addEventListener(event: string, handler: typeof submit) { if (event === "submit") submit = handler; }, querySelector: (selector: string) => selector === "main" ? main : null },
      window, installBusy: false, installOpening: false,
      initializeCourseSections() {},
      FormData: class { *[Symbol.iterator]() {} }, URLSearchParams,
      DOMParser: class { parseFromString() { return { querySelector: () => ({ childNodes: [] }) }; } },
      fetch: async (_url: string, options: { body: URLSearchParams }) => {
        requestBody = options.body.toString();
        assert.equal(button.disabled, true);
        return { ok: true, text: async () => "updated page" };
      },
    });
    await submit({ target: form, submitter: { name: "mode", value: "classroom" }, preventDefault() {} });
    assert.equal(requestBody, "mode=classroom");
    assert.equal(replaced, true);
    assert.equal(window.scrollY, 240);
    assert.deepEqual(newDetails.map((detail) => detail.open), [true, false]);
    assert.equal(button.disabled, false);
  });
  it("preserves unsubmitted connection inputs when another setting updates the page", async () => {
    let submit!: (event: unknown) => Promise<void>;
    let replaced = false;
    const oldInputs = [{ name: "invite_code", value: "not-submitted" }, { name: "nickname", value: "Student" }];
    const newInputs = [{ name: "invite_code", value: "" }, { name: "nickname", value: "" }];
    const main = {
      querySelectorAll: () => [],
      querySelector: () => ({ querySelectorAll: () => replaced ? newInputs : oldInputs }),
      replaceChildren() { replaced = true; },
    };
    const card = { querySelector: () => null, setAttribute() {}, removeAttribute() {} };
    const form = {
      action: "/project-folder", querySelector: () => null, closest: () => card,
      matches: (selector: string) => selector.includes("project-folder"),
    };
    vm.runInNewContext(settingsActionsScript, {
      document: { addEventListener(event: string, handler: typeof submit) { if (event === "submit") submit = handler; }, querySelector: (selector: string) => selector === "main" ? main : null },
      window: { scrollY: 0, scrollTo() {} }, installBusy: false, installOpening: false,
      initializeCourseSections() {},
      FormData: class { *[Symbol.iterator]() {} }, URLSearchParams,
      DOMParser: class { parseFromString() { return { querySelector: () => ({ childNodes: [] }) }; } },
      fetch: async () => ({ ok: true, text: async () => "updated page" }),
    });
    await submit({ target: form, preventDefault() {} });
    assert.equal(replaced, true);
    assert.deepEqual(newInputs.map(input => input.value), ["not-submitted", "Student"]);
  });

  it("copies without replacing the page, dimming the copy button, or sending twice", async () => {
    let submit!: (event: unknown) => Promise<void>;
    let replaced = false;
    let fetches = 0;
    let secondSubmit: Promise<void> | undefined;
    let shownSpeech: unknown;
    const copyButton = { disabled: false };
    const otherButton = { disabled: false };
    const speech = {};
    const stage = {
      querySelector: () => null,
      classList: { add() {} },
      prepend(node: unknown) { shownSpeech = node; },
    };
    const card = {
      querySelector: (selector: string) => selector === ".connection-mascot" ? stage : null,
      setAttribute() {}, removeAttribute() {},
    };
    const nextStage = { querySelector: () => speech, classList: { contains: () => true } };
    const nextCard = { querySelector: (selector: string) => selector === ".connection-mascot" ? nextStage : selector === ".connection-copy" ? {} : null };
    const main = { querySelectorAll: () => [copyButton, otherButton], replaceChildren() { replaced = true; } };
    const form = {
      action: "/copy", matches: (selector: string) => selector.includes('form[action="/copy"]'),
      querySelector: () => null, querySelectorAll: () => [copyButton], closest: () => card,
    };
    vm.runInNewContext(connectionMascotScript + settingsActionsScript, {
      document: {
        addEventListener(event: string, handler: typeof submit) { if (event === "submit") submit = handler; },
        querySelector: (selector: string) => selector === "main" ? main : selector === '[data-setting="連線"]' ? card : null,
      },
      installBusy: false, installOpening: false,
      FormData: class { *[Symbol.iterator]() {} }, URLSearchParams,
      DOMParser: class { parseFromString() { return { querySelector: () => ({ querySelector: () => nextCard }) }; } },
      fetch: async () => {
        fetches += 1;
        assert.equal(copyButton.disabled, false);
        assert.equal(otherButton.disabled, false);
        secondSubmit = submit({ target: form, preventDefault() {} });
        return { ok: true, text: async () => "copied page" };
      },
    });
    await submit({ target: form, preventDefault() {} });
    await secondSubmit;
    assert.equal(fetches, 1);
    assert.equal(replaced, false);
    assert.equal(shownSpeech, speech);
    assert.equal(copyButton.disabled, false);
  });

  it("shows the full VS Code restart notice when mustRestart includes vscode", () => {
    const html = renderPage(view({ modelRestart: ["vscode"] }));
    assert.equal(
      html.includes("請完全退出 VS Code 再打開，不要只重載視窗。"),
      true,
    );
    assert.equal(html.includes(KEY), false);
  });

  it("repaints a waiting light and removes its restart reminder without a reload", async () => {
    const routes = (health: "yellow" | "green") => ({
      codex: { id: "codex" as const, mode: "native" as const, adapter: "responses" as const, health: "gray" as const, restart: "ready" as const },
      claudeCode: { id: "claudeCode" as const, mode: "native" as const, adapter: "responses" as const, health: "gray" as const, restart: "ready" as const },
      vsCodeChat: { id: "vsCodeChat" as const, mode: "classroom" as const, adapter: "responses" as const, health, restart: "ready" as const },
    });
    const waiting = view({ clientRoutes: routes("yellow"), modelRestart: ["vscode"] });
    const html = renderPage(waiting);
    assert.match(html, /class="client-light health-yellow"[^>]*data-client-light="vscode"/);
    assert.match(html, /class="model-update"[^>]*data-restart-clients="vscode"/);
    assert.match(modelStatus(waiting).restart, /data-restart-clients="vscode"/);

    const status = modelStatus(view({ clientRoutes: routes("green") }));
    assert.deepEqual(status.lights.vscode, { health: "green", className: "client-light detected", status: "VS Code 可用" });
    assert.equal(status.restart, "");

    const light = {
      className: "client-light health-yellow", title: "VS Code 等待重開", label: "",
      getAttribute: () => "vscode", setAttribute(_name: string, value: string) { this.label = value; },
    };
    let bannerRemoved = false;
    const banner = { getAttribute: () => "vscode", remove() { bannerRemoved = true; } };
    const card = { querySelector: (selector: string) => selector === ".model-update" ? banner : null };
    let tick!: () => Promise<void>;
    vm.runInNewContext(modelStatusScript, {
      settingsBusy: false,
      setTimeout(callback: typeof tick) { tick = callback; },
      document: {
        hidden: false,
        querySelectorAll: () => [light],
        querySelector: (selector: string) => selector === '[data-setting="模型"]' ? card : null,
        createElement: () => ({ innerHTML: "", content: { firstElementChild: null } }),
      },
      fetch: async (url: string) => { assert.equal(url, "/model-status"); return { ok: true, json: async () => status }; },
    });
    await tick();
    assert.equal(light.className, "client-light detected");
    assert.equal(light.title, "VS Code 可用");
    assert.equal(light.label, "VS Code 可用");
    assert.equal(bannerRemoved, true);
  });

  it("animates only the Client Route that has traffic and stops it when the traffic ends", async () => {
    const html = renderPage(view());
    for (const client of ["codex", "claude", "vscode"]) assert.match(html, new RegExp(`class="client-flow" data-client-flow="${client}"`));
    const flows = ["codex", "claude"].map(client => ({
      flowing: false,
      getAttribute: () => client,
      classList: { toggle(_name: string, on: boolean) { flows.find(flow => flow.getAttribute() === client)!.flowing = on; } },
    }));
    let traffic = { codex: false, claude: true, vscode: false };
    let tick!: () => Promise<void>;
    vm.runInNewContext(modelStatusScript, {
      settingsBusy: false,
      setTimeout(callback: typeof tick) { tick = callback; },
      document: { hidden: false, querySelectorAll: (selector: string) => selector === "[data-client-flow]" ? flows : [], querySelector: () => null },
      fetch: async () => ({ ok: true, json: async () => ({ lights: {}, restart: "", traffic }) }),
    });
    await tick();
    assert.deepEqual(flows.map(flow => flow.flowing), [false, true]);
    traffic = { codex: false, claude: false, vscode: false };
    await tick();
    assert.deepEqual(flows.map(flow => flow.flowing), [false, false]);
  });

  it("omits the VS Code restart notice when vscode is not in mustRestart", () => {
    const html = renderPage(view({ modelRestart: ["codex"] }));
    assert.equal(html.includes("請完全退出 VS Code"), false);
    assert.equal(html.includes(KEY), false);
  });

  it("stacks modules in one column before the wide breakpoint", () => {
    const html = renderPage(view());
    assert.match(
      html,
      /@media \(max-width:\s*40rem\)\s*\{[^}]*grid-template-columns:\s*1fr\s*;/,
    );
  });

  it("uses one appearance button and keeps the key off the page", () => {
    const html = renderPage(view({ mustRestart: ["codex", "claude"] }));
    assert.equal(html.includes('class="model-update"'), false);
    assert.match(html, /VansPod/);
    assert.match(html, /data-appearance-toggle/);
    assert.match(html, /\[data-appearance="light"\]/);
    assert.match(html, /\[data-appearance="dark"\]/);
    assert.equal(html.includes("proto-bar"), false);
    assert.equal(html.includes(KEY), false);
  });

  it("serves the D layout as the official page without the prototype bar", () => {
    const html = renderPage(view());
    assert.match(html, /class="brand-title">VansPod</);
    assert.match(html, /教室設定/);
    assert.match(html, /<h2>課程安裝<\/h2>/);
    assert.match(html, /<h2>課程片段<\/h2>/);
    assert.equal(html.includes("proto-bar"), false);
    assert.equal(html.includes("prototype_variant"), false);
    assert.equal(html.includes(KEY), false);
  });

  it("prototype variants disagree about layout and keep the key off the page", () => {
    const rail = renderPrototypePage(view(), "A");
    const list = renderPrototypePage(view(), "B");
    const split = renderPrototypePage(view(), "C");
    assert.match(rail, /class="shell"/);
    assert.match(rail, /A · 側欄控制台/);
    assert.equal(list.includes('class="shell"'), false);
    assert.match(list, /class="set-row"/);
    assert.match(split, /class="split"/);
    assert.equal(split.includes('class="set-row"'), false);
    assert.match(split, /data-proto-go="D"/);
    const current = renderPrototypePage(view(), "D");
    assert.match(current, /D · 原本/);
    assert.match(current, /class="proto-bar"/);
    assert.match(current, /class="brand-title">VansPod/);
    assert.match(current, /name="prototype_variant" value="D"/);
    assert.equal(renderPage(view()).includes("proto-bar"), false);
    const official = renderPage(view());
    assert.match(official, /class="modules"/);
    assert.match(official, /class="display"/);
    assert.match(official, /\.tile \{ border: 1px solid light-dark\(#e6e6e6, #3d3d3d\); \}/);
    assert.match(official, /\.display \{ display: none; \}/);
    assert.match(official, /class="page-head"><h2>教室設定<\/h2><p>連線、模型與開發環境。<\/p>/);
    assert.match(official, /class="badge off">無課堂模型</);
    assert.doesNotMatch(official, /目前模型|使用自己的帳號/);
    assert.match(official, />課堂</);
    assert.match(official, />個人</);
    assert.match(official, /<h2>環境<\/h2><span class="badge off">未完成<\/span>/);
    assert.match(official, /<em class="missing">未安裝<\/em>/);
    assert.match(official, /<h2>課程安裝<\/h2>/);
    assert.match(official, /<h2>課程片段<\/h2>/);
    assert.match(official, /<details class="course-section" data-course-section="install" open><summary/);
    assert.match(official, /<details class="course-section" data-course-section="snippets" open><summary/);
    assert.match(official, /這堂課沒有片段。/);
    assert.equal(official.includes("<h2>指令</h2>"), false);
    assert.equal(official.includes("<h2>課程</h2>"), false);
    const withSnippet = renderPage(
      view({
        catalog: {
          source: "local",
          actions: [
            {
              id: "tools",
              title: "安裝 tools",
              kind: "package",
              command: "echo hi",
            },
          ],
          snippets: [
            { id: "stub", title: "骨架", body: "print(1)\n", pasteHint: "main.py" },
          ],
        },
        pendingCommand: "echo hi",
      }));
    assert.match(withSnippet, /class="kind-tag">套件</);
    assert.match(withSnippet, /<article class="install-card"><span class="install-number" aria-hidden="true">1<\/span><div class="install-main"><div class="install-line"><strong><span class="visually-hidden">安裝 1：<\/span>安裝 tools<\/strong><span data-kind="package" class="kind-tag">套件<\/span><\/div><\/div><form method="post" action="\/prepare">/);
    assert.match(withSnippet, /<button type="submit"[^>]*>安裝<\/button>/);
    assert.equal(withSnippet.includes("install-top"), false);
    assert.equal(withSnippet.includes("查看完整指令"), false);
    assert.equal(withSnippet.includes("<code>echo hi</code>"), false);
    assert.match(withSnippet, /class="confirm-dialog"/);
    assert.match(withSnippet, /確認安裝/);
    assert.match(withSnippet, /確認執行/);
    assert.equal(withSnippet.includes("<h3>指令輸出</h3>"), false);
    const outputted = renderPage(
      view({ commandOutput: "Installed 1 package\n" }));
    assert.equal(outputted.includes('class="command-output"'), false);
    assert.equal(outputted.includes("Installed 1 package"), false);
    assert.equal(outputted.includes('class="confirm-dialog"'), false);
    assert.match(withSnippet, /骨架/);
    assert.match(withSnippet, /<article class="snippet-card"><span class="snippet-number" aria-hidden="true">1<\/span>/);
    assert.match(withSnippet, /<div class="snippet-line"><strong><span class="visually-hidden">片段 1：<\/span>骨架<\/strong><span class="snippet-hint">main\.py<\/span><\/div>/);
    assert.equal(withSnippet.includes('<p class="hint">main.py</p>'), false);
    assert.match(withSnippet, /<button type="button" data-copy-snippet="stub" aria-label="複製「骨架」"><svg[^]*?<\/svg><span>複製<\/span><\/button>/);
    assert.match(withSnippet, /<details class="snippet-peek"><summary>查看內容<\/summary><pre class="snippet-code">print\(1\)\n<\/pre><\/details>/);
    assert.equal(withSnippet.includes('data-kind="snippet"'), false);
    const copiedSnippet = renderPage(view({
      catalog: {
        source: "local",
        actions: [],
        snippets: [
          { id: "a", title: "第一段", body: "one" },
          { id: "b", title: "第二段", body: "two" },
        ],
      },
      copiedSnippetIds: ["b"],
    }));
    assert.match(copiedSnippet, /<article class="snippet-card"><span class="snippet-number" aria-hidden="true">1<\/span>[^]*?<span>複製<\/span>/);
    assert.match(copiedSnippet, /<article class="snippet-card copied"><span class="snippet-number" aria-hidden="true">2<\/span>/);
    assert.match(copiedSnippet, /<button type="button" class="quiet" data-copy-snippet="b" aria-label="再複製一次「第二段」"><svg[^]*?<\/svg><span>✓ 已複製<\/span><\/button>/);
    assert.equal(withSnippet.includes(">展開</button>"), false);
    assert.equal(withSnippet.includes("<h3>本課片段</h3>"), false);
    assert.equal(withSnippet.includes("這堂課沒有片段。"), false);
    const installAt = withSnippet.indexOf("<h2>課程安裝</h2>");
    const snippetAt = withSnippet.indexOf("<h2>課程片段</h2>");
    const actionAt = withSnippet.indexOf("安裝 tools");
    const titleAt = withSnippet.indexOf("骨架");
    assert.equal(installAt < snippetAt, true);
    assert.equal(actionAt < snippetAt && titleAt > snippetAt, true);
    assert.match(official, /aria-label="更新課堂內容"/);
    const readyTools = [
      { id: "uv" as const, label: "uv", readiness: "ready" as const, selected: false },
      { id: "git" as const, label: "git", readiness: "ready" as const, selected: false },
      { id: "node" as const, label: "Node.js", readiness: "ready" as const, selected: false },
      { id: "pwsh" as const, label: "PowerShell 7", readiness: "ready" as const, selected: false },
    ];
    const ready = renderPage(view({ tools: readyTools }));
    assert.match(ready, /<h2>環境<\/h2><span class="badge">已就緒<\/span>/);
    const nonePicked = renderPage(view({ installAvailable: true }));
    assert.match(nonePicked, /class="go" disabled>確認安裝/);
    const onePicked = renderPage(
      view({
        installAvailable: true,
        tools: [
          { id: "uv", label: "uv", readiness: "missing", selected: true },
          { id: "git", label: "git", readiness: "missing", selected: false },
          { id: "node", label: "Node.js", readiness: "ready", selected: false },
          { id: "pwsh", label: "PowerShell 7", readiness: "missing", selected: false },
        ],
      }));
    assert.match(onePicked, /class="go">確認安裝/);
    const classroom = renderPage(
      view({ mode: "classroom", modelId: "gpt", modelRestart: ["codex"] }));
    assert.match(classroom, /class="badge">課堂可用 1 個</);
    assert.match(classroom, /<li>gpt<\/li>/);
    assert.doesNotMatch(classroom, /class="model-value"/);
    assert.match(classroom, /Codex 還在裝睡。重新開啟 Codex 後生效/);
    assert.match(official, /\.restart \{ color: light-dark\(#9a4a08, #fbbf24\); \}/);
    assert.match(official, /:root:not\(\[data-appearance="light"\]\) \{ --bg: #212121; \}/);
    assert.doesNotMatch(official, /data-setting="資料夾"/);
    assert.match(official, /action="\/pick-folder"/);
    assert.match(official, />選擇專案資料夾</);
    assert.equal(official.includes("設定專案資料夾"), false);
    const picked = renderPage(view({ projectFolder: "D:\\lesson" }));
    assert.match(picked, />變更</);
    assert.match(official, /尚未選擇安裝位置/);
    assert.equal((official.match(/<form[^>]*action="\/pick-folder"/g) ?? []).length, 1);
    assert.ok(official.indexOf('class="project-folder-row"') < official.indexOf('data-setting="環境"'));
    assert.ok(official.indexOf('data-setting="環境"') < official.indexOf('data-course-section="install"'));
    assert.equal(official.includes("安裝課程時會寫進這裡。"), false);
    assert.match(picked, /class="folder-path" title="D:\\lesson">D:\\lesson</);
    const bad = renderPage(view({ folderError: "這不是資料夾。" }));
    assert.match(bad, /這不是資料夾。/);
    assert.match(official, /class="brand-title">VansPod</);
    assert.match(official, /grid-template-columns: 232px/);
    assert.match(official, /translateX\(-100%\)/);
    assert.match(official, /class="tile-head"><h2>連線<\/h2><span class="badge">已連線<\/span>/);
    const offline = renderPage(view({ connected: false }));
    assert.match(offline, /class="badge off">未連線</);
    assert.match(official, /class="connection-copy"/);
    assert.equal(official.includes(">複製 Classroom API Key<"), false);
    const welcomed = renderPage(
      view({
        nickname: "Jeff",
        courseTitle: "Jeff AI 素養課程",
        sessionTitle: "第一堂 : 先問，為什麼?",
        classLabel: "Jeff AI 素養課程 · 第一堂 : 先問，為什麼?",
        detail: "Classroom API Key 已設定。",
      }));
    assert.match(welcomed, /class="connection-meta"><span>第一堂 : 先問，為什麼\?<\/span><span class="connection-separator" aria-hidden="true">·<\/span><span>Jeff<\/span>/);
    assert.match(welcomed, /class="course-title">Jeff AI 素養課程</);
    assert.match(welcomed, /API Key 已設定/);
    assert.match(welcomed, /class="key-row"/);
    assert.match(welcomed, /清除連線/);
    assert.equal(welcomed.includes('<p class="class-label">'), false);
    assert.equal(welcomed.includes('<p class="detail">Classroom API Key 已設定。</p>'), false);
    assert.equal(welcomed.includes("邀請碼"), false);
    assert.equal(official.includes('class="shell"'), false);
    assert.equal(rail.includes(KEY), false);
    assert.equal(official.includes(KEY), false);
  });
});

describe("Environment Install card", () => {
  const tools = [
    { id: "uv" as const, label: "uv", readiness: "ready" as const, version: "uv 0.5.1", selected: false },
    { id: "git" as const, label: "git", readiness: "missing" as const, reason: "找不到 git", selected: true },
    { id: "node" as const, label: "Node.js", readiness: "needsRepair" as const, version: "v25.0.0", reason: "需要 Node.js LTS，且 npm 必須可正常執行", selected: true },
    { id: "pwsh" as const, label: "PowerShell 7", readiness: "ready" as const, version: "PowerShell 7.4.6", selected: false },
  ];
  const row = (html: string, id: string) => html.match(new RegExp(`<label class="tool"><input type="checkbox" name="tool" value="${id}"[\\s\\S]*?</label>`))?.[0] ?? "";

  it("shows each tool's Environment Tool Readiness and offers 安裝 or 修復", () => {
    const html = renderPage(view({ installAvailable: true, tools }));
    assert.match(row(html, "uv"), /<em>已就緒<\/em>/);
    assert.doesNotMatch(row(html, "uv"), /tool-action/);
    assert.match(row(html, "git"), /<em class="missing">未安裝<\/em><span class="tool-action">安裝<\/span>/);
    assert.match(row(html, "node"), /<em class="needs-repair">需要修復<\/em><span class="tool-action">修復<\/span>/);
    assert.match(row(html, "node"), /title="需要 Node\.js LTS，且 npm 必須可正常執行"/);
    assert.match(html, /<h2>環境<\/h2><span class="badge off">未完成<\/span>/);
    assert.match(html, /尚缺 2 項工具/);
  });

  it("lets the student install without a Project Folder", () => {
    const html = renderPage(view({ installAvailable: false, tools }));
    assert.equal(/<button[^>]*form="settings-environment"[^>]*>確認安裝/.test(html), true);
    assert.doesNotMatch(html.match(/<button[^>]*form="settings-environment"[^>]*>確認安裝/)?.[0] ?? "", /disabled/);
  });

  it("shows tools as being checked, not as 未安裝, until the first check finishes", () => {
    const html = renderPage(view({ tools: tools.map((tool) => ({ id: tool.id, label: tool.label, readiness: "checking" as const, selected: false })) }));
    for (const tool of tools) assert.match(row(html, tool.id), /<em class="checking">檢查中<\/em>/);
    assert.doesNotMatch(html, /未安裝/);
    assert.doesNotMatch(html, /尚缺/);
    assert.match(html, /正在檢查工具/);
    assert.match(html, /<h2>環境<\/h2><span class="badge off">檢查中<\/span>/);
  });

  it("counts a tool that needs repair as not ready", () => {
    const html = renderPage(view({ tools: tools.map((tool) => ({ ...tool, readiness: tool.id === "node" ? "needsRepair" as const : "ready" as const })) }));
    assert.match(html, /<span class="badge off">未完成<\/span>/);
    assert.match(html, /尚缺 1 項工具/);
  });

  it("offers 開啟紀錄資料夾 in the environment card after an install, but not while one runs", () => {
    const card = (html: string) => html.match(/<section[^>]*data-setting="環境"[\s\S]*?<\/section>/)?.[0] ?? "";
    const openLog = /<form method="post" action="\/environment-log"><button type="submit" class="quiet">開啟紀錄資料夾<\/button><\/form>/;
    assert.doesNotMatch(renderPage(view({ tools })), /environment-log/);
    const folder = "C:\\VansPod\\InstallLogs\\2026-10-20_100000";
    assert.match(card(renderPage(view({ tools, environmentLogFolder: folder }))), openLog);
    assert.doesNotMatch(renderPage(view({ tools, environmentLogFolder: folder, commandRunning: true })), /environment-log/);
    assert.doesNotMatch(renderPage(view({ tools, environmentLogFolder: folder })), /InstallLogs/, "the path stays off the page");
  });

  it("offers 開啟 VS Code in the environment card only while VS Code is ready", () => {
    const card = (html: string) => html.match(/<section[^>]*data-setting="環境"[\s\S]*?<\/section>/)?.[0] ?? "";
    const openVsCode = /<form method="post" action="\/open-vscode"><button type="submit" class="quiet">開啟 VS Code<\/button><\/form>/;
    const withVsCode = (readiness: "ready" | "needsRepair" | "missing" | "checking") =>
      [...tools, { id: "vscode" as const, label: "VS Code", readiness, selected: false }];
    assert.match(card(renderPage(view({ tools: withVsCode("ready") }))), openVsCode);
    for (const readiness of ["needsRepair", "missing", "checking"] as const) {
      assert.doesNotMatch(renderPage(view({ tools: withVsCode(readiness) })), /open-vscode/, readiness);
    }
  });

  it("shows each tool's stage and download progress while an Environment Install runs", () => {
    const MB = 1024 * 1024;
    const running = [
      { ...tools[0], progress: { stage: "done" as const } },
      { ...tools[1], progress: { stage: "downloading" as const, downloaded: 2 * MB, total: 8 * MB } },
      { ...tools[2], progress: { stage: "waiting" as const } },
      tools[3],
    ];
    const html = renderPage(view({ commandRunning: true, environmentInstalling: true, tools: running }));
    const stage = (id: string) => row(html, id).match(new RegExp(`<span class="tool-stage" data-environment-stage="${id}">([^<]*)</span>`))?.[1];
    assert.equal(stage("uv"), "完成");
    assert.equal(stage("git"), "下載中 2.0 / 8.0 MB（25%）");
    assert.equal(stage("node"), "等待中");
    assert.equal(stage("pwsh"), undefined, "tools outside this install keep their readiness");
    assert.match(row(html, "pwsh"), /<em>已就緒<\/em>/);
    assert.match(html, /<details class="environment-tools" open>/);
    assert.match(html, /正在安裝工具…/);
    assert.match(html, /<form[^>]*data-environment-progress/);
  });

  it("words every Environment Install stage for the student", () => {
    const MB = 1024 * 1024;
    assert.equal(environmentStageText({ stage: "waiting" }), "等待中");
    assert.equal(environmentStageText({ stage: "preparing" }), "準備中");
    assert.equal(environmentStageText({ stage: "downloading" }), "下載中");
    assert.equal(environmentStageText({ stage: "downloading", downloaded: 3.5 * MB }), "下載中 3.5 MB");
    assert.equal(environmentStageText({ stage: "downloading", downloaded: 0, total: 0 }), "下載中 0.0 MB");
    assert.equal(environmentStageText({ stage: "downloading", downloaded: 50 * MB, total: 100 * MB }), "下載中 50.0 / 100.0 MB（50%）");
    assert.equal(environmentStageText({ stage: "installing" }), "安裝中");
    assert.equal(environmentStageText({ stage: "verifying" }), "驗證中");
    assert.equal(environmentStageText({ stage: "done" }), "完成");
    assert.equal(environmentStageText({ stage: "failed" }), "失敗");
  });

  it("reports the running Environment Install's stages for polling", () => {
    const running = [
      { ...tools[0], progress: { stage: "installing" as const } },
      { ...tools[1], progress: { stage: "downloading" as const, downloaded: 1024 * 1024 } },
      tools[2],
      tools[3],
    ];
    assert.deepEqual(environmentStatus(view({ commandRunning: true, environmentInstalling: true, tools: running })), {
      running: true,
      tools: [{ id: "uv", stage: "安裝中" }, { id: "git", stage: "下載中 1.0 MB" }],
    });
    assert.deepEqual(environmentStatus(view({ tools })), { running: false, tools: [] });
  });

  it("polls for progress while an Environment Install runs", () => {
    const html = renderPage(view({ commandRunning: true, environmentInstalling: true, tools: [{ ...tools[1], progress: { stage: "waiting" as const } }] }));
    assert.ok(html.includes(environmentProgressScript));
  });

  it("does not poll for progress when no Environment Install runs", () => {
    assert.doesNotMatch(renderPage(view({ tools })), /<form[^>]*data-environment-progress/);
    assert.doesNotMatch(renderPage(view({ tools, commandRunning: true })), /<form[^>]*data-environment-progress/, "a Course Install Action is not an Environment Install");
  });
});
describe("Abort Install on the page", () => {
  const abortForms = (html: string) => [...html.matchAll(/<form[^>]*action="\/abort-install"[^>]*>[\s\S]*?<\/form>/g)].map((match) => match[0]);

  it("puts 停止安裝 where 取消 was in the running Course Install Action dialog", () => {
    const html = renderPage(view({ commandRunning: true, pendingCommand: "uv run streamlit run app.py", projectFolder: "D:\\lesson" }));
    const choices = html.match(/<div class="confirm-dialog"[\s\S]*?<div class="choices">([\s\S]*?)<\/div>/)?.[1] ?? "";
    const forms = [...choices.matchAll(/<form[^>]*>[\s\S]*?<\/form>/g)].map((match) => match[0]);
    assert.deepEqual(forms.map((form) => form.match(/action="([^"]+)"/)?.[1]), ["/confirm", "/cancel", "/abort-install"]);
    assert.match(forms[0], /<form[^>]*data-reserved/);
    assert.match(forms[1], /<form[^>]*hidden/);
    assert.match(forms[2], /停止安裝/);
    assert.doesNotMatch(forms[2].match(/<form[^>]*>/)?.[0] ?? "", /hidden/);
  });

  it("replaces 確認安裝 with 停止安裝 in the environment card while an Environment Install runs", () => {
    const html = renderPage(view({ commandRunning: true }));
    const card = html.match(/<section[^>]*data-setting="環境"[\s\S]*?<\/section>/)?.[0] ?? "";
    const actions = card.match(/<div class="settings-actions">([\s\S]*)<\/div>/)?.[1] ?? "";
    assert.match(actions, /<button[^>]*form="settings-environment"[^>]*hidden[^>]*>確認安裝/);
    const form = abortForms(actions)[0] ?? "";
    assert.ok(actions.trimEnd().endsWith(form), "停止安裝 takes the last slot");
    assert.match(form, /停止安裝/);
    assert.doesNotMatch(form.match(/<form[^>]*>/)?.[0] ?? "", /hidden/);
  });

  it("keeps every 停止安裝 hidden when nothing is installing, and asks before aborting", () => {
    const html = renderPage(view({ pendingCommand: "echo hi", projectFolder: "D:\\lesson" }));
    const forms = abortForms(html);
    assert.ok(forms.length >= 2);
    for (const form of forms) assert.match(form.match(/<form[^>]*>/)?.[0] ?? "", /hidden/);
    assert.match(html, /停止後安裝可能不完整，確定停止？/);
  });
});

describe("Prompt 觀察室 page", () => {
  const sideNav = (html: string) => html.match(/<nav aria-label="選單">[\s\S]*?<\/nav>/)?.[0] ?? "";
  const items = (nav: string) => [...nav.matchAll(/<a [^>]*class="side-item"[^>]*>[\s\S]*?<\/a>/g)].map(match => match[0]);

  it("lists 教室設定 then Prompt 觀察室 in the side menu, marking the current page", () => {
    const settings = items(sideNav(renderPage(view())));
    assert.equal(settings.length, 2);
    assert.match(settings[0], /教室設定/); assert.match(settings[1], /Prompt 觀察室/);
    assert.match(settings[0], /aria-current="page"/); assert.doesNotMatch(settings[1], /aria-current/);
    assert.match(settings[1], /href="\/prompt-inspector"/);

    const inspector = renderInspectorPage({ recording: false, captures: [], dropped: 0 });
    const inspectorItems = items(sideNav(inspector));
    assert.equal(inspectorItems.length, 2);
    assert.doesNotMatch(inspectorItems[0], /aria-current/); assert.match(inspectorItems[1], /aria-current="page"/);
    assert.match(inspectorItems[0], /href="\/"/);
  });

  it("keeps 法鬥超人 patrolling in the page head, outside the redrawn list", () => {
    for (const recording of [false, true]) {
      const html = renderInspectorPage({ recording, captures: [], dropped: 0 });
      const head = html.match(/<header class="page-head pi-head">[\s\S]*?<\/header>/)?.[0] ?? "";
      assert.match(head, /class="connection-mascot"/);
      assert.doesNotMatch(head, /mascot-waiting/);
      assert.match(html, /\.mascot-traveler \{/);
      assert.match(html, /\.mascot-pause/);
    }
  });

  it("stretches 法鬥超人's walks for a wider lane and shortens them for a narrower one, keeping the 6-second rests", () => {
    const wide = patrolKeyframes("-fit", 2);
    assert.equal(wide.lap, 60);
    assert.deepEqual(wide.marks, [0, 12, 18, 42, 48, 60]);
    // Arrives left at 12s, rests until 18s, arrives right at 42s, rests until 48s.
    assert.match(wide.css, /@keyframes mascot-walk-fit \{[\s\S]*?20%, 30% \{ transform: translateX\(0\)/);
    assert.match(wide.css, /70%, 80% \{ transform: translateX\(max/);
    assert.deepEqual(patrolKeyframes("-fit", 0.5).marks, [0, 3, 9, 15, 21, 24]);
  });

  it("keeps 教室設定 on the 36-second lap with its original keyframe stops", () => {
    const base = patrolKeyframes("", 1);
    assert.equal(base.lap, 36);
    assert.match(base.css, /16\.666667%, 33\.333333% \{ transform: translateX\(0\)/);
    assert.match(base.css, /66\.666667%, 83\.333333% \{ transform: translateX\(max/);
    assert.doesNotMatch(renderPage(view()), /mascot-walk-fit/);
  });

  it("alternates 法鬥超人's footsteps at any lane width", () => {
    for (const scale of [1, 1.37, 2.71, 0.6]) {
      const left = patrolKeyframes("-fit", scale).css.match(/@keyframes mascot-left-step-fit \{[\s\S]*?\}\s*\}/)?.[0] ?? "";
      const angles = [...left.matchAll(/rotate\((-?\d+)deg\)/g)].map(match => Number(match[1]));
      assert.ok(angles.includes(5) && angles.includes(-5), `scale ${scale} steps both ways`);
      angles.forEach((angle, index) => {
        if (angle !== 0 && index > 0) assert.notEqual(angle, angles[index - 1], `scale ${scale} frame ${index}`);
      });
    }
  });

  it("fits 法鬥超人's lap to the Prompt 觀察室 lane", () => {
    const inspector = renderInspectorPage({ recording: false, captures: [], dropped: 0 });
    assert.match(inspector, /\.pi-head \.mascot-traveler \{ animation-name: mascot-walk-fit; animation-duration: var\(--patrol-lap, 36s\); \}/);
    assert.match(inspector, /<style id="mascot-patrol-fit">@keyframes mascot-walk-fit/);
  });

  it("turns 法鬥超人 around instantly at each end of the patrol, on both pages", () => {
    for (const html of [renderPage(view()), renderInspectorPage({ recording: false, captures: [], dropped: 0 })]) {
      assert.match(html, /\.mascot-facing \{[^}]*animation: mascot-turn 36s step-end/);
      assert.match(html, /\.mascot-logo \{[^}]*animation: mascot-turn 36s step-end/);
    }
  });

  it("shares the mobile drawer and appearance toggle with 教室設定", () => {
    const html = renderInspectorPage({ recording: false, captures: [], dropped: 0 });
    assert.match(html, /class="menu-toggle"[^>]*aria-controls="side-menu"/);
    assert.match(html, /<header class="bar" id="side-menu">/);
    assert.match(html, /class="drawer-scrim"/);
    assert.match(html, /data-appearance-toggle/);
  });

  it("puts the 版本更新 button next to the appearance toggle at the foot of the side menu, on both pages", () => {
    for (const html of [renderPage(view()), renderInspectorPage({ recording: false, captures: [], dropped: 0 })]) {
      const menu = html.match(/<header class="bar" id="side-menu">[\s\S]*?<\/header>/)?.[0] ?? "";
      const foot = menu.match(/<div class="side-foot">[\s\S]*?<\/div>/)?.[0] ?? "";
      assert.match(foot, /data-appearance-toggle/);
      assert.match(foot, /<button type="button" class="update-button" data-version-update hidden aria-label="檢查更新"[^>]*><svg/);
    }
  });

  it("offers 開始錄製 and 清除 while recording is off", () => {
    const html = renderInspectorPage({ recording: false, captures: [], dropped: 0 });
    const bar = html.match(/<section[^>]*class="tile pi-recorder"[\s\S]*?<\/section>/)?.[0] ?? "";
    assert.match(bar, /<form method="post" action="\/prompt-capture\/start"><button[^>]*>開始錄製<\/button><\/form>/);
    assert.match(bar, /action="\/prompt-capture\/clear"><button[^>]*>清除<\/button>/);
    assert.doesNotMatch(bar, /暫停/);
    assert.doesNotMatch(bar, /pi-rec-dot/);
  });

  it("offers 暫停 and 清除 while recording", () => {
    const html = renderInspectorPage({ recording: true, captures: [], dropped: 0 });
    const bar = html.match(/<section[^>]*class="tile pi-recorder"[\s\S]*?<\/section>/)?.[0] ?? "";
    assert.match(bar, /錄製中/);
    assert.match(bar, /pi-rec-dot/);
    assert.match(bar, /action="\/prompt-capture\/pause"><button[^>]*>暫停<\/button>/);
    assert.match(bar, /action="\/prompt-capture\/clear"><button[^>]*>清除<\/button>/);
    assert.doesNotMatch(bar, /開始錄製/);
  });

  it("explains memory-only storage, the 20 limit and Classroom-only capture, with an empty-state hint", () => {
    const html = renderInspectorPage({ recording: false, captures: [], dropped: 0 });
    assert.match(html, /只記在這台電腦的記憶體，最多 20 筆，關掉 VansPod 就清除。只有切到「課堂」的客戶端會被記錄。/);
    assert.match(html, /切到「課堂」並開始錄製後，送出的 prompt 會出現在這裡/);
  });

  function recorded() {
    const capture = createPromptCapture(); capture.start();
    const sent = (messages: unknown[]) => ({
      model: "claude-sonnet", system: [{ type: "text", text: "You are Claude Code." }],
      tools: [{ name: "Read", description: "Reads a file. Paths are absolute.", input_schema: { type: "object" } }, { name: "Skill", description: "Invoke a skill.", input_schema: { type: "object" } }],
      messages,
    });
    capture.record({ client: "claude", adapter: "messages", path: "/v1/messages", raw: { client_marker: "older" }, sent: sent([{ role: "user", content: "older ask" }]) });
    capture.record({ client: "claude", adapter: "messages", path: "/v1/messages", raw: { client_marker: "raw-only" }, sent: sent([
      { role: "user", content: [{ type: "text", text: "<system-reminder>skills: tdd</system-reminder>" }, { type: "text", text: "讀 <hello>.py" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "hello.py" } }] },
    ]) });
    return { recording: true, ...capture.list() };
  }

  it("lists captures newest first with number, client, model, time, summary and a size bar", () => {
    const html = renderInspectorPage(recorded());
    assert.doesNotMatch(html.match(/<main[\s\S]*<\/main>/)?.[0] ?? "", /送出的 prompt 會出現在這裡/);
    const list = html.match(/<div class="pi-req-list">[\s\S]*?<\/div><\/section>/)?.[0] ?? "";
    const items = [...list.matchAll(/<button[^>]*class="pi-req[^"]*"[\s\S]*?<\/button>/g)].map(match => match[0]);
    assert.equal(items.length, 2);
    assert.match(html, /<section class="tile pi-list"><div class="tile-head"><h2>觀察紀錄<\/h2>/);
    assert.match(items[0], /#2 Claude Code/); assert.match(items[1], /#1 Claude Code/);
    assert.match(items[0], /<span class="pi-req-model">claude-sonnet<\/span>/);
    assert.match(items[0], /\d\d:\d\d:\d\d/);
    assert.match(items[0], /呼叫 Read/); assert.match(items[1], /older ask/);
    assert.match(items[0], /class="pi-stack"/);
    assert.match(items[0], /class="pi-req on"/);
  });

  it("shows the newest capture's anatomy: meta row, size bar, legend and three sections", () => {
    const html = renderInspectorPage(recorded());
    const detail = html.match(/<section class="tile pi-detail">[\s\S]*<\/section><\/div>/)?.[0] ?? "";
    assert.match(detail, /#2 解剖/);
    assert.match(detail, /Claude Code · claude-sonnet · Messages · messages adapter · 約 \d+ tokens（估算）/);
    assert.match(detail, /class="pi-stack"/);
    assert.match(detail, /class="pi-legend"/);
    assert.match(detail, /data-view="parts"[^>]*>結構</); assert.match(detail, /data-view="raw"[^>]*>原始 JSON</);
    assert.match(detail, /<details class="pi-sec" data-sec="system"[^>]*>[\s\S]*You are Claude Code\./);
    const tools = detail.match(/<details class="pi-sec" data-sec="tools"[\s\S]*?<\/details><\/details>/)?.[0] ?? "";
    assert.match(tools, /<code>Read<\/code><span>Reads a file\.<\/span>/);
    assert.match(tools, /class="pi-tool is-skill"/);
    const talk = detail.match(/<details class="pi-sec" data-sec="messages"[\s\S]*/)?.[0] ?? "";
    assert.match(talk, /class="pi-msg role-user is-reminder[^"]*"[\s\S]*?User（客戶端自動附加）[\s\S]*?<mark class="pi-skill">/);
    assert.match(talk, /讀 &lt;hello&gt;\.py/);
    assert.match(talk, /Assistant 呼叫工具 <code>Read<\/code>[\s\S]*?file_path/);
  });

  it("names the client, protocol and adapter in the meta row for Responses and Chat Completions captures", () => {
    for (const [client, adapter, path, sent, label] of [
      ["codex", "responses", "/v1/responses", { model: "gpt-5", input: "hi" }, "Codex · gpt-5 · Responses · responses adapter"],
      ["copilot", "chat", "/v1/chat/completions", { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }, "VS Code Chat · gpt-4o · Chat Completions · chat adapter"],
    ] as const) {
      const capture = createPromptCapture(); capture.start();
      capture.record({ client, adapter, path, sent, raw: {} });
      const html = renderInspectorPage({ recording: true, ...capture.list() });
      assert.match(html, new RegExp(`<p class="pi-meta">${label} · 約 \\d+ tokens（估算）</p>`));
      assert.match(html, new RegExp(`POST ${path}\\n\\{`));
    }
  });

  it("offers the raw JSON sent to Router, with its path, and the client's original request", () => {
    const html = renderInspectorPage(recorded());
    assert.match(html, /data-raw="sent"[^>]*>送給 Router</);
    assert.match(html, /data-raw="raw"[^>]*>客戶端原始請求</);
    assert.match(html, /POST \/v1\/messages\n\{/);
    assert.match(html, /raw-only/);
  });

  it("marks failed requests and Web Search follow-ups, and says how many older captures were dropped", () => {
    const capture = createPromptCapture(); capture.start();
    const ask = (text: string, webSearchFollowUp = false) => capture.record({ client: "claude", adapter: "messages", path: "/v1/messages", raw: {}, sent: { model: "m", messages: [{ role: "user", content: text }] }, webSearchFollowUp });
    for (let index = 0; index < 21; index++) ask(`ask ${index}`);
    ask("search again", true)(503);
    const html = renderInspectorPage({ recording: true, ...capture.list() });
    const list = html.match(/<section class="tile pi-list">[\s\S]*?<\/section>/)?.[0] ?? "";
    const items = [...list.matchAll(/<button[^>]*class="pi-req[^"]*"[\s\S]*?<\/button>/g)].map(match => match[0]);
    assert.match(items[0], /class="[^"]*pi-failed[^"]*"[^>]*>失敗 HTTP 503</);
    assert.match(items[0], />Web Search 追加</);
    assert.doesNotMatch(items[1], /失敗 HTTP|Web Search 追加/);
    assert.match(list, /較早的 2 筆已捨去/);
    const detail = html.match(/<section class="tile pi-detail">[\s\S]*<\/section><\/div>/)?.[0] ?? "";
    assert.match(detail, /失敗 HTTP 503/);
    assert.match(detail, /Web Search 追加/);
  });

  it("fades what was sent before, tags this turn's additions and marks new conversations", () => {
    const capture = createPromptCapture(); capture.start();
    const first = [{ role: "user", content: "older ask" }];
    capture.record({ client: "claude", adapter: "messages", path: "/v1/messages", raw: {}, sent: { model: "m", messages: first } });
    capture.record({ client: "claude", adapter: "messages", path: "/v1/messages", raw: {}, sent: { model: "m", messages: [...first, { role: "assistant", content: "done" }, { role: "user", content: "next ask" }] } });
    const html = renderInspectorPage({ recording: true, ...capture.list() });
    const list = html.match(/<div class="pi-req-list">[\s\S]*?<\/div><\/section>/)?.[0] ?? "";
    const items = [...list.matchAll(/<button[^>]*class="pi-req[^"]*"[\s\S]*?<\/button>/g)].map(match => match[0]);
    assert.doesNotMatch(items[0], /新對話/); assert.match(items[1], /新對話/);
    assert.match(items[0], /next ask/);
    const detail = html.match(/<section class="tile pi-detail">[\s\S]*<\/section><\/div>/)?.[0] ?? "";
    assert.doesNotMatch(detail.match(/<div class="tile-head">[\s\S]*?<\/div>/)?.[0] ?? "", /新對話/);
    const talk = detail.match(/<details class="pi-sec" data-sec="messages"[\s\S]*/)?.[0] ?? "";
    assert.match(talk, /<div class="pi-msg role-user"><div class="pi-msg-head"><span>User<\/span><\/div><pre>older ask/);
    assert.match(talk, /class="pi-msg role-user is-new"><div class="pi-msg-head"><span>User<\/span><span class="pi-new">本輪新增<\/span><\/div><pre>next ask/);
    assert.match(html, /\.pi-msg:not\(\.is-new\) \{ opacity:/);
    const firstDetail = inspectorBody(capture.list(), { selected: 1, view: "parts", raw: "sent" }).match(/<section class="tile pi-detail">[\s\S]*/)?.[0] ?? "";
    assert.match(firstDetail, /<div class="tile-head"><h2>#1 解剖<\/h2><span class="badge">新對話<\/span><\/div>/);
  });

  it("refreshes every two seconds and stacks list and detail on narrow screens", () => {
    const html = renderInspectorPage(recorded());
    assert.match(html, /fetch\("\/prompt-capture"/);
    assert.match(html, /setInterval\(refresh, 2000\);/);
    assert.match(html, /@media \(max-width: [^)]+\) \{[^}]*\.pi-a \{ grid-template-columns: 1fr; \}/);
  });
});

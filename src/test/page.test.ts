import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ClassroomAppView } from "../classroomApp";
import { modelStatus, renderPage } from "../page";
import { modelStatusScript } from "../modelStatus";
import { renderPrototypePage } from "../pagePrototype";
import vm from "node:vm";
import { settingsActionsScript } from "../settingsActions";

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
      { id: "uv", label: "uv", installed: false, selected: false },
      { id: "git", label: "git", installed: false, selected: false },
      { id: "node", label: "Node.js", installed: false, selected: false },
      { id: "pwsh", label: "PowerShell 7", installed: false, selected: false },
    ],
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
    const form = { action: "/switch", matches: () => true, querySelector: () => null, closest: () => card };
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
        querySelector: () => card,
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
    assert.match(withSnippet, /class="install-card"/);
    assert.match(withSnippet, />安裝</);
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
    assert.match(withSnippet, /data-copy-snippet="stub">複製<\/button>/);
    assert.match(withSnippet, /<pre class="snippet-code">print\(1\)\n<\/pre>/);
    assert.equal(withSnippet.includes(">展開</button>"), false);
    assert.equal(withSnippet.includes("<h3>本課片段</h3>"), false);
    assert.equal(withSnippet.includes("這堂課沒有片段。"), false);
    const installAt = withSnippet.indexOf("<h2>課程安裝</h2>");
    const snippetAt = withSnippet.indexOf("<h2>課程片段</h2>");
    const actionAt = withSnippet.indexOf("安裝 tools");
    const titleAt = withSnippet.indexOf("骨架");
    assert.equal(installAt < snippetAt, true);
    assert.equal(actionAt < snippetAt && titleAt > snippetAt, true);
    assert.match(official, /重新載入/);
    const readyTools = [
      { id: "uv" as const, label: "uv", installed: true, selected: false },
      { id: "git" as const, label: "git", installed: true, selected: false },
      { id: "node" as const, label: "Node.js", installed: true, selected: false },
      { id: "pwsh" as const, label: "PowerShell 7", installed: true, selected: false },
    ];
    const ready = renderPage(view({ tools: readyTools }));
    assert.match(ready, /<h2>環境<\/h2><span class="badge">已就緒<\/span>/);
    const nonePicked = renderPage(view({ installAvailable: true }));
    assert.match(nonePicked, /class="go" disabled>確認安裝/);
    const onePicked = renderPage(
      view({
        installAvailable: true,
        tools: [
          { id: "uv", label: "uv", installed: false, selected: true },
          { id: "git", label: "git", installed: false, selected: false },
          { id: "node", label: "Node.js", installed: true, selected: false },
          { id: "pwsh", label: "PowerShell 7", installed: false, selected: false },
        ],
      }));
    assert.match(onePicked, /class="go">確認安裝/);
    const classroom = renderPage(
      view({ mode: "classroom", modelId: "gpt", modelRestart: ["codex"] }));
    assert.match(classroom, /class="badge">課堂可用 1 個</);
    assert.match(classroom, /<li>gpt<\/li>/);
    assert.doesNotMatch(classroom, /class="model-value"/);
    assert.match(classroom, /設定已更新，重新開啟 Codex 後生效。/);
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

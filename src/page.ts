import { VERSION as APP_VERSION } from "./version";
import { resolveAppearance } from "./appearance";
import { installProgressScript } from "./installProgress";
import { settingsActionsScript } from "./settingsActions";
import { modelStatusScript } from "./modelStatus";
import { classroomUpdateControl, classroomUpdateStyles, classroomUpdateScript } from "./classroomUpdate";
import { connectionMascot, connectionMascotStyles, connectionMascotScript } from "./connectionMascot";
import { clientIcons } from "./clientIcons";
import { environmentIcons } from "./environmentIcons";
import type { ClassroomAppView } from "./classroomApp";
import {
  actionKindLabel,
  type InstallAction,
  type LessonSnippet,
} from "./courseCatalog";

const PRODUCT = "VansPod";
const VERSION = `v${APP_VERSION}`;

const COPY_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
const MOON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M21 14.5A8.5 8.5 0 1 1 9.5 3a7 7 0 0 0 11.5 11.5z"/></svg>`;
const SUN = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4" fill="currentColor"/><path stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5 5l1.4 1.4M17.6 17.6 19 19M19 5l-1.4 1.4M6.4 17.6 5 19"/></svg>`;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function locked(view: ClassroomAppView): string {
  return view.commandRunning ? " disabled" : "";
}

function clientLabel(client: "codex" | "claude" | "vscode"): string {
  if (client === "codex") return "Codex";
  if (client === "claude") return "Claude Code CLI";
  return "VS Code";
}

function restartHtml(view: ClassroomAppView): string {
  const clients = view.modelRestart ?? [];
  const routes = clients.filter((client) => client !== "vscode");
  const parts: string[] = [];
  if (routes.length > 0) {
    const names = routes.map((client) => clientLabel(client));
    const joined =
      names.length === 1
        ? names[0]
        : `${names.slice(0, -1).join("、")} 與 ${names[names.length - 1]}`;
    parts.push(`<p>設定幫你更新好了，${escapeHtml(joined)} 還在裝睡。重新開啟 ${escapeHtml(joined)} 後生效，披風可不包叫醒服務。</p>`);
  }
  if (clients.includes("vscode")) {
    parts.push(`<p>設定幫你更新好了，VS Code 還在裝睡。請完全退出 VS Code 再打開，不要只重載視窗。別敷衍牠，牠真的會繼續睡。</p>`);
  }
  return parts.length ? `<div class="model-update" role="status" data-restart-clients="${clients.join(",")}"><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7v2"/></svg><div>${parts.join("")}</div></div>` : "";
}

function statusWord(view: ClassroomAppView): string {
  if (!view.connected) return "未連線";
  return view.mode === "classroom" ? "Classroom" : "Native";
}

function notices(view: ClassroomAppView): string {
  const notice = view.notice && view.notice !== view.connectionNotice ? `<p class="notice">${escapeHtml(view.notice)}</p>` : "";
  const running = view.commandRunning ? `<p class="running">執行中</p>` : "";
  const klass = view.classLabel
    ? `<p class="class-label">${escapeHtml(view.classLabel)}</p>`
    : "";
  return `${klass}${notice}${running}`;
}

const COPY_KEY_NOTICE = "已複製 Classroom API Key。請勿分享給不信任的人。";

function connectionFeedback(view: ClassroomAppView): string {
  const original = view.connectionError || view.connectionNotice || (view.detail !== "Classroom API Key 已設定。" ? view.detail : "");
  const message = original === COPY_KEY_NOTICE
    ? "複製好了！API Key 不是群組伴手禮，別發給不信任的人喔。" : original;
  const feedback = `<div class="connection-feedback">${message ? `<div class="${view.connectionError ? "connection-error" : "connection-message"}" role="${view.connectionError ? "alert" : "status"}"><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 15v2"/></svg><p>${escapeHtml(message)}</p></div>` : ""}</div>`;
  return feedback;
}

function connectInner(view: ClassroomAppView): string {
  const feedback = connectionFeedback(view);
  if (view.canCopyKey) {
    const off = locked(view);
    return `<form method="post" action="/copy">
        <button type="submit"${off}>複製 Classroom API Key</button>
      </form>
      <form method="post" action="/clear">
        <button type="submit" class="quiet"${off}>清除連線</button>
      </form>${feedback}`;
  }
  return `<form class="stack" method="post" action="/redeem">
      <label>邀請碼 <input name="invite_code" autocomplete="off" value="${escapeHtml(view.connectionDraft?.inviteCode ?? "")}"${locked(view)}></label>
      <label>課堂暱稱 <input name="nickname" autocomplete="off" value="${escapeHtml(view.connectionDraft?.nickname ?? "")}"${locked(view)}></label>
      ${feedback}
      <button type="submit" class="go"${locked(view)}>連線</button>
    </form>`;
}

function folderInner(view: ClassroomAppView): string {
  const value = view.projectFolder ? ` value="${escapeHtml(view.projectFolder)}"` : "";
  const off = locked(view);
  const note = view.installNotice
    ? `<p class="hint">${escapeHtml(view.installNotice)}</p>`
    : "";
  return `<form class="stack" method="post" action="/project-folder">
      <label>專案資料夾 <input name="project_folder" autocomplete="off"${value}${off}></label>
      <button type="submit" class="go"${off}>設定專案資料夾</button>
      ${note}
    </form>`;
}

function modelInner(view: ClassroomAppView): string {
  const off = locked(view);
  const models = view.allowedModels ?? (view.modelId ? [view.modelId] : []);
  const list = models.length
    ? `<ul class="allowed-model-list">${models.map(id => `<li>${escapeHtml(id)}</li>`).join("")}</ul>`
    : `<p class="hint">${view.connected ? "這堂課尚無可用模型。" : "連線課堂後可查看。"}</p>`;
  return `
    ${restartHtml(view)}
    ${adapterForms(view)}
    <details class="allowed-models"><summary>老師允許的模型 <span>${models.length}</span></summary>${list}</details>
    <form method="post" action="/reload">
      <button type="submit" class="quiet"${off}>重新載入</button>
    </form>`;
}

function clientRoute(view: ClassroomAppView, client: "codex" | "claude" | "vscode") {
  return client === "codex" ? view.clientRoutes?.codex : client === "claude" ? view.clientRoutes?.claudeCode : view.clientRoutes?.vsCodeChat;
}

function clientLight(view: ClassroomAppView, client: "codex" | "claude" | "vscode") {
  const route = clientRoute(view, client);
  const detected = client === "vscode" ? route?.health !== "gray" : view.detectedClients?.[client] ?? false;
  const health = route && route.health !== "gray" ? route.health : detected ? "green" : "gray";
  const healthText = health === "red" ? "入口失敗" : health === "yellow" ? "等待重開" : health === "green" ? "可用" : "未偵測";
  const status = `${clientLabel(client)} ${route && route.health !== "gray" ? healthText : detected ? "已偵測" : "未偵測"}`;
  const lightClass = health === "green" ? " detected" : health === "red" || health === "yellow" ? ` health-${health}` : "";
  return { health, className: `client-light${lightClass}`, status };
}

export function modelStatus(view: ClassroomAppView) {
  return {
    lights: { codex: clientLight(view, "codex"), claude: clientLight(view, "claude"), vscode: clientLight(view, "vscode") },
    restart: restartHtml(view),
  };
}

function adapterForms(view: ClassroomAppView): string {
  const selected = view.adapters ?? { codex: "responses", claude: "responses" };
  const forms = (["codex", "claude", "vscode"] as const).map(client => {
    const choices = client === "claude" ? ["responses", "chat", "messages"] : ["responses", "chat"];
    const selectedAdapter = client === "vscode" ? view.clientRoutes?.vsCodeChat.adapter ?? "responses" : selected[client];
    const options = choices.map(id => `<option value="${id}"${selectedAdapter === id ? " selected" : ""}>${id === "responses" ? "Responses" : id === "chat" ? "Chat" : "Messages"}</option>`).join("");
    const route = clientRoute(view, client);
    const mode = client === "vscode" ? route?.mode ?? "native" : view.clientModes?.[client] ?? view.mode;
    const { health, className, status } = clientLight(view, client);
    const routeHealthy = health === "green" || health === "yellow";
    const available = view.connected && (view.allowedModels?.length ?? (view.modelId ? 1 : 0)) > 0;
    const adapterDisabled = view.commandRunning || !routeHealthy;
    return `<div class="model-client"><div class="client-head"><span class="adapter-label"><span class="${className}" tabindex="0" title="${status}" aria-label="${status}" data-client-light="${client}"></span>${clientIcons[client]}<span>${clientLabel(client)}</span></span><form class="modes client-modes" method="post" action="/switch"><input type="hidden" name="client" value="${client}"><button type="submit" name="mode" value="native" aria-pressed="${mode === "native"}" class="${mode === "native" ? "on" : ""}"${locked(view)}>個人</button><button type="submit" name="mode" value="classroom" aria-pressed="${mode === "classroom"}" class="${mode === "classroom" ? "on" : ""}"${!available || !routeHealthy || view.commandRunning ? " disabled" : ""}>課堂</button></form></div><form class="adapter-row" method="post" action="/adapter"><input type="hidden" name="client" value="${client}"><span class="adapter-select"><select name="adapter" aria-label="${clientLabel(client)} API 協定"${adapterDisabled ? " disabled" : ""}>${options}</select><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m7 10 5 5 5-5"/></svg></span></form><span class="client-flow" data-client-flow="${client}" aria-hidden="true"></span></div>`;
  }).join("");
  return forms +
    (view.adapterNotice ? `<p class="hint">${escapeHtml(view.adapterNotice)}</p>` : "");
}

function environmentInner(view: ClassroomAppView): string {
  const off = locked(view);
  const confirmOff = view.installAvailable && !view.commandRunning ? "" : " disabled";
  const tools = view.tools
    .map((tool) => {
      const checked = tool.selected ? " checked" : "";
      const mark = tool.installed ? "已安裝" : "未安裝";
      return `<label class="tool"><input type="checkbox" name="tool" value="${escapeHtml(tool.id)}"${checked}${off}> ${environmentIcons[tool.id]}<span>${escapeHtml(tool.label)}</span> <em>${mark}</em></label>`;
    })
    .join("");
  const note = view.environmentNotice
    ? `<p class="hint">${escapeHtml(view.environmentNotice)}</p>`
    : "";
  return `<form method="post" action="/environment-check">
      <button type="submit" class="quiet"${off}>重新檢查</button>
    </form>
    <form class="stack" method="post" action="/environment">
      <div class="tools">${tools}</div>
      <button type="submit" class="go"${confirmOff}${view.commandRunning ? " hidden" : ""}>確認安裝</button>
    </form>
    ${note}${abortInstallForm(view)}`;
}

/** Abort Install 入口；僅在安裝執行中顯示，送出前由 installProgressScript 確認。 */
function abortInstallForm(view: ClassroomAppView): string {
  return `<form method="post" action="/abort-install" data-abort-install${view.commandRunning ? "" : " hidden"}><button type="submit" class="quiet">停止安裝</button></form>`;
}

function catalogInner(view: ClassroomAppView): string {
  if (!view.catalog && !view.catalogError) {
    return `<p class="empty">這台電腦還沒有課程清單。</p>`;
  }
  const error = view.catalogError
    ? `<p class="error">${escapeHtml(view.catalogError)}</p>`
    : "";
  const note = view.catalog?.localNote
    ? `<p class="hint">${escapeHtml(view.catalog.localNote)}</p>`
    : "";
  return `${note}${error}`;
}

function commandInner(view: ClassroomAppView): string {
  const hasOutput = view.commandOutput !== undefined;
  if (!view.pendingCommand && !hasOutput) {
    return `<p class="empty">沒有待確認的指令。</p>`;
  }
  const command = view.pendingCommand
    ? `<pre class="pending">${escapeHtml(view.pendingCommand)}</pre>`
    : "";
  // 執行中保留「確認執行」的空間，讓「停止安裝」落在「取消」的位置，避免連點誤觸。
  const running = view.commandRunning;
  const choices = view.pendingCommand
    ? `<div class="choices">
          <form method="post" action="/confirm"${running ? " data-reserved" : ""}><button type="submit" class="go"${running ? " disabled" : ""}>確認執行</button></form>
          <form method="post" action="/cancel"${running ? " hidden" : ""}><button type="submit" class="quiet">取消</button></form>
          ${abortInstallForm(view)}
        </div>`
    : "";
  const output = hasOutput
    ? `<h3>指令輸出</h3><pre>${escapeHtml(view.commandOutput ?? "")}</pre>`
    : "";
  return `${command}${choices}${output}`;
}

function snippetInner(snippet: LessonSnippet): string {
  const hint = snippet.pasteHint
    ? `<p class="hint">${escapeHtml(snippet.pasteHint)}</p>`
    : "";
  return `<h3>${escapeHtml(snippet.title)}</h3>
    ${hint}
    <pre>${escapeHtml(snippet.body)}</pre>`;
}

function catalogTable(view: ClassroomAppView): string {
  const head = catalogInner(view);
  const rows = (view.catalog?.actions ?? [])
    .map((action: InstallAction) => {
      const off = view.commandRunning ? " disabled" : "";
      const description = action.description
        ? `<p class="hint">${escapeHtml(action.description)}</p>`
        : "";
      return `<tr>
        <td>${escapeHtml(actionKindLabel(action.kind))}</td>
        <td><strong>${escapeHtml(action.title)}</strong>${description}<code>${escapeHtml(action.command)}</code></td>
        <td><form method="post" action="/prepare">
          <input type="hidden" name="action_id" value="${escapeHtml(action.id)}">
          <button type="submit"${off}>查看完整指令</button>
        </form></td>
      </tr>`;
    })
    .join("");
  const table = rows
    ? `<table><thead><tr><th>種類</th><th>項目</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
    : "";
  const snippets = (view.catalog?.snippets ?? [])
    .map((snippet) => `<article class="line">${snippetInner(snippet)}</article>`)
    .join("");
  const snippetBlock = snippets ? `<h3>本課片段</h3>${snippets}` : "";
  return `${head}${table}${snippetBlock}`;
}

function stopForm(): string {
  return `<form method="post" action="/stop"><button type="submit" class="stop">停止</button></form>`;
}

function tile(title: string, body: string, wide = false): string {
  return `<section class="tile${wide ? " wide" : ""}"><h2>${title}</h2>${body}</section>`;
}

const CSS = `
  :root {
    color-scheme: light;
    --bg: #f2f2f7;
    --tile: #fff;
    --text: #1d1d1f;
    --muted: #6e6e73;
    --accent: #009999;
    --on-accent: #fff;
    --quiet: #009999;
    --stop: #ff3b30;
    --input: #f2f2f7;
    --modes: rgba(120, 120, 128, 0.16);
    --modes-on: #fff;
    --modes-on-text: #1d1d1f;
    --bar: rgba(242, 242, 247, 0.72);
    --line: rgba(60, 60, 67, 0.12);
    --title-a: #007070;
    --title-b: #009999;
    --title-c: #f8c000;
  }
  [data-appearance="light"] {
    color-scheme: light;
    --bg: #f2f2f7;
    --tile: #fff;
    --text: #1d1d1f;
    --muted: #6e6e73;
    --accent: #009999;
    --on-accent: #fff;
    --quiet: #009999;
    --stop: #ff3b30;
    --input: #f2f2f7;
    --modes: rgba(120, 120, 128, 0.16);
    --modes-on: #fff;
    --modes-on-text: #1d1d1f;
    --bar: rgba(242, 242, 247, 0.72);
    --line: rgba(60, 60, 67, 0.12);
    --title-a: #007070;
    --title-b: #009999;
    --title-c: #f8c000;
  }
  [data-appearance="dark"] {
    color-scheme: dark;
    --bg: #0c0c0e;
    --tile: #1c1c1e;
    --text: #f5f5f7;
    --muted: #98989d;
    --accent: #f8c000;
    --on-accent: #1c1c1e;
    --quiet: #f8c000;
    --stop: #ff453a;
    --input: #2c2c2e;
    --modes: #2c2c2e;
    --modes-on: #3a3a3c;
    --modes-on-text: #f8c000;
    --bar: rgba(28, 28, 30, 0.72);
    --line: rgba(255, 255, 255, 0.08);
    --title-a: #9cf6ee;
    --title-b: #2ec4b6;
    --title-c: #f8c000;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-appearance="light"]) {
      color-scheme: dark;
      --bg: #0c0c0e;
      --tile: #1c1c1e;
      --text: #f5f5f7;
      --muted: #98989d;
      --accent: #f8c000;
      --on-accent: #1c1c1e;
      --quiet: #f8c000;
      --stop: #ff453a;
      --input: #2c2c2e;
      --modes: #2c2c2e;
      --modes-on: #3a3a3c;
      --modes-on-text: #f8c000;
      --bar: rgba(28, 28, 30, 0.72);
      --line: rgba(255, 255, 255, 0.08);
      --title-a: #9cf6ee;
      --title-b: #2ec4b6;
      --title-c: #f8c000;
    }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; min-height: 100%; }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: system-ui, "Segoe UI", "Microsoft JhengHei", sans-serif;
    line-height: 1.45;
  }
  button, input { font: inherit; color: inherit; }
  button { cursor: pointer; }
  button:disabled { opacity: 0.45; cursor: not-allowed; }
  button:active { transform: scale(0.97); transition: transform 100ms ease-out; }
  pre, code { white-space: pre-wrap; overflow-wrap: anywhere; }
  h1, h2, h3, p { margin: 0; }
  .bar {
    position: sticky;
    top: 0;
    z-index: 2;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.75rem 1.1rem;
    background: var(--bar);
    backdrop-filter: blur(24px) saturate(160%);
    -webkit-backdrop-filter: blur(24px) saturate(160%);
    border-bottom: 1px solid var(--line);
  }
  .brand { display: flex; align-items: center; gap: 0.7rem; min-width: 0; }
  .logo-badge {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 2.75rem;
    height: 2.75rem;
    padding: 3px;
    border-radius: 8px;
    background: #eef5f5;
    box-shadow: 0 0 0 1px rgba(0, 112, 112, 0.18);
    overflow: hidden;
    flex-shrink: 0;
  }
  .logo-badge img { display: block; width: 100%; height: 100%; object-fit: contain; }
  .gradient-text {
    font-size: 1.35rem;
    font-weight: 700;
    letter-spacing: -0.02em;
    line-height: 1.15;
    background: linear-gradient(135deg, var(--title-a) 0%, var(--title-b) 46%, var(--title-c) 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  [data-appearance-toggle] {
    width: 2.75rem;
    height: 2.75rem;
    flex: 0 0 auto;
    display: grid;
    place-items: center;
    padding: 0;
    border: 0;
    border-radius: 999px;
    background: var(--tile);
    color: var(--text);
  }
  [data-appearance-toggle] svg { width: 1.25rem; height: 1.25rem; }
  main { width: min(52rem, 100%); margin: 0 auto; padding: 0.4rem 1.1rem 2rem; }
  .display {
    font-size: clamp(2.4rem, 6vw, 3.4rem);
    font-weight: 700;
    line-height: 1.02;
    letter-spacing: -0.03em;
    margin: 1rem 0 0.35rem;
  }
  .detail, .notice, .class-label { color: var(--text); }
  .hint, .empty, .kind, .mode-line { color: var(--muted); }
  .error, .restart { color: var(--stop); }
  .running { color: var(--accent); font-weight: 700; }
  .modules {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.75rem;
    margin-top: 1.2rem;
  }
  .tile {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.65rem;
    padding: 0.95rem 1rem 1rem;
    border-radius: 16px;
    background: var(--tile);
  }
  .tile.wide { grid-column: 1 / -1; }
  h2 {
    font-size: 0.78rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    line-height: 1.3;
    color: var(--muted);
  }
  form.stack, .tools { display: flex; flex-direction: column; gap: 0.65rem; align-items: stretch; width: 100%; }
  label { display: flex; flex-direction: column; gap: 0.3rem; }
  .tool { flex-direction: row; align-items: center; gap: 0.55rem; width: 100%; }
  .tool span { min-width: 0; }
  .tool svg { width: 20px; height: 20px; flex-shrink: 0; color: var(--text); }
  .tool em { margin-left: auto; font-style: normal; color: var(--muted); font-size: 0.85rem; white-space: nowrap; }
  .tool input[type="checkbox"] {
    width: 1.15rem;
    min-width: 1.15rem;
    height: 1.15rem;
    min-height: 1.15rem;
    flex: 0 0 auto;
    margin: 0;
  }
  input:not([type="checkbox"]) {
    width: 100%;
    min-height: 2.75rem;
    border: 0;
    border-radius: 10px;
    background: var(--input);
    color: var(--text);
    padding: 0 0.8rem;
  }
  button {
    min-height: 2.75rem;
    border: 0;
    border-radius: 10px;
    background: var(--accent);
    color: var(--on-accent);
    font-weight: 700;
    padding: 0 1rem;
    align-self: flex-start;
  }
  button.quiet { background: transparent; color: var(--quiet); padding: 0; }
  button.stop { background: transparent; color: var(--stop); }
  .modes {
    display: flex;
    gap: 2px;
    padding: 2px;
    border-radius: 9px;
    background: var(--modes);
  }
  .modes button { flex: 1; background: transparent; color: var(--text); }
  .modes button.on { background: var(--modes-on); color: var(--modes-on-text); }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; vertical-align: top; padding: 0.5rem 0.4rem 0.5rem 0; }
  th { font-size: 0.75rem; font-weight: 600; color: var(--muted); }
  code, pre { color: var(--text); font-family: Consolas, "Cascadia Mono", monospace; font-size: 0.86rem; }
  .line { display: flex; flex-direction: column; gap: 0.35rem; padding-top: 0.65rem; }
  .choices { display: flex; gap: 0.75rem; align-items: center; }
  :focus-visible { outline: 3px solid var(--accent); outline-offset: 3px; }
  @media (max-width: 40rem) {
    .modules { grid-template-columns: 1fr; }
    .tile.wide { grid-column: auto; }
  }
  @media (prefers-reduced-motion: reduce) {
    button:active { transform: none; transition: none; }
  }
  @media (prefers-reduced-transparency: reduce) {
    .bar { background: var(--bg); backdrop-filter: none; -webkit-backdrop-filter: none; }
  }
`;

function appearanceScript(): string {
  return `
    ${resolveAppearance.toString()}
    var appearanceKey = "classroom-appearance";
    var moon = ${JSON.stringify(MOON)};
    var sun = ${JSON.stringify(SUN)};
    function readAppearance() {
      try { return localStorage.getItem(appearanceKey); } catch (error) { return null; }
    }
    function systemDark() {
      return window.matchMedia("(prefers-color-scheme: dark)").matches;
    }
    function paintAppearance() {
      var appearance = resolveAppearance(readAppearance(), systemDark());
      document.documentElement.dataset.appearance = appearance;
      var button = document.querySelector("[data-appearance-toggle]");
      if (!button) return;
      var next = appearance === "dark" ? "light" : "dark";
      button.setAttribute("aria-label", next === "dark" ? "切換到深色" : "切換到淺色");
      button.innerHTML = next === "dark" ? moon : sun;
    }
    paintAppearance();
    document.addEventListener("DOMContentLoaded", paintAppearance);
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function () {
      var stored = readAppearance();
      if (stored === "light" || stored === "dark") return;
      paintAppearance();
    });
    document.addEventListener("click", function (event) {
      var target = event.target;
      if (!target || !target.closest) return;
      var button = target.closest("[data-appearance-toggle]");
      if (!button) return;
      var current = document.documentElement.dataset.appearance === "dark" ? "dark" : "light";
      var next = current === "dark" ? "light" : "dark";
      try { localStorage.setItem(appearanceKey, next); } catch (error) {}
      paintAppearance();
    });
    window.addEventListener("pagehide", function () {
      navigator.sendBeacon("/close");
    });
  `;
}

export function classroomBlocks(view: ClassroomAppView) {
  return {
    status: statusWord(view),
    notices: notices(view),
    connect: connectInner(view),
    folder: folderInner(view),
    model: modelInner(view),
    environment: environmentInner(view),
    command: commandInner(view),
    catalog: catalogTable(view),
    stop: stopForm(),
  };
}

function basePage(view: ClassroomAppView): string {
  return `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${PRODUCT}</title>
  <link rel="icon" href="/favicon.ico" sizes="any">
  <style>${CSS}</style>
  <script>${appearanceScript()}</script>
</head>
<body>
  <header class="bar">
    <div class="brand">
      <div class="logo-badge"><img src="/brand-logo.png" alt=""></div>
      <h1 class="gradient-text">${PRODUCT}</h1>
    </div>
    <button type="button" data-appearance-toggle aria-label="切換外觀"></button>
  </header>
  <main>
    <p class="display">${escapeHtml(statusWord(view))}</p>
    ${notices(view)}
    <div class="modules">
      ${tile("連線", connectInner(view))}
      ${tile("資料夾", folderInner(view))}
      ${tile("模型", modelInner(view))}
      ${tile("環境", environmentInner(view))}
      ${tile("指令", commandInner(view), true)}
      ${tile("課程", catalogTable(view), true)}
      ${tile("離開", stopForm(), true)}
    </div>
  </main>
</body>
</html>`;
}

function installActionCards(view: ClassroomAppView): string {
  const off = view.commandRunning || !view.projectFolder ? " disabled" : "";
  return (view.catalog?.actions ?? [])
    .map((action) => {
      const description = action.description
        ? `<p class="hint">${escapeHtml(action.description)}</p>`
        : "";
      const installed = view.installedActionIds?.includes(action.id)
        ? `<span class="badge installed-tag">已安裝</span>`
        : "";
      return `<article class="install-card"><div class="install-top"><span data-kind="${escapeHtml(action.kind)}" class="kind-tag">${escapeHtml(actionKindLabel(action.kind))}</span><strong>${escapeHtml(action.title)}</strong>${installed}</div>${description}<form method="post" action="/prepare"><input type="hidden" name="action_id" value="${escapeHtml(action.id)}"><button type="submit"${off}>安裝</button></form></article>`;
    })
    .join("");
}

function presentCommand(body: string, view: ClassroomAppView): { inline: string; dialog: string } {
  let inline = body;
  const pending = inline.match(/<pre class="pending">[\s\S]*?<\/pre>/);
  const choices = inline.match(/<div class="choices">[\s\S]*?<\/div>/);
  let dialog = "";
  if (pending) {
    dialog = `<div class="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-title"><div class="confirm-panel"><h2 id="confirm-title">確認安裝</h2>${pending[0]}<p data-install-status role="status" aria-live="polite"></p><pre data-install-output aria-label="安裝輸出" hidden></pre>${choices?.[0] ?? ""}<button type="button" data-install-dismiss hidden>確認</button></div></div>`;
    inline = inline.replace(pending[0], "");
    if (choices) inline = inline.replace(choices[0], "");
  }
  inline = inline.replace(
    /<h3>指令輸出<\/h3>(<pre>[\s\S]*?<\/pre>)/,
    "",
  );
  return { inline, dialog };
}

function projectFolderRow(view: ClassroomAppView): string {
  return `<div class="project-folder-row"><div class="project-folder-info"><span class="hint">專案資料夾</span><p class="folder-path"${view.projectFolder ? ` title="${escapeHtml(view.projectFolder)}"` : ""}>${escapeHtml(view.projectFolder || "尚未選擇安裝位置")}</p></div><form method="post" action="/pick-folder"><button type="submit" class="quiet"${locked(view)}>${view.projectFolder ? "變更" : "選擇專案資料夾"}</button></form>${view.folderError ? `<p class="error" role="alert">${escapeHtml(view.folderError)}</p>` : ""}${view.installNotice ? `<p class="hint" role="status">${escapeHtml(view.installNotice)}</p>` : ""}</div>`;
}

function splitCourseCards(html: string, view: ClassroomAppView): string {
  const commandMatch = html.match(
    /<section class="tile wide"><h2>指令<\/h2>([\s\S]*?)<\/section>/,
  );
  const courseMatch = html.match(
    /<section class="tile wide"><h2>課程<\/h2>([\s\S]*?)<\/section>/,
  );
  if (!commandMatch || !courseMatch) return html;
  const commandBody = commandMatch[1].includes("沒有待確認的指令。")
    ? ""
    : commandMatch[1];
  const presented = presentCommand(commandBody, view);
  const snippetHeading = "<h3>本課片段</h3>";
  const snippetAt = courseMatch[1].indexOf(snippetHeading);
  const courseBody =
    snippetAt === -1 ? courseMatch[1] : courseMatch[1].slice(0, snippetAt);
  const copied = new Set(view.copiedSnippetIds ?? []);
  const snippetBody = (view.catalog?.snippets ?? []).map((snippet, index) => {
    const number = index + 1;
    const title = escapeHtml(snippet.title);
    const done = copied.has(snippet.id);
    const hint = snippet.pasteHint
      ? `<span class="snippet-hint">${escapeHtml(snippet.pasteHint)}</span>`
      : "";
    return `<article class="snippet-card${done ? " copied" : ""}"><span class="snippet-number" aria-hidden="true">${number}</span><div class="snippet-main"><div class="snippet-line"><strong><span class="visually-hidden">片段 ${number}：</span>${title}</strong>${hint}</div><details class="snippet-peek"><summary>查看內容</summary><pre class="snippet-code">${escapeHtml(snippet.body)}</pre></details></div><button type="button"${done ? ' class="quiet"' : ""} data-copy-snippet="${escapeHtml(snippet.id)}" aria-label="${done ? "再複製一次" : "複製"}「${title}」">${COPY_ICON}<span>${done ? "✓ 已複製" : "複製"}</span></button><span class="visually-hidden" data-snippet-copy-status role="status" aria-live="polite"></span></article>`;
  }).join("") || `<p class="empty">這堂課沒有片段。</p>`;
  const chevron = `<svg class="course-chevron" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 6 6 6-6 6"/></svg>`;
  const install = `<section class="tile wide"><details class="course-section" data-course-section="install" open><summary class="tile-head"><h2>課程安裝</h2>${chevron}</summary><div class="course-content">${courseBody}${presented.inline}</div></details></section>${presented.dialog}`;
  const snippets = `<section class="tile wide"><details class="course-section" data-course-section="snippets" open><summary class="tile-head"><h2>課程片段</h2>${chevron}</summary><div class="course-content">${snippetBody}</div></details></section>`;
  return html.replace(commandMatch[0], install).replace(courseMatch[0], snippets);
}

function drawerScript(): string {
  return `
    document.addEventListener("click", function (event) {
      var target = event.target;
      if (!target || !target.closest) return;
      var bar = document.getElementById("side-menu");
      var scrim = document.querySelector(".drawer-scrim");
      var toggle = document.querySelector(".menu-toggle");
      if (!bar || !scrim || !toggle) return;
      function setOpen(open) {
        bar.classList.toggle("open", open);
        scrim.classList.toggle("show", open);
        toggle.setAttribute("aria-expanded", open ? "true" : "false");
        toggle.setAttribute("aria-label", open ? "關閉選單" : "開啟選單");
      }
      if (target.closest(".menu-toggle")) setOpen(!bar.classList.contains("open"));
      if (target.closest(".drawer-scrim") || target.closest(".side-item")) setOpen(false);
    });
  `;
}

function snippetCopyScript(): string {
  return `
    document.addEventListener("click", async function (event) {
      var target = event.target;
      var button = target && target.closest ? target.closest("[data-copy-snippet]") : null;
      if (!button || button.disabled) return;
      var card = button.closest(".snippet-card");
      var status = card.querySelector("[data-snippet-copy-status]");
      var label = button.querySelector("span");
      var title = button.getAttribute("aria-label").replace(/^(再複製一次|複製)/, "");
      button.disabled = true;
      status.textContent = "";
      try {
        var response = await fetch("/copy-snippet", {
          method: "POST",
          body: new URLSearchParams({ snippet_id: button.getAttribute("data-copy-snippet") }),
        });
        if (!response.ok || !(await response.json()).ok) throw new Error("copy failed");
        card.classList.add("copied");
        button.classList.add("quiet");
        button.setAttribute("aria-label", "再複製一次" + title);
        label.textContent = "已複製！";
        status.textContent = "已複製" + title + "。";
      } catch (error) {
        label.textContent = "複製失敗";
        status.textContent = "複製失敗，請再試一次。";
      } finally {
        button.disabled = false;
        clearTimeout(button.snippetCopyTimer);
        button.snippetCopyTimer = setTimeout(function () {
          label.textContent = card.classList.contains("copied") ? "✓ 已複製" : "複製";
        }, 1500);
      }
    });
  `;
}

function courseSectionScript(): string {
  return `
    function initializeCourseSections() {
    document.querySelectorAll("[data-course-section]").forEach(function (section) {
      var key = "vpod.course." + section.getAttribute("data-course-section") + ".collapsed";
      try { section.open = sessionStorage.getItem(key) !== "true"; } catch (error) {}
      section.addEventListener("toggle", function () {
        try { sessionStorage.setItem(key, String(!section.open)); } catch (error) {}
      });
    });
    }
    initializeCourseSections();
  `;
}

function organizeSettings(html: string, view: ClassroomAppView): string {
  const cards: string[] = [];
  const updated = html.replace(/<section class="tile"><div class="tile-head"><h2>(連線|模型|環境)<\/h2>([\s\S]*?)<\/section>/g,
    (_card, title: string, rest: string) => {
      const headEnd = rest.indexOf("</div>") + 6;
      const head = `<div class="tile-head"><h2>${title}</h2>${rest.slice(0, headEnd)}`;
      let body = rest.slice(headEnd);
      let actions = "";
      let reminder = "";
      const moveForm = (action: string) => {
        body = body.replace(new RegExp(`<form[^>]*action="/${action}">[\\s\\S]*?</form>`), (form) => {
          actions += form;
          return "";
        });
      };
      if (title === "連線") {
        moveForm("clear");
        if (actions && !view.connectionError && view.connectionNotice === COPY_KEY_NOTICE) {
          const feedback = connectionFeedback(view);
          body = body.replace(feedback, "");
          const speech = `<div class="mascot-speech">${feedback}<button type="button" class="mascot-speech-close" aria-label="收起法鬥台詞">知道啦</button></div>`;
          body = body.replace('class="connection-mascot"', 'class="connection-mascot mascot-waiting mascot-speaking"')
            .replace('<div class="mascot-traveler">', `${speech}<div class="mascot-traveler">`);
        }
        if (!actions) {
          body = body.replace('action="/redeem"', 'action="/redeem" id="settings-redeem"');
          body = body.replace(/<button[\s\S]*?<\/button>/, (button) => {
            actions = button.replace('<button ', '<button form="settings-redeem" ');
            return "";
          });
          const feedback = body.match(/<div class="connection-feedback">[\s\S]*?<\/div>(?=\s*<\/form>)/)?.[0] ?? '<div class="connection-feedback"></div>';
          body = body.replace(feedback, "");
          const quote = view.connectionError === "請先輸入邀請碼與課堂暱稱，再按「連線」。"
            ? "我披風都穿好了，你的邀請碼跟暱稱呢？"
            : "連線這關還沒過，披風倒是先上班了。照下面的提示再試一次！";
          const speech = `<div class="mascot-speech"><p class="mascot-quote">${escapeHtml(quote)}</p>${feedback}</div>`;
          body += connectionMascot.replace('class="connection-mascot"', 'class="connection-mascot mascot-waiting"').replace('<div class="mascot-traveler">', `${speech}<div class="mascot-traveler">`);
        }
      } else if (title === "模型") {
        body = body.replace(/<div class="model-update"[\s\S]*?<\/div><\/div>/, (block) => {
          reminder = block;
          return "";
        });
        moveForm("reload");
        if (view.connected && view.canCopyKey) { actions = ""; reminder = ""; }
      } else {
        moveForm("environment-check");
        body = body.replace('action="/environment"', 'action="/environment" id="settings-environment"');
        body = body.replace(/<button[\s\S]*?<\/button>/, (button) => {
          actions += button.replace('<button ', '<button form="settings-environment" ');
          return "";
        });
        body = body.replace(/<form[^>]*data-abort-install[\s\S]*?<\/form>/, (abort) => {
          actions += abort;
          return "";
        });
        const missing = view.tools.filter((tool) => !tool.installed).length;
        const summary = !view.tools.length ? "尚未檢查工具" : missing ? `尚缺 ${missing} 項工具` : "所有工具已安裝";
        body = body.replace(/<div class="tools">([\s\S]*?)<\/div>/,
          `<p class="environment-summary">${summary}</p><details class="environment-tools"><summary>查看與選擇工具</summary><div class="tools">$1</div></details>`);
      }
      cards.push(`<section class="tile settings-card${title === "環境" ? " environment-card" : ""}" data-setting="${title}">${head}<div class="settings-content">${body}</div>${reminder}<div class="settings-actions">${actions}</div></section>`);
      return "";
    });
  if (cards.length !== 3) return html;
  return updated.replace('<div class="modules">', `<div class="modules"><div class="settings-grid">${cards.slice(0, 2).join("")}</div>${projectFolderRow(view)}${cards[2]}`);
}

export function renderPage(view: ClassroomAppView): string {
  const tag = view.connected
    ? `<span class="badge">已連線</span>`
    : `<span class="badge off">未連線</span>`;
  let html = basePage(view).replace(
    `<section class="tile"><h2>連線</h2>`,
    `<section class="tile"><div class="tile-head"><h2>連線</h2>${tag}</div>`,
  );
  html = html.replace(
    `<header class="bar">`,
    `<div class="mobile-top"><button type="button" class="menu-toggle" aria-label="開啟選單" aria-expanded="false" aria-controls="side-menu"><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg></button><div class="brand"><div class="logo-badge"><img src="/brand-logo.png" alt=""></div><h1 class="gradient-text">VansPod</h1></div></div><button type="button" class="drawer-scrim" aria-label="關閉選單"></button><header class="bar" id="side-menu">`,
  );
  html = html.replace(
    `<button type="button" data-appearance-toggle aria-label="切換外觀"></button>`,
    `<nav aria-label="選單"><button type="button" class="side-item" aria-current="page"><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m9.5 3-.6 2.3-2 .9-2.1-.6-2.5 4.3 1.5 1.7v2.3l-1.5 1.7 2.5 4.3 2.1-.6 2 .9.6 2.3h5l.6-2.3 2-.9 2.1.6 2.5-4.3-1.5-1.7v-2.3l1.5-1.7-2.5-4.3-2.1.6-2-.9L14.5 3z"/><circle cx="12" cy="12" r="3"/></svg><span>教室設定</span></button></nav><button type="button" data-appearance-toggle aria-label="切換外觀"></button>`,
  );
  html = html.replace(
    /<section class="tile"><h2>資料夾<\/h2>[\s\S]*?<\/section>/,
    "",
  );
  const modelCount = view.allowedModels?.length ?? (view.modelId ? 1 : 0);
  const modelTag = modelCount
    ? `<span class="badge">課堂可用 ${modelCount} 個</span>`
    : `<span class="badge off">${view.connected ? "無課堂模型" : "未連線"}</span>`;
  html = html.replace(
    `<section class="tile"><h2>模型</h2>`,
    `<section class="tile"><div class="tile-head"><h2>模型</h2>${modelTag}</div>`,
  );
  html = html.replace(
    /<p class="mode-line">[\s\S]*?<\/p>/,
    "",
  );
  html = html.replaceAll(">Classroom</button>", ">課堂</button>");
  html = html.replaceAll(">Native</button>", ">個人</button>");
  const envReady = view.tools.length > 0 && view.tools.every((tool) => tool.installed);
  const envTag = envReady
    ? `<span class="badge">已就緒</span>`
    : `<span class="badge off">未完成</span>`;
  html = html.replace(
    `<section class="tile"><h2>環境</h2>`,
    `<section class="tile"><div class="tile-head"><h2>環境</h2>${envTag}</div>`,
  );
  html = html.replaceAll(`<em>未安裝</em>`, `<em class="missing">未安裝</em>`);
  if (!view.tools.some((tool) => tool.selected)) {
    html = html.replace(
      `<button type="submit" class="go">確認安裝</button>`,
      `<button type="submit" class="go" disabled>確認安裝</button>`,
    );
  }
  if (view.connected && view.canCopyKey) {
    const off = view.commandRunning ? " disabled" : "";
    const course = view.courseTitle
      ? `<p class="course-title">${escapeHtml(view.courseTitle)}</p>`
      : "";
    const meta = [view.sessionTitle, view.nickname]
      .filter((value): value is string => Boolean(value))
      .map((value) => `<span>${escapeHtml(value)}</span>`)
      .join('<span class="connection-separator" aria-hidden="true">·</span>');
    const identity = course || meta
      ? `<div class="connection-identity">${course}${meta ? `<p class="connection-meta">${meta}</p>` : ""}</div>`
      : "";
    const mascot = `<div class="classroom-update-home"><div class="classroom-update">${connectionMascot}${classroomUpdateControl(view, restartHtml(view))}</div></div>`;
    const block = `${identity}<div class="key-row"><p>API Key 已設定</p><form method="post" action="/copy"><button type="submit" class="connection-copy" aria-label="複製 Classroom API Key"${off}>${COPY_ICON}<span>複製</span></button></form></div>${mascot}<form method="post" action="/clear"><button type="submit" class="connection-clear"${off}>清除連線</button></form>`;
    html = html.replace(
      /<form method="post" action="\/copy">[\s\S]*?<\/form>\s*<form method="post" action="\/clear">[\s\S]*?<\/form>/,
      block,
    );
    html = html.replace(/<p class="class-label">[\s\S]*?<\/p>/, "");
    html = html.replace(
      `<p class="detail">Classroom API Key 已設定。</p>`,
      "",
    );
  }
  html = html.replaceAll(
    `<h1 class="gradient-text">${PRODUCT}</h1>`,
    `<h1 class="brand-title">VansPod</h1><span class="ver">${VERSION}</span>`,
  );
  html = html.replace(
    `<div class="modules">`,
    `<header class="page-head"><h2>教室設定</h2><p>連線、模型與開發環境。</p></header><div class="modules">`,
  );
  if (view.catalog?.actions.length) {
    html = html.replace(/<table>[\s\S]*?<\/table>/, installActionCards(view));
  }
  html = organizeSettings(html, view);
  html = splitCourseCards(html, view);
  const extra = `<style>
    .tile { border: 1px solid light-dark(#e6e6e6, #3d3d3d); }
    .display { display: none; }
    body { display: grid; grid-template-columns: 232px minmax(0, 1fr); min-height: 100dvh; }
    .bar { position: sticky; top: 0; align-self: start; height: 100dvh; display: flex; flex-direction: column; align-items: stretch; justify-content: flex-start; gap: 4px; padding: 18px 14px; border-bottom: 0; border-right: 1px solid var(--line); }
    .bar .brand { padding: 6px 8px 14px; }
    .bar .logo-badge { width: 28px; height: 28px; }
    .bar .brand-title, .mobile-top .brand-title { margin: 0; font-size: 16px; font-weight: 600; letter-spacing: 0; line-height: 26px; color: light-dark(#0d0d0d, #ececec); background: none; -webkit-text-fill-color: currentColor; white-space: nowrap; }
    .brand .ver { align-self: center; flex: 0 0 auto; font-family: Consolas, "Cascadia Mono", monospace; font-size: 10px; line-height: 1.2; color: var(--muted); background: light-dark(#f4f4f4, #303030); border: 1px solid light-dark(#e6e6e6, #3d3d3d); padding: 2px 6px; border-radius: 999px; white-space: nowrap; }
    .bar nav { display: flex; flex-direction: column; }
    .side-item { display: flex; align-items: center; gap: 8px; align-self: stretch; justify-content: flex-start; min-height: 36px; padding: 8px 10px; border-radius: 8px; background: light-dark(rgba(13, 13, 13, 0.06), rgba(255, 255, 255, 0.09)); color: var(--text); font-size: 13px; font-weight: 600; text-align: left; }
    .side-item svg { width: 18px; height: 18px; flex-shrink: 0; }
    .bar [data-appearance-toggle] { margin-top: auto; align-self: flex-start; }
    .mobile-top, .drawer-scrim, .menu-toggle { display: none; }
    main { justify-self: center; width: min(52rem, 100%); }
    @media (max-width: 760px) {
      body { display: block; }
      .mobile-top { display: flex; position: sticky; top: 0; z-index: 20; align-items: center; gap: 4px; padding: 4px 10px; border-bottom: 1px solid var(--line); background: var(--bar); backdrop-filter: blur(24px) saturate(160%); }
      .mobile-top .brand { flex: 1; min-width: 0; padding: 4px; }
      .mobile-top .logo-badge { width: 32px; height: 32px; }
      .mobile-top .brand-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
      .menu-toggle { display: grid; place-items: center; width: 44px; height: 44px; min-height: 44px; padding: 0; border: 0; border-radius: 8px; background: transparent; color: var(--text); }
      .menu-toggle svg { width: 20px; height: 20px; }
      .bar { position: fixed; top: 0; left: 0; bottom: 0; z-index: 40; width: min(280px, 84vw); height: 100dvh; transform: translateX(-100%); visibility: hidden; border-right: 1px solid var(--line); background: light-dark(rgba(242, 242, 247, 0.97), rgba(12, 12, 14, 0.96)); }
      .bar.open { transform: translateX(0); visibility: visible; }
      .bar .brand { display: none; }
      .drawer-scrim.show { display: block; position: fixed; inset: 0; z-index: 30; border: 0; padding: 0; background: light-dark(rgba(20, 20, 20, 0.32), rgba(0, 0, 0, 0.52)); }
      main { width: min(52rem, 100%); margin: 0 auto; }
    }
    .tile-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .course-section > summary { cursor: pointer; list-style: none; border-radius: 6px; }
    .course-section > summary::-webkit-details-marker { display: none; }
    .course-section > summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; }
    .course-chevron { width: 20px; height: 20px; flex-shrink: 0; color: var(--muted); }
    .course-section[open] > summary .course-chevron { transform: rotate(90deg); }
    .course-content { display: flex; flex-direction: column; gap: 12px; margin-top: 12px; }
    .project-folder-row { grid-column: 1 / -1; display: flex; align-items: center; flex-wrap: wrap; gap: 10px; padding: 12px 18px; border: 1px solid var(--line); border-radius: 10px; background: var(--input); font-size: 13px; }
    .project-folder-info { flex: 1 1 200px; min-width: 0; }
    .project-folder-info .hint { font-size: 12px; }
    .folder-path { margin-top: 4px; overflow-wrap: anywhere; }
    .project-folder-row > .error, .project-folder-row > .hint { flex-basis: 100%; }
    .badge { display: inline-flex; align-items: center; min-height: 22px; padding: 0 8px; border-radius: 999px; background: light-dark(rgba(16, 163, 127, 0.10), rgba(78, 203, 157, 0.13)); color: light-dark(#0a7d5c, #4ecb9d); font-size: 12px; font-weight: 600; }
    .badge.off { background: light-dark(#f4f4f4, #303030); color: light-dark(#6e6e6e, #a6a6a6); }
    .connection-identity { display: flex; flex-direction: column; gap: 6px; margin-bottom: 10px; }
    .course-title { font-size: 1.15rem; line-height: 1.5; font-weight: 600; overflow-wrap: anywhere; }
    .connection-meta { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 8px; color: var(--muted); font-size: 13px; line-height: 1.6; }
    .connection-meta > span { min-width: 0; overflow-wrap: anywhere; }
    .connection-separator { opacity: 0.5; }
    .tool em { color: var(--text); }
    .tool em.missing { color: var(--muted); }
    .install-card { display: flex; flex-direction: column; align-items: flex-start; gap: 12px; width: 100%; padding: 14px; border: 1px solid light-dark(#dfe3e8, #404044); border-radius: 12px; background: light-dark(#f8fafc, #252528); }
    .install-top { display: flex; align-items: center; gap: 8px; width: 100%; padding-bottom: 10px; border-bottom: 1px solid var(--line); }
    .install-top strong { min-width: 0; overflow-wrap: anywhere; }
    .installed-tag { margin-left: auto; flex-shrink: 0; background: light-dark(#d1fae5, #163c30); color: light-dark(#065f46, #6ee7b7); }
    .kind-tag { display: inline-flex; align-items: center; min-height: 22px; padding: 0 8px; border-radius: 999px; background: light-dark(rgba(13, 13, 13, 0.06), rgba(255, 255, 255, 0.09)); color: var(--muted); font-size: 12px; font-weight: 600; }
    .kind-tag[data-kind="package"] { background: light-dark(#dbeafe, #172f50); color: light-dark(#1e40af, #93c5fd); }
    .kind-tag[data-kind="skill"] { background: light-dark(#ede9fe, #35254e); color: light-dark(#6d28d9, #c4b5fd); }
    .kind-tag[data-kind="mcp"] { background: light-dark(#d1fae5, #163c30); color: light-dark(#065f46, #6ee7b7); }
    .snippet-card { display: flex; align-items: flex-start; gap: 12px; width: 100%; padding: 12px; border: 1px solid light-dark(#dfe3e8, #404044); border-radius: 12px; background: light-dark(#f8fafc, #252528); }
    .snippet-card.copied { border-color: light-dark(#6ee7b7, #1f5a45); }
    .snippet-number { flex-shrink: 0; display: grid; place-items: center; width: 32px; height: 32px; border-radius: 8px; background: light-dark(#0d0d0d, #ececec); color: light-dark(#ffffff, #0d0d0d); font: 700 16px Consolas, "Cascadia Mono", monospace; }
    .snippet-card.copied .snippet-number { background: light-dark(#047857, #6ee7b7); }
    .snippet-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
    .snippet-line { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 8px; min-height: 32px; }
    .snippet-line strong { min-width: 0; overflow-wrap: anywhere; }
    .snippet-hint { display: inline-flex; align-items: center; min-height: 22px; max-width: 100%; padding: 0 8px; border-radius: 999px; background: light-dark(rgba(13, 13, 13, 0.06), rgba(255, 255, 255, 0.09)); color: var(--muted); font-size: 12px; font-weight: 600; overflow-wrap: anywhere; }
    .snippet-peek summary { width: fit-content; margin-top: 4px; color: var(--muted); font-size: 12px; cursor: pointer; }
    .snippet-code { width: 100%; max-height: 12rem; margin-top: 6px; overflow: auto; padding: 12px; border: 1px solid var(--line); border-radius: 10px; background: var(--input); line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; }
    main .snippet-card > button { flex-shrink: 0; display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
    .snippet-card > button svg { width: 14px; height: 14px; }
    .snippet-card.copied > button svg { display: none; }
    .visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
    .confirm-dialog { position: fixed; inset: 0; z-index: 90; display: grid; place-items: center; padding: 24px; background: light-dark(rgba(20, 20, 20, 0.32), rgba(0, 0, 0, 0.52)); }
    .confirm-panel { width: min(36rem, 100%); max-height: min(70dvh, 32rem); overflow: hidden; display: flex; flex-direction: column; gap: 12px; padding: 16px; border-radius: 16px; background: var(--tile); border: 1px solid var(--line); }
    .confirm-panel > :not(pre) { flex-shrink: 0; }
    .confirm-panel h2 { font-size: 20px; font-weight: 600; color: var(--text); }
    .confirm-panel pre { max-height: 40vh; overflow: auto; }
    .confirm-panel .pending { max-height: min(12dvh, 5rem); min-height: 0; flex-shrink: 1; }
    .confirm-panel [data-install-output] { height: min(32dvh, 16rem); max-height: min(32dvh, 16rem); min-height: 0; flex: 0 1 16rem; padding: 14px 16px; border-radius: 10px; border: 1px solid #30363d; background: #0d1117; color: #e6edf3; font-family: "Cascadia Code", "Cascadia Mono", Consolas, monospace; font-size: 13px; line-height: 1.65; white-space: pre-wrap; overflow-wrap: anywhere; color-scheme: dark; }
    .confirm-panel [hidden] { display: none; }
    .confirm-panel [data-reserved] { visibility: hidden; }
    .confirm-panel button { min-height: 34px; padding: 8px 16px; border-radius: 999px; border: 1px solid transparent; background: var(--accent); color: var(--on-accent); font-size: 13px; font-weight: 500; }
    .confirm-panel button.quiet { background: light-dark(#ffffff, #212121); color: light-dark(#0d0d0d, #ececec); border-color: light-dark(#e6e6e6, #3d3d3d); }
    .restart { color: light-dark(#9a4a08, #fbbf24); }
    [data-appearance="dark"] { --bg: #212121; }
    @media (prefers-color-scheme: dark) {
      :root:not([data-appearance="light"]) { --bg: #212121; }
    }
    .settings-grid { grid-column: 1 / -1; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    .settings-card { gap: 16px; padding: 18px; }
    .settings-card .tile-head { padding-bottom: 12px; border-bottom: 1px solid var(--line); }
    .settings-content { display: flex; flex-direction: column; gap: 10px; flex: 1; min-width: 0; container-type: inline-size; }
    .settings-content label { font-size: 13px; color: var(--muted); }
    .settings-content input { color: var(--text); }
    .model-client { display: grid; grid-template-columns: minmax(0, 1fr) auto 104px; align-items: center; gap: 6px; min-width: 0; }
    .model-client + .model-client { border-top: 1px solid var(--line); padding-top: 14px; margin-top: 4px; }
    .client-head { display: contents; }
    .adapter-row { min-width: 0; }
    .adapter-label { display: flex; align-items: center; gap: 8px; line-height: 1.4; font-size: 13px; color: var(--text); }
    .adapter-label svg { width: 20px; height: 20px; flex-shrink: 0; }
    .client-light { position: relative; display: inline-block; width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; background: light-dark(#b58a39, #c5a15b); box-shadow: 0 0 0 2px light-dark(rgba(181, 138, 57, 0.08), rgba(197, 161, 91, 0.09)); }
    .client-light:focus-visible::after { content: attr(title); position: absolute; top: 14px; left: -6px; z-index: 10; padding: 6px 8px; border-radius: 6px; border: 1px solid var(--line); background: var(--tile); color: var(--text); font-size: 11px; white-space: nowrap; }
    .client-light.detected { background: light-dark(#4b9274, #70b697); box-shadow: 0 0 0 2px light-dark(rgba(75, 146, 116, 0.08), rgba(112, 182, 151, 0.09)); }
    .client-light.health-yellow { background: #c9932b; }
    .client-light.health-red { background: #c95757; }
    .client-flow { grid-column: 1 / -1; position: relative; height: 2px; border-radius: 1px; overflow: hidden; background: light-dark(#ececec, #333333); transition: background-color 400ms ease-out; }
    .client-flow::after { content: ""; position: absolute; inset: 0 auto 0 0; width: 35%; background: linear-gradient(90deg, transparent, var(--accent), transparent); opacity: 0; transform: translateX(-100%); transition: opacity 400ms ease-out; animation: client-flow 1.6s cubic-bezier(0.45, 0, 0.55, 1) infinite; }
    .client-flow.flowing { background: color-mix(in srgb, var(--accent) 22%, light-dark(#ececec, #333333)); }
    .client-flow.flowing::after { opacity: 1; }
    /* The band is 35% of the line, so 286% of its own width carries it off the far end. */
    @keyframes client-flow { to { transform: translateX(286%); } }
    @media (prefers-reduced-motion: reduce) { .client-flow::after { animation: none; } }
    main .client-modes button { min-height: 30px; padding: 5px 10px; font-size: 12px; }
    @container (max-width: 330px) {
      .model-client { grid-template-columns: minmax(0, 1fr) auto; }
      .adapter-row { grid-column: 2; width: 104px; justify-self: end; }
    }
    .allowed-models { padding-top: 12px; border-top: 1px solid var(--line); font-size: 13px; }
    .allowed-models summary { cursor: pointer; color: var(--muted); }
    .allowed-models summary span { margin-left: 6px; }
    .allowed-model-list { list-style: none; display: flex; flex-direction: column; gap: 8px; margin: 12px 0 0; padding: 0; }
    .allowed-model-list li { padding: 8px 10px; border-radius: 8px; background: var(--input); overflow-wrap: anywhere; font-size: 12px; }
    .allowed-models > .hint { margin-top: 10px; }
    .adapter-select { display: block; position: relative; min-width: 0; }
    .adapter-select select { appearance: none; width: 100%; height: 34px; border: 1px solid var(--line); border-radius: 8px; background: var(--input); color: var(--text); font: inherit; font-size: 12px; padding: 5px 24px 5px 8px; cursor: pointer; }
    .adapter-select select:disabled { cursor: default; opacity: 0.5; }
    .adapter-select svg { position: absolute; right: 8px; top: 50%; transform: translateY(-50%); width: 12px; height: 12px; color: var(--muted); pointer-events: none; }
    .settings-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; min-height: 53px; padding-top: 12px; border-top: 1px solid var(--line); }
    .settings-actions .modes { width: auto; }
    .environment-card { grid-column: 1 / -1; }
    .environment-card .settings-actions { justify-content: flex-end; }
    .connection-error { display: flex; align-items: flex-start; gap: 8px; width: 100%; min-width: 0; padding: 10px 12px; border-radius: 10px; background: light-dark(#fef2f2, #40272b); color: light-dark(#b91c1c, #fca5a5); font-size: 13px; line-height: 1.6; }
    .connection-error svg { width: 16px; height: 16px; flex-shrink: 0; margin-top: 2px; }
    .connection-error p { min-width: 0; overflow-wrap: anywhere; }
    .connection-feedback:empty { display: none; }
    .connection-feedback { min-width: 0; width: 100%; }
    .connection-message { display: flex; align-items: flex-start; gap: 8px; width: 100%; min-width: 0; padding: 10px 12px; border-radius: 10px; background: light-dark(#fff7ed, #3b3024); color: light-dark(#9a3412, #fed7aa); font-size: 13px; line-height: 1.6; }
    .connection-message svg { width: 16px; height: 16px; flex-shrink: 0; margin-top: 2px; }
    .connection-message p { min-width: 0; overflow-wrap: anywhere; }
    .model-update { display: flex; align-items: flex-start; gap: 8px; padding: 10px 12px; border-radius: 10px; background: light-dark(#f1f5f9, #2d333b); color: var(--muted); font-size: 12px; line-height: 1.6; }
    .model-update svg { width: 16px; height: 16px; flex-shrink: 0; margin-top: 2px; }
    .environment-summary { font-weight: 600; }
    .environment-tools > summary { cursor: pointer; color: var(--muted); font-size: 13px; }
    .environment-tools .tools { margin-top: 12px; }
    @media (max-width: 40rem) { .settings-grid { grid-template-columns: 1fr; } }
    .key-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .key-row p { color: var(--muted); font-size: 13px; }
    .key-row form { flex-shrink: 0; }
    ${connectionMascotStyles}
    .page-head { margin: 0.75rem 0 0.15rem; }
    .page-head h2 { font-size: 20px; font-weight: 600; color: var(--text); letter-spacing: 0; }
    .page-head p { margin-top: 4px; color: var(--muted); font-size: 14px; font-weight: 400; }
    main button { min-height: 34px; padding: 8px 16px; border-radius: 999px; border: 1px solid transparent; background: var(--accent); color: var(--on-accent); font-size: 13px; font-weight: 500; }
    main button.quiet { background: light-dark(#ffffff, #212121); color: light-dark(#0d0d0d, #ececec); border-color: light-dark(#e6e6e6, #3d3d3d); padding: 8px 16px; }
    main button.stop { background: transparent; color: light-dark(#b91c1c, #f87171); border-color: light-dark(rgba(185, 28, 28, 0.35), rgba(248, 113, 113, 0.35)); }
    main .modes { border-radius: 999px; padding: 2px; background: light-dark(#f4f4f4, #303030); border: 1px solid light-dark(#e6e6e6, #3d3d3d); }
    main .modes button { background: transparent; color: var(--text); border-color: transparent; }
    main .modes button.on { background: var(--accent); color: var(--on-accent); }
    main button.connection-copy { display: inline-flex; align-items: center; gap: 6px; padding: 6px 10px; background: transparent; color: var(--muted); border-radius: 8px; }
    .connection-copy svg { width: 16px; height: 16px; }
    main button.connection-clear { padding: 6px 0; background: transparent; color: var(--muted); border-radius: 6px; font-size: 12px; font-weight: 400; }
    main button.connection-copy:hover:not(:disabled) { background: var(--input); color: var(--text); }
    main button.connection-clear:hover:not(:disabled) { color: light-dark(#b91c1c, #f87171); }
    ${classroomUpdateStyles}
  </style>
  <script>${drawerScript()}${installProgressScript}${snippetCopyScript()}${courseSectionScript()}${connectionMascotScript}${classroomUpdateScript}${settingsActionsScript}${modelStatusScript}
  </script>`;
  return html.replace("</body>", `${extra}</body>`);
}

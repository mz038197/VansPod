import type { CaptureList, CaptureView } from "./promptCapture";

// Prompt 觀察室「解剖圖」版面（原型 A）。這些函式同時在伺服器端產生第一個畫面，
// 也以原始碼注入頁面腳本，每 2 秒重新繪製；因此每個函式只能用彼此和自己的參數。

export type InspectorState = { selected: number | null; view: "parts" | "raw"; raw: "sent" | "raw" };

export function inspectorBody(list: CaptureList, state: InspectorState): string {
  const esc = (value: unknown) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const fmt = (value: number) => value.toLocaleString("en-US");
  const segments = [
    { key: "system", label: "System" }, { key: "tools", label: "Tools" }, { key: "reminder", label: "Skill／提醒" },
    { key: "history", label: "先前對話" }, { key: "fresh", label: "本輪新增" },
  ] as const;
  const clients: Record<string, string> = { claude: "Claude Code", codex: "Codex", copilot: "VS Code Chat" };
  const protocols: Record<string, string> = { messages: "Messages", responses: "Responses", chat: "Chat Completions" };
  const clientName = (one: CaptureView) => clients[one.client] ?? one.client;
  const highlight = (text: string) => esc(text).replace(/&lt;system-reminder&gt;[\s\S]*?&lt;\/system-reminder&gt;/g, match => `<mark class="pi-skill">${match}</mark>`);
  const stack = (one: CaptureView) => `<div class="pi-stack" role="img" aria-label="各區塊大小">${segments.map(segment => {
    const size = one.sizes[segment.key];
    return size ? `<span class="pi-seg" data-seg="${segment.key}" style="width:${(size / one.total) * 100}%" title="${segment.label} 約 ${fmt(size)} tokens"></span>` : "";
  }).join("")}</div>`;
  const summary = (one: CaptureView) => {
    const last = one.messages.filter(message => message.isNew && !message.reminder).slice(-1)[0];
    return last ? (last.kind === "tool_use" ? `呼叫 ${last.name ?? ""}` : last.text.replace(/\s+/g, " ").slice(0, 120)) : "";
  };

  if (!list.captures.length) return `<section class="tile pi-empty"><p class="hint">切到「課堂」並開始錄製後，送出的 prompt 會出現在這裡。</p></section>`;
  const current = list.captures.find(one => one.id === state.selected) ?? list.captures[0];

  const items = list.captures.map(one => `<button type="button" class="pi-req${one === current ? " on" : ""}" data-pick="${one.id}">`
    + `<span class="pi-req-top"><strong>#${one.id} ${esc(clientName(one))}</strong>${one.newConversation ? `<em class="pi-newconv">新對話</em>` : ""}<span>${esc(one.time)}</span></span>`
    + `<span class="pi-req-sub">${esc(summary(one))}</span>${stack(one)}</button>`).join("");
  const dropped = list.dropped ? `<p class="hint pi-dropped">較早的 ${list.dropped} 筆已捨去</p>` : "";

  const legend = `<ul class="pi-legend">${segments.map(segment => `<li><span class="pi-dot" data-seg="${segment.key}"></span>${segment.label}<b>${current.total ? Math.round((current.sizes[segment.key] / current.total) * 100) : 0}%</b></li>`).join("")}</ul>`;
  const meta = `<p class="pi-meta">${esc(clientName(current))} · ${esc(current.model || "（未指定模型）")} · ${esc(protocols[current.protocol] ?? current.protocol)} · 約 ${fmt(current.total)} tokens（估算）</p>`;
  const tool = (item: CaptureView["tools"][number]) => `<details class="pi-tool${item.name === "Skill" ? " is-skill" : ""}"><summary><code>${esc(item.name)}</code><span>${esc(item.description.split(/(?<=[.。])\s/)[0])}</span></summary>`
    + `<pre>${esc(item.description)}</pre><pre class="pi-schema">${esc(JSON.stringify(item.schema ?? {}, null, 2))}</pre></details>`;
  const message = (item: CaptureView["messages"][number]) => {
    const head = item.kind === "tool_use" ? `Assistant 呼叫工具 <code>${esc(item.name ?? "")}</code>`
      : item.kind === "tool_result" ? `Tool 結果${item.name ? ` <code>${esc(item.name)}</code>` : ""}`
      : item.reminder ? "User（客戶端自動附加）" : item.role === "assistant" ? "Assistant" : "User";
    const classes = `pi-msg role-${item.role}${item.reminder ? " is-reminder" : ""}${item.kind === "tool_use" ? " kind-call" : ""}${item.isNew ? " is-new" : ""}`;
    const tag = item.isNew && !item.reminder ? `<span class="pi-new">本輪新增</span>` : "";
    return `<div class="${classes}"><div class="pi-msg-head"><span>${head}</span>${tag}</div><pre>${highlight(item.text)}</pre></div>`;
  };
  const talkSize = current.sizes.reminder + current.sizes.history + current.sizes.fresh;
  const sections = `<details class="pi-sec" data-sec="system" open><summary><span class="pi-dot" data-seg="system"></span>System<span class="pi-count">約 ${fmt(current.sizes.system)} tokens</span></summary>`
    + (current.system.length ? current.system.map(text => `<pre>${highlight(text)}</pre>`).join("") : `<p class="hint">這筆請求沒有 System。</p>`) + `</details>`
    + `<details class="pi-sec" data-sec="tools"><summary><span class="pi-dot" data-seg="tools"></span>Tools · ${current.tools.length} 個<span class="pi-count">約 ${fmt(current.sizes.tools)} tokens</span></summary>`
    + (current.tools.length ? current.tools.map(tool).join("") : `<p class="hint">這筆請求沒有附工具。</p>`) + `</details>`
    + `<details class="pi-sec" data-sec="messages" open><summary><span class="pi-dot" data-seg="fresh"></span>對話 · ${current.messages.length} 則<span class="pi-count">約 ${fmt(talkSize)} tokens</span></summary>`
    + current.messages.map(message).join("") + `</details>`;
  const raw = `<div class="pi-raw"${state.view === "raw" ? "" : " hidden"}><div class="modes pi-raw-tabs" role="tablist">`
    + `<button type="button" class="${state.raw === "sent" ? "on" : ""}" data-raw="sent">送給 Router</button>`
    + `<button type="button" class="${state.raw === "raw" ? "on" : ""}" data-raw="raw">客戶端原始請求</button></div>`
    + `<pre class="pi-json"${state.raw === "sent" ? "" : " hidden"} data-raw-pane="sent">POST ${esc(current.path)}\n${esc(JSON.stringify(current.sent, null, 2))}</pre>`
    + `<pre class="pi-json"${state.raw === "raw" ? "" : " hidden"} data-raw-pane="raw">${esc(JSON.stringify(current.raw, null, 2))}</pre></div>`;
  const tabs = `<div class="modes pi-view-tabs"><button type="button" class="${state.view === "parts" ? "on" : ""}" data-view="parts">結構</button>`
    + `<button type="button" class="${state.view === "raw" ? "on" : ""}" data-view="raw">原始 JSON</button></div>`;

  return `<div class="pi-a"><section class="tile pi-list"><div class="tile-head"><h2>請求</h2><span class="badge">${list.captures.length} 筆</span></div>`
    + `<div class="pi-req-list">${items}</div>${dropped}</section>`
    + `<section class="tile pi-detail"><div class="tile-head"><h2>#${current.id} 解剖</h2>${current.newConversation ? `<span class="badge">新對話</span>` : ""}</div>${meta}${stack(current)}${legend}${tabs}`
    + `<div class="pi-parts"${state.view === "parts" ? "" : " hidden"}>${sections}</div>${raw}</section></div>`;
}

/** Page script: keeps the selection and open sections while it redraws every 2 seconds. */
export function inspectorScript(): string {
  return `(function () {
    ${inspectorBody.toString()}
    var host = document.getElementById("pi-app");
    if (!host) return;
    var data = JSON.parse(document.getElementById("pi-data").textContent);
    var state = { selected: null, view: "parts", raw: "sent" };
    var open = {};
    function draw() {
      host.querySelectorAll("details[data-sec]").forEach(function (box) { open[box.dataset.sec] = box.open; });
      var scroll = host.querySelector(".pi-req-list"); var top = scroll ? scroll.scrollTop : 0;
      host.innerHTML = inspectorBody(data, state);
      host.querySelectorAll("details[data-sec]").forEach(function (box) { if (box.dataset.sec in open) box.open = open[box.dataset.sec]; });
      scroll = host.querySelector(".pi-req-list"); if (scroll) scroll.scrollTop = top;
    }
    host.addEventListener("click", function (event) {
      var target = event.target.closest && event.target.closest("[data-pick],[data-view],[data-raw]");
      if (!target) return;
      if (target.dataset.pick) state.selected = Number(target.dataset.pick);
      if (target.dataset.view) state.view = target.dataset.view;
      if (target.dataset.raw) state.raw = target.dataset.raw;
      draw();
    });
    var last = "";
    setInterval(async function () {
      try {
        var response = await fetch("/prompt-capture", { cache: "no-store" });
        if (!response.ok) return;
        var text = await response.text();
        if (text === last) return;
        last = text; data = JSON.parse(text);
        // 選取的那筆仍在就不動；沒有選取（或已被捨去）時跟著最新的一筆。
        if (state.selected !== null && !data.captures.some(function (one) { return one.id === state.selected; })) state.selected = null;
        draw();
      } catch (error) { /* VansPod 關閉時保持最後的畫面 */ }
    }, 2000);
  })();`;
}

export const INSPECTOR_STYLES = `
    .pi-empty { align-items: center; text-align: center; padding: 40px 18px; }
    .inspector-main pre { margin: 0; padding: 12px; border: 1px solid var(--line); border-radius: 10px; background: var(--input); font: 12px/1.65 "Cascadia Mono", Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 22rem; overflow: auto; color: var(--text); }
    .inspector-main code { font: 12px "Cascadia Mono", Consolas, monospace; }
    .inspector-main details > summary { cursor: pointer; }
    .inspector-main .tile-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding-bottom: 12px; border-bottom: 1px solid var(--line); }
    .inspector-main .tile-head h2 { font-size: 15px; font-weight: 600; }
    [data-seg="system"] { --seg: light-dark(#7c3aed, #a78bfa); }
    [data-seg="tools"] { --seg: light-dark(#2563eb, #60a5fa); }
    [data-seg="reminder"] { --seg: light-dark(#db2777, #f472b6); }
    [data-seg="history"] { --seg: light-dark(#a3a3a3, #6b6b6b); }
    [data-seg="fresh"] { --seg: light-dark(#059669, #4ecb9d); }
    .pi-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--seg); flex-shrink: 0; }
    .pi-stack { display: flex; height: 10px; width: 100%; border-radius: 999px; overflow: hidden; background: light-dark(#ececec, #333333); }
    .pi-seg { display: block; height: 100%; background: var(--seg); min-width: 2px; }
    .pi-seg + .pi-seg { box-shadow: inset 1px 0 0 var(--tile); }
    .pi-legend { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 6px 14px; font-size: 12px; color: var(--muted); }
    .pi-legend li { display: inline-flex; align-items: center; gap: 6px; }
    .pi-legend b { color: var(--text); font-weight: 600; }
    .pi-meta { color: var(--muted); font-size: 13px; overflow-wrap: anywhere; }
    .pi-count { margin-left: auto; color: var(--muted); font-size: 12px; font-weight: 400; }
    .pi-msg { display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; border-radius: 12px; border: 1px solid var(--line); border-left: 3px solid light-dark(#d4d4d4, #4a4a4a); background: var(--tile); }
    .pi-msg + .pi-msg { margin-top: 8px; }
    .pi-msg pre { max-height: 14rem; }
    .pi-msg-head { display: flex; align-items: center; gap: 8px; font-size: 12px; font-weight: 600; color: var(--muted); }
    .pi-msg.role-user { border-left-color: light-dark(#059669, #4ecb9d); }
    .pi-msg.role-assistant { border-left-color: light-dark(#d97706, #fbbf24); }
    .pi-msg.role-tool { border-left-color: light-dark(#64748b, #94a3b8); }
    .pi-msg.kind-call pre { background: #0d1117; color: #e6edf3; border-color: #30363d; }
    .pi-msg.is-reminder { border-left-color: light-dark(#db2777, #f472b6); }
    .pi-msg:not(.is-new) { opacity: 0.62; }
    .pi-new, .pi-newconv { display: inline-flex; align-items: center; min-height: 20px; padding: 0 8px; border-radius: 999px; background: light-dark(rgba(16, 163, 127, 0.10), rgba(78, 203, 157, 0.13)); color: light-dark(#0a7d5c, #4ecb9d); font: 600 11px system-ui, sans-serif; }
    .pi-req-top .pi-newconv { margin-right: auto; }
    mark.pi-skill { background: light-dark(#fce7f3, #4a1d36); color: light-dark(#9d174d, #fbcfe8); border-radius: 4px; padding: 0 2px; }
    .pi-tool { border: 1px solid var(--line); border-radius: 10px; padding: 8px 10px; }
    .pi-tool + .pi-tool { margin-top: 6px; }
    .pi-tool summary { display: flex; align-items: baseline; gap: 10px; font-size: 13px; min-width: 0; }
    .pi-tool summary span { color: var(--muted); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pi-tool > pre { margin-top: 8px; }
    .pi-tool.is-skill { border-color: light-dark(#f9a8d4, #7a2a55); }
    .pi-tool.is-skill summary code::after { content: "skill"; margin-left: 6px; padding: 0 6px; border-radius: 999px; background: light-dark(#fce7f3, #4a1d36); color: light-dark(#9d174d, #fbcfe8); font: 600 10px system-ui, sans-serif; }
    .pi-schema { opacity: 0.8; }
    .pi-raw { display: flex; flex-direction: column; gap: 8px; }
    .pi-raw-tabs, .pi-view-tabs { align-self: flex-start; display: inline-flex; width: auto; }
    .inspector-main .modes button { min-height: 30px; padding: 5px 12px; font-size: 12px; white-space: nowrap; flex: 0 0 auto; }
    .inspector-main .pi-json { max-height: 30rem; }
    .inspector-main [hidden] { display: none !important; }
    .pi-a { display: grid; grid-template-columns: 19rem minmax(0, 1fr); gap: 12px; align-items: start; }
    .pi-list { position: sticky; top: 12px; }
    .pi-req-list { display: flex; flex-direction: column; gap: 6px; max-height: 70dvh; overflow: auto; }
    main button.pi-req { display: flex; flex-direction: column; align-items: stretch; gap: 6px; width: 100%; min-height: 0; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--line); background: var(--tile); color: var(--text); text-align: left; font-weight: 400; }
    main button.pi-req.on { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
    .pi-req-top { display: flex; justify-content: space-between; gap: 8px; font-size: 13px; }
    .pi-req-top span { color: var(--muted); font-size: 12px; }
    .pi-req-sub { color: var(--muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pi-req .pi-stack { height: 5px; }
    .pi-sec { border-top: 1px solid var(--line); padding-top: 12px; }
    .pi-sec > summary { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 14px; margin-bottom: 10px; }
    .pi-sec pre + pre { margin-top: 8px; }
    @media (max-width: 760px) { .pi-a { grid-template-columns: 1fr; } .pi-list { position: static; } }`;

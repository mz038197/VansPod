// PROTOTYPE — throwaway. A–D, switchable via ?variant= when not in production.
// D is the official page plus the switcher. The served page without ?variant= stays src/page.ts.
import type { ClassroomAppView } from "./classroomApp";
import { classroomBlocks, renderPage } from "./page";

const PRODUCT = "VansPod";

export const PROTOTYPE_VARIANTS = ["A", "B", "C", "D"] as const;
export type PrototypeVariant = (typeof PROTOTYPE_VARIANTS)[number];

const VARIANT_NAME: Record<PrototypeVariant, string> = {
  A: "側欄控制台",
  B: "設定清單",
  C: "工作區",
  D: "原本",
};

const SECTIONS = [
  { id: "connect", label: "連線" },
  { id: "folder", label: "資料夾" },
  { id: "model", label: "模型" },
  { id: "environment", label: "環境" },
  { id: "command", label: "指令" },
  { id: "catalog", label: "課程" },
] as const;

export function isPrototypeVariant(value: string): value is PrototypeVariant {
  return (PROTOTYPE_VARIANTS as readonly string[]).includes(value);
}

function stamp(html: string, variant?: PrototypeVariant): string {
  if (!variant) return html;
  return html.replaceAll(
    /<form\b([^>]*)>/g,
    `<form$1><input type="hidden" name="prototype_variant" value="${variant}">`,
  );
}

function stateText(view: ClassroomAppView): string {
  return JSON.stringify(
    {
      connected: view.connected,
      mode: view.mode,
      modelId: view.modelId ?? null,
      classLabel: view.classLabel ?? null,
      detail: view.detail,
      notice: view.notice ?? null,
      projectFolder: view.projectFolder ?? null,
      installAvailable: view.installAvailable,
      commandRunning: view.commandRunning,
      pendingCommand: view.pendingCommand ?? null,
      catalogError: view.catalogError ?? null,
      actions: view.catalog?.actions.length ?? 0,
      snippets: view.catalog?.snippets?.length ?? 0,
      tools: view.tools.map((tool) => ({
        id: tool.id,
        readiness: tool.readiness,
        selected: tool.selected,
      })),
      mustRestart: view.mustRestart ?? [],
    },
    null,
    2,
  );
}

const CSS = `
  :root {
    color-scheme: light dark;
    --bg: light-dark(#ffffff, #212121);
    --rail: light-dark(#f9f9f9, #171717);
    --surface: light-dark(#ffffff, #262626);
    --raised: light-dark(#f4f4f4, #303030);
    --border: light-dark(#e6e6e6, #3d3d3d);
    --border-soft: light-dark(#f0f0f0, #333333);
    --text: light-dark(#0d0d0d, #ececec);
    --muted: light-dark(#6e6e6e, #a6a6a6);
    --faint: light-dark(#707070, #9a9a9a);
    --accent: light-dark(#0d0d0d, #ececec);
    --accent-hover: light-dark(#3d3d3d, #ffffff);
    --accent-ink: light-dark(#ffffff, #0d0d0d);
    --accent-soft: light-dark(rgba(13, 13, 13, 0.06), rgba(255, 255, 255, 0.09));
    --accent-ring: light-dark(rgba(0, 0, 0, 0.5), rgba(255, 255, 255, 0.38));
    --green: light-dark(#0a7d5c, #4ecb9d);
    --green-soft: light-dark(rgba(16, 163, 127, 0.10), rgba(78, 203, 157, 0.13));
    --red: light-dark(#b91c1c, #f87171);
    --red-soft: light-dark(rgba(185, 28, 28, 0.09), rgba(248, 113, 113, 0.13));
    --amber: light-dark(#9a4a08, #fbbf24);
    --glass-rail: light-dark(rgba(249, 249, 249, 0.66), rgba(23, 23, 23, 0.62));
    --radius: 12px;
    --radius-sm: 8px;
    --radius-pill: 999px;
    --font-ui: "Segoe UI", "Microsoft JhengHei", system-ui, sans-serif;
    --font-code: ui-monospace, "Cascadia Code", Consolas, monospace;
  }
  :root[data-theme="light"] { color-scheme: light; }
  :root[data-theme="dark"] { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { margin: 0; min-height: 100%; }
  body {
    background: transparent;
    color: var(--text);
    font-family: var(--font-ui);
    font-size: 14px;
    line-height: 1.5;
  }
  body::before {
    content: "";
    position: fixed;
    inset: -20%;
    z-index: -1;
    pointer-events: none;
    background:
      radial-gradient(42% 38% at 12% 6%, light-dark(rgba(164, 196, 255, 0.42), rgba(96, 130, 200, 0.16)), transparent 70%),
      radial-gradient(46% 42% at 88% 18%, light-dark(rgba(168, 226, 197, 0.38), rgba(88, 160, 130, 0.13)), transparent 70%),
      radial-gradient(40% 36% at 70% 92%, light-dark(rgba(255, 224, 194, 0.30), rgba(180, 140, 100, 0.08)), transparent 72%),
      var(--bg);
    filter: blur(70px);
  }
  button, input { font: inherit; color: inherit; }
  button { cursor: pointer; }
  button:disabled { opacity: 0.55; cursor: default; }
  h1, h2, h3, p { margin: 0; }
  pre, code { white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--font-code); font-size: 12px; }
  .hint, .empty, .mode-line { color: var(--muted); font-size: 13px; }
  .error, .restart { color: var(--red); font-size: 13px; }
  .running { color: var(--green); font-weight: 600; font-size: 13px; }
  .detail, .notice, .class-label { font-size: 14px; }
  .proto button:not(.nav-item):not(.theme-btn) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 34px;
    padding: 8px 16px;
    border: 1px solid transparent;
    border-radius: var(--radius-pill);
    background: var(--accent);
    color: var(--accent-ink);
    font-size: 13px;
    font-weight: 500;
  }
  .proto button.quiet {
    background: var(--bg);
    color: var(--text);
    border-color: var(--border);
  }
  .proto button.stop {
    background: transparent;
    color: var(--red);
    border-color: transparent;
  }
  .proto .modes {
    display: flex;
    gap: 2px;
    padding: 2px;
    border-radius: var(--radius-pill);
    background: var(--raised);
    border: 1px solid var(--border);
  }
  .proto .modes button {
    flex: 1;
    background: transparent;
    color: var(--muted);
    border-color: transparent;
  }
  .proto .modes button.on {
    background: var(--accent);
    color: var(--accent-ink);
  }
  .proto input:not([type="checkbox"]):not([type="hidden"]) {
    width: 100%;
    min-height: 34px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg);
    padding: 0 10px;
    font-size: 13px;
  }
  .proto label { display: flex; flex-direction: column; gap: 6px; font-size: 12px; color: var(--muted); }
  .proto form.stack, .proto .tools { display: flex; flex-direction: column; gap: 10px; }
  .proto .tool { flex-direction: row; align-items: center; gap: 8px; color: var(--text); font-size: 13px; }
  .proto .tool em { margin-left: auto; font-style: normal; color: var(--muted); font-size: 12px; }
  .proto table { width: 100%; border-collapse: collapse; }
  .proto th, .proto td { text-align: left; vertical-align: top; padding: 10px 12px 10px 0; border-bottom: 1px solid var(--border-soft); }
  .proto th { font-size: 12px; font-weight: 500; color: var(--muted); }
  .proto .choices { display: flex; gap: 8px; align-items: center; }
  .proto .pending, .proto pre {
    margin: 0;
    padding: 12px;
    background: var(--raised);
    border: 1px solid var(--border-soft);
    border-radius: var(--radius-sm);
  }
  .badge {
    display: inline-flex;
    align-items: center;
    min-height: 22px;
    padding: 0 8px;
    border-radius: var(--radius-pill);
    background: var(--green-soft);
    color: var(--green);
    font-size: 12px;
    font-weight: 600;
  }
  .badge.off { background: var(--raised); color: var(--muted); }
  .brand-row { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .mark {
    width: 26px; height: 26px; border-radius: 6px; overflow: hidden; flex: 0 0 auto;
    border: 1px solid var(--border); background: var(--surface);
  }
  .mark img { width: 100%; height: 100%; object-fit: contain; }
  .brand-name { font-size: 16px; font-weight: 600; letter-spacing: 0; }
  .theme-btn {
    width: 34px; height: 34px; padding: 0; border-radius: 999px;
    background: var(--surface); color: var(--text); border: 1px solid var(--border);
  }
  .notices { display: flex; flex-direction: column; gap: 4px; margin: 8px 0 18px; max-width: 70ch; }

  .shell { display: grid; grid-template-columns: 232px minmax(0, 1fr); min-height: 100dvh; }
  .sidebar {
    position: sticky; top: 0; height: 100dvh;
    display: flex; flex-direction: column; gap: 4px;
    padding: 18px 14px;
    border-right: 1px solid var(--border);
    background: var(--glass-rail);
    backdrop-filter: saturate(1.6) blur(22px);
  }
  .sidebar nav { display: flex; flex-direction: column; gap: 4px; margin-top: 8px; }
  .nav-item {
    display: flex; align-items: center; width: 100%;
    padding: 8px 10px; border: 0; border-radius: var(--radius-sm);
    background: none; color: var(--muted); font-size: 13px; font-weight: 500;
    text-align: left;
  }
  .nav-item.active { background: var(--accent-soft); color: var(--text); font-weight: 600; }
  .sidebar-foot { margin-top: auto; display: flex; flex-direction: column; gap: 8px; padding-top: 12px; }
  .main { min-width: 0; }
  .main-inner { max-width: 980px; margin: 0 auto; padding: 32px 36px 96px; }
  .page-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
  .page-head h2 { font-size: 20px; font-weight: 600; }
  .panel { display: none; }
  .panel.on { display: block; }

  .sheet { max-width: 880px; margin: 0 auto; padding: 28px 28px 120px; }
  .sheet-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
  .set-list { margin-top: 12px; border-top: 1px solid var(--border); }
  .set-row {
    display: grid;
    grid-template-columns: 180px minmax(0, 1fr);
    gap: 20px;
    padding: 18px 0;
    border-bottom: 1px solid var(--border);
  }
  .set-label h2 { font-size: 14px; font-weight: 600; }
  .set-label p { margin-top: 4px; color: var(--muted); font-size: 12px; }
  .sheet-block { padding: 22px 0 8px; }
  .sheet-block h2 { font-size: 14px; font-weight: 600; margin-bottom: 12px; }

  .workspace { min-height: 100dvh; display: flex; flex-direction: column; }
  .topbar {
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    padding: 14px 20px; border-bottom: 1px solid var(--border);
    background: var(--glass-rail); backdrop-filter: saturate(1.6) blur(22px);
    position: sticky; top: 0;
  }
  .split { display: grid; grid-template-columns: 320px minmax(0, 1fr); gap: 0; flex: 1; }
  .rail-actions { border-right: 1px solid var(--border); padding: 16px; display: flex; flex-direction: column; gap: 12px; }
  .rail-actions section { border: 1px solid var(--border); border-radius: var(--radius); padding: 14px; background: var(--surface); }
  .rail-actions h2 { font-size: 12px; font-weight: 500; color: var(--muted); margin-bottom: 10px; }
  .detail { padding: 20px 24px 110px; min-width: 0; }
  .detail h2 { font-size: 12px; font-weight: 500; color: var(--muted); margin: 18px 0 8px; }
  .detail h2:first-child { margin-top: 0; }
  .terminal { background: var(--rail); border: 1px solid var(--border); border-radius: var(--radius); padding: 14px; min-height: 180px; }

  .proto-bar {
    position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%);
    z-index: 80; width: min(440px, calc(100% - 24px));
    display: flex; flex-direction: column; gap: 6px; align-items: center;
  }
  .proto-state {
    width: 100%; max-height: 88px; overflow: auto; margin: 0;
    padding: 8px 10px; border-radius: 10px;
    background: #111; color: #f4f4f4; border: 2px solid #f5c518;
    font-size: 10px; line-height: 1.35;
  }
  .proto-pill {
    display: flex; align-items: center; gap: 8px;
    padding: 6px 8px; border-radius: 999px;
    background: #111; color: #fff; border: 2px solid #f5c518;
    box-shadow: 0 8px 24px rgba(0,0,0,0.28);
  }
  .proto-pill button {
    width: 32px; height: 32px; min-height: 32px; padding: 0; border-radius: 999px;
    background: #f5c518; color: #111; border: 0; font-weight: 700;
    align-self: auto;
  }
  .proto-pill span { font-size: 13px; font-weight: 600; min-width: 9rem; text-align: center; }
  @media (max-width: 760px) {
    .shell, .split, .set-row { grid-template-columns: 1fr; }
    .sidebar { position: relative; height: auto; border-right: 0; border-bottom: 1px solid var(--border); }
    .rail-actions { border-right: 0; border-bottom: 1px solid var(--border); }
    .main-inner, .sheet { padding-inline: 16px; }
  }
  @media (prefers-reduced-motion: reduce) {
    * { transition: none !important; }
  }
`;

function themeButton(): string {
  return `<button type="button" class="theme-btn" data-appearance-toggle aria-label="切換外觀">◐</button>`;
}

function brand(): string {
  return `<div class="brand-row">
    <div class="mark"><img src="/brand-logo.png" alt=""></div>
    <div class="brand-name">${PRODUCT}</div>
  </div>`;
}

function badge(status: string, connected: boolean): string {
  return `<span class="badge${connected ? "" : " off"}">${status}</span>`;
}

function switcher(variant: PrototypeVariant, state: string): string {
  const index = PROTOTYPE_VARIANTS.indexOf(variant);
  const prev = PROTOTYPE_VARIANTS[(index + PROTOTYPE_VARIANTS.length - 1) % PROTOTYPE_VARIANTS.length];
  const next = PROTOTYPE_VARIANTS[(index + 1) % PROTOTYPE_VARIANTS.length];
  return `<div class="proto-bar" data-proto-bar>
    <pre class="proto-state">${state.replaceAll("<", "&lt;")}</pre>
    <div class="proto-pill">
      <button type="button" data-proto-go="${prev}" aria-label="上一個版本">‹</button>
      <span>${variant} · ${VARIANT_NAME[variant]}</span>
      <button type="button" data-proto-go="${next}" aria-label="下一個版本">›</button>
    </div>
  </div>`;
}

function variantA(blocks: ReturnType<typeof classroomBlocks>, view: ClassroomAppView, variant: PrototypeVariant): string {
  const nav = SECTIONS.map(
    (section, index) =>
      `<button type="button" class="nav-item${index === 0 ? " active" : ""}" data-nav="${section.id}">${section.label}</button>`,
  ).join("");
  const panels = SECTIONS.map((section, index) => {
    const body = stamp(blocks[section.id], variant);
    return `<section class="panel${index === 0 ? " on" : ""}" data-panel="${section.id}">${body}</section>`;
  }).join("");
  return `<div class="shell">
    <aside class="sidebar">
      ${brand()}
      <nav aria-label="區段">${nav}</nav>
      <div class="sidebar-foot">
        ${badge(blocks.status, view.connected)}
        ${stamp(blocks.stop, variant)}
        ${themeButton()}
      </div>
    </aside>
    <main class="main">
      <div class="main-inner">
        <div class="page-head">
          <h2 data-page-title>連線</h2>
          ${badge(blocks.status, view.connected)}
        </div>
        <div class="notices">${blocks.notices}</div>
        ${panels}
      </div>
    </main>
  </div>`;
}

function variantB(blocks: ReturnType<typeof classroomBlocks>, view: ClassroomAppView, variant: PrototypeVariant): string {
  const rows = [
    ["連線", "邀請碼、暱稱，或複製已兌換的 key。", blocks.connect],
    ["資料夾", "安裝課程檔案時寫入的專案路徑。", blocks.folder],
    ["模型", "Classroom 與 Native 的切換。", blocks.model],
    ["環境", "這台電腦還缺哪些工具。", blocks.environment],
  ] as const;
  const list = rows
    .map(
      ([title, hint, body]) => `<section class="set-row">
        <div class="set-label"><h2>${title}</h2><p>${hint}</p></div>
        <div class="set-control">${stamp(body, variant)}</div>
      </section>`,
    )
    .join("");
  return `<div class="sheet">
    <header class="sheet-head">
      ${brand()}
      <div class="brand-row">${badge(blocks.status, view.connected)}${themeButton()}</div>
    </header>
    <div class="notices">${blocks.notices}</div>
    <div class="set-list">${list}</div>
    <section class="sheet-block">
      <h2>指令</h2>
      ${stamp(blocks.command, variant)}
    </section>
    <section class="sheet-block">
      <h2>課程</h2>
      ${stamp(blocks.catalog, variant)}
    </section>
    <section class="sheet-block">${stamp(blocks.stop, variant)}</section>
  </div>`;
}

function variantC(blocks: ReturnType<typeof classroomBlocks>, view: ClassroomAppView, variant: PrototypeVariant): string {
  const rail = [
    ["連線", blocks.connect],
    ["資料夾", blocks.folder],
    ["模型", blocks.model],
    ["環境", blocks.environment],
  ]
    .map(([title, body]) => `<section><h2>${title}</h2>${stamp(body, variant)}</section>`)
    .join("");
  return `<div class="workspace">
    <header class="topbar">
      ${brand()}
      <div class="brand-row">${badge(blocks.status, view.connected)}${themeButton()}${stamp(blocks.stop, variant)}</div>
    </header>
    <div class="notices" style="padding: 12px 20px 0;">${blocks.notices}</div>
    <div class="split">
      <div class="rail-actions">${rail}</div>
      <div class="detail">
        <h2>指令</h2>
        <div class="terminal">${stamp(blocks.command, variant)}</div>
        <h2>課程</h2>
        ${stamp(blocks.catalog, variant)}
      </div>
    </div>
  </div>`;
}

function clientScript(variant: PrototypeVariant): string {
  return `
    var appearanceKey = "classroom-appearance";
    function systemDark() {
      return window.matchMedia("(prefers-color-scheme: dark)").matches;
    }
    function paintTheme() {
      var stored = null;
      try { stored = localStorage.getItem(appearanceKey); } catch (error) {}
      var appearance = stored === "light" || stored === "dark" ? stored : (systemDark() ? "dark" : "light");
      document.documentElement.dataset.theme = appearance;
      var button = document.querySelector("[data-appearance-toggle]");
      if (button) button.setAttribute("aria-label", appearance === "dark" ? "切換到淺色" : "切換到深色");
    }
    paintTheme();
    document.addEventListener("click", function (event) {
      var target = event.target;
      if (!target || !target.closest) return;
      if (target.closest("[data-appearance-toggle]")) {
        var current = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
        var next = current === "dark" ? "light" : "dark";
        try { localStorage.setItem(appearanceKey, next); } catch (error) {}
        paintTheme();
      }
      var jump = target.closest("[data-proto-go]");
      if (jump) {
        var url = new URL(location.href);
        url.searchParams.set("variant", jump.getAttribute("data-proto-go"));
        location.assign(url.pathname + url.search + url.hash);
      }
      var nav = target.closest("[data-nav]");
      if (nav) {
        var id = nav.getAttribute("data-nav");
        document.querySelectorAll("[data-nav]").forEach(function (item) {
          item.classList.toggle("active", item.getAttribute("data-nav") === id);
        });
        document.querySelectorAll("[data-panel]").forEach(function (panel) {
          panel.classList.toggle("on", panel.getAttribute("data-panel") === id);
        });
        var title = document.querySelector("[data-page-title]");
        if (title) title.textContent = nav.textContent;
        history.replaceState(null, "", "#" + id);
      }
    });
    var first = (location.hash || "#connect").slice(1);
    var start = document.querySelector('[data-nav="' + first + '"]');
    if (start) start.click();
    window.addEventListener("keydown", function (event) {
      var tag = event.target && event.target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || (event.target && event.target.isContentEditable)) return;
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      var order = ${JSON.stringify(PROTOTYPE_VARIANTS)};
      var current = ${JSON.stringify(variant)};
      var index = order.indexOf(current);
      var step = event.key === "ArrowRight" ? 1 : -1;
      var next = order[(index + step + order.length) % order.length];
      var url = new URL(location.href);
      url.searchParams.set("variant", next);
      location.assign(url.pathname + url.search);
    });
    window.addEventListener("pagehide", function () {
      navigator.sendBeacon("/close");
    });
  `;
}

function variantD(view: ClassroomAppView): string {
  const html = stamp(renderPage(view), "D");
  const bar = `<style>
    .proto-bar { position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%); z-index: 80; width: min(440px, calc(100% - 24px)); display: flex; flex-direction: column; gap: 6px; align-items: center; }
    .proto-state { width: 100%; max-height: 88px; overflow: auto; margin: 0; padding: 8px 10px; border-radius: 10px; background: #111; color: #f4f4f4; border: 2px solid #f5c518; font-size: 10px; line-height: 1.35; }
    .proto-pill { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 999px; background: #111; color: #fff; border: 2px solid #f5c518; box-shadow: 0 8px 24px rgba(0,0,0,0.28); }
    .proto-pill button { width: 32px; height: 32px; min-height: 32px; padding: 0; border: 0; border-radius: 999px; background: #f5c518; color: #111; font-weight: 700; }
    .proto-pill span { font-size: 13px; font-weight: 600; min-width: 9rem; text-align: center; }
  </style>
  ${switcher("D", stateText(view))}
  <script>
    document.addEventListener("click", function (event) {
      var target = event.target;
      if (!target || !target.closest) return;
      var jump = target.closest("[data-proto-go]");
      if (!jump) return;
      var url = new URL(location.href);
      url.searchParams.set("variant", jump.getAttribute("data-proto-go"));
      location.assign(url.pathname + url.search);
    });
    window.addEventListener("keydown", function (event) {
      var tag = event.target && event.target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || (event.target && event.target.isContentEditable)) return;
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      var order = ${JSON.stringify(PROTOTYPE_VARIANTS)};
      var index = order.indexOf("D");
      var step = event.key === "ArrowRight" ? 1 : -1;
      var next = order[(index + step + order.length) % order.length];
      var url = new URL(location.href);
      url.searchParams.set("variant", next);
      location.assign(url.pathname + url.search);
    });
  </script>`;
  return html.replace("</body>", `${bar}</body>`);
}

export function renderPrototypePage(view: ClassroomAppView, variant: PrototypeVariant): string {
  if (variant === "D") return variantD(view);
  const blocks = classroomBlocks(view);
  const body =
    variant === "A"
      ? variantA(blocks, view, variant)
      : variant === "B"
        ? variantB(blocks, view, variant)
        : variantC(blocks, view, variant);
  return `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${PRODUCT}</title>
  <style>${CSS}</style>
</head>
<body>
  <div class="proto">${body}</div>
  ${switcher(variant, stateText(view))}
  <script>${clientScript(variant)}</script>
</body>
</html>`;
}

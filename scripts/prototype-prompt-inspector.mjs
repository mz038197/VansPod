// PROTOTYPE — throwaway. 「Prompt 觀察室」三種版面，?variant=A|B|C 切換。
// 沿用正式 renderPage 的頁殼與側欄，只把 <main> 換成原型內容；資料全是記憶體裡的假請求。
// 執行：npm run prototype:inspector，然後開 http://127.0.0.1:4319/
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pagePkg from "../dist/page.js";

const { renderPage } = pagePkg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT ?? 4319);

const view = {
  connected: true, detail: "Classroom API Key 已設定。", canCopyKey: true, installAvailable: false,
  commandRunning: false, mode: "classroom", courseTitle: "AI 程式設計入門", sessionTitle: "第 3 堂", nickname: "小明",
  tools: [
    { id: "uv", label: "uv", installed: true, selected: false },
    { id: "git", label: "git", installed: true, selected: false },
    { id: "node", label: "Node.js", installed: true, selected: false },
    { id: "pwsh", label: "PowerShell 7", installed: true, selected: false },
  ],
};

const GEAR = `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m9.5 3-.6 2.3-2 .9-2.1-.6-2.5 4.3 1.5 1.7v2.3l-1.5 1.7 2.5 4.3 2.1-.6 2 .9.6 2.3h5l.6-2.3 2-.9 2.1.6 2.5-4.3-1.5-1.7v-2.3l1.5-1.7-2.5-4.3-2.1.6-2-.9L14.5 3z"/><circle cx="12" cy="12" r="3"/></svg>`;
const SCOPE = `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h16v11H4z"/><path d="M8 20h8M12 16v4"/><path d="m8 9 2 2-2 2M12 13h4"/></svg>`;

function nav(current) {
  const item = (href, icon, label, on) => `<a href="${href}" class="side-item"${on ? ' aria-current="page"' : ""}>${icon}<span>${label}</span></a>`;
  return `<nav aria-label="選單">${item("/?page=settings", GEAR, "教室設定", current === "settings")}${item("/", SCOPE, "Prompt 觀察室", current === "inspector")}</nav>`;
}

function shell(page) {
  let html = renderPage(view).replace(/<nav aria-label="選單">[\s\S]*?<\/nav>/, nav(page));
  const navStyle = `<style>
    a.side-item { text-decoration: none; }
    .side-item:not([aria-current]) { background: transparent; color: var(--muted); font-weight: 500; }
    .side-item:not([aria-current]):hover { background: light-dark(rgba(13, 13, 13, 0.04), rgba(255, 255, 255, 0.06)); color: var(--text); }
    .bar nav { gap: 2px; }
  </style>`;
  html = html.replace("</head>", `${navStyle}</head>`);
  if (page === "settings") return html;
  const css = fs.readFileSync(path.join(root, "scripts/prototype-prompt-inspector.css"), "utf8");
  const js = fs.readFileSync(path.join(root, "scripts/prototype-prompt-inspector.client.js"), "utf8");
  return html
    .replace(/<main>[\s\S]*<\/main>/, `<main class="inspector-main"><div id="inspector"></div></main>`)
    .replace("</body>", `<style>${css}</style><script>${js}</script></body>`);
}

http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  if (url.pathname === "/brand-logo.png" || url.pathname === "/favicon.ico") {
    const file = url.pathname === "/favicon.ico" ? "media/brand-icon.ico" : "media/brand-logo.png";
    res.writeHead(200, { "Content-Type": url.pathname === "/favicon.ico" ? "image/x-icon" : "image/png" });
    res.end(fs.readFileSync(path.join(root, file)));
    return;
  }
  if (url.pathname === "/model-status") { res.writeHead(200, { "Content-Type": "application/json" }); res.end("{}"); return; }
  if (url.pathname !== "/") { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(shell(url.searchParams.get("page") === "settings" ? "settings" : "inspector"));
}).listen(PORT, "127.0.0.1", () => console.log(`PROTOTYPE Prompt 觀察室：http://127.0.0.1:${PORT}/  （?variant=A|B|C）`));

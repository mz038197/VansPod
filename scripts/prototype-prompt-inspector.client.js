// PROTOTYPE — throwaway client script for the Prompt 觀察室 prototype.
(function () {
  // ---------- 假資料：adapter 送給 Router 的請求（sent）與客戶端原始請求（raw） ----------
  var SKILLS = "<system-reminder>\nThe following skills are available for use with the Skill tool:\n\n- tdd: Test-driven development. Use when the user wants to build features test-first.\n- pdf: Use this skill whenever the user wants to do anything with PDF files.\n- teach: Explain a concept step by step for a beginner.\n</system-reminder>";
  var CLAUDE_MD = "<system-reminder>\nContents of CLAUDE.md (project instructions):\n- 這是 Python 入門課的練習資料夾。\n- 回答請使用繁體中文，程式註解也用繁體中文。\n</system-reminder>";
  var SYSTEM = [
    "You are Claude Code, an interactive CLI tool that helps users with software engineering tasks.",
    "",
    "# Tone and style",
    "Be concise. Your output is displayed in a terminal. Only use emojis if the user asks for them.",
    "",
    "# Doing tasks",
    "1. Understand the request; search the codebase when you need context.",
    "2. Make the smallest correct change. Prefer editing existing files over creating new ones.",
    "3. Verify your change by running the relevant tests or the program itself.",
    "",
    "# Tool usage policy",
    "Use the dedicated tools (Read, Edit, Glob) instead of shell commands when one fits.",
    "When several tool calls are independent, call them in parallel.",
    "",
    "# Safety",
    "Never run destructive commands (rm -rf, git reset --hard) without the user's explicit approval.",
    "",
    "<env>",
    "Working directory: C:\\Users\\student\\python-class",
    "Platform: win32",
    "Today's date: 2026-10-16",
    "</env>",
  ].join("\n");
  var CLAUDE_TOOLS = [
    { name: "Bash", description: "Executes a given shell command and returns its output. Use for running programs, tests, git and package managers. Do not use it for reading or editing files; use the dedicated tools instead. Commands time out after 2 minutes by default.", input_schema: { type: "object", properties: { command: { type: "string", description: "The command to execute" }, timeout: { type: "number" } }, required: ["command"] } },
    { name: "Read", description: "Reads a file from the local filesystem. The file_path must be absolute. Results are returned with line numbers. Can read images and PDFs.", input_schema: { type: "object", properties: { file_path: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } }, required: ["file_path"] } },
    { name: "Edit", description: "Performs exact string replacement in a file. old_string must match the file exactly and be unique. You must Read the file before editing it.", input_schema: { type: "object", properties: { file_path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" } }, required: ["file_path", "old_string", "new_string"] } },
    { name: "Glob", description: "Fast file pattern matching. Supports glob patterns like **/*.py. Returns matching paths sorted by modification time.", input_schema: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] } },
    { name: "Skill", description: "Invoke a skill. A skill is a packaged set of instructions for a particular kind of task. Available skills appear in a system-reminder listing with one-line descriptions. When the task matches a listed skill, call this tool first.", input_schema: { type: "object", properties: { skill: { type: "string" }, args: { type: "string" } }, required: ["skill"] } },
  ];
  var ASK = "幫我讓 hello.py 先問名字，再跟對方打招呼。";
  var turn1 = [{ role: "user", content: [{ type: "text", text: SKILLS }, { type: "text", text: CLAUDE_MD }, { type: "text", text: ASK }] }];
  var turn2 = turn1.concat([
    { role: "assistant", content: [{ type: "text", text: "我先看看 hello.py 現在的內容。" }, { type: "tool_use", id: "toolu_01", name: "Read", input: { file_path: "C:\\Users\\student\\python-class\\hello.py" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_01", content: "1\tprint(\"Hello, world!\")" }] },
  ]);
  var turn3 = turn2.concat([
    { role: "assistant", content: [{ type: "text", text: "改成用 input() 先問名字。" }, { type: "tool_use", id: "toolu_02", name: "Edit", input: { file_path: "C:\\Users\\student\\python-class\\hello.py", old_string: "print(\"Hello, world!\")", new_string: "name = input(\"你叫什麼名字？\")\nprint(f\"哈囉，{name}！\")" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_02", content: "The file hello.py has been updated." }] },
  ]);
  function claudeBody(model, messages) { return { model: model, max_tokens: 32000, stream: true, system: SYSTEM, tools: CLAUDE_TOOLS, messages: messages }; }

  var CODEX_INSTRUCTIONS = "You are Codex, a coding agent running in the user's terminal.\n\n## Planning\nFor non-trivial tasks, keep a short plan and update it as you go.\n\n## Editing\nUse apply_patch to edit files. Never revert changes you did not make.\n\n## Sandbox\nThe workspace is writable; network access requires approval.";
  var codexRaw = { model: "gpt-6.1-sol", instructions: CODEX_INSTRUCTIONS, stream: true,
    tools: [
      { type: "function", name: "shell", description: "Runs a shell command and returns its output.", parameters: { type: "object", properties: { command: { type: "array", items: { type: "string" } } }, required: ["command"] } },
      { type: "custom", name: "apply_patch", description: "Use the apply_patch tool to edit files. The input is a patch in the Codex patch envelope format." },
    ],
    input: [
      { type: "message", role: "developer", content: [{ type: "input_text", text: "<environment_context>\n  <cwd>C:\\Users\\student\\python-class</cwd>\n  <shell>powershell</shell>\n</environment_context>" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "列出這個資料夾有哪些 .py 檔" }] },
    ] };
  var codexSent = { model: "gpt-6.1-sol", stream: true,
    messages: [
      { role: "system", content: CODEX_INSTRUCTIONS },
      { role: "system", content: "<environment_context>\n  <cwd>C:\\Users\\student\\python-class</cwd>\n  <shell>powershell</shell>\n</environment_context>" },
      { role: "user", content: "列出這個資料夾有哪些 .py 檔" },
    ],
    tools: [
      { type: "function", function: { name: "shell", description: "Runs a shell command and returns its output.", parameters: codexRaw.tools[0].parameters } },
      { type: "function", function: { name: "apply_patch", description: "Use the apply_patch tool to edit files. The input is a patch in the Codex patch envelope format.", parameters: { type: "object", properties: { input: { type: "string" } }, required: ["input"] } } },
    ] };

  var REQUESTS = [
    { id: 1, time: "10:42:03", client: "Claude Code", protocol: "messages", adapter: "Messages", background: true, note: "產生對話標題",
      sent: { model: "claude-haiku-5-5", max_tokens: 512, system: "Summarize the user's request as a short title of 3–7 words. Reply with the title only.", messages: [{ role: "user", content: ASK }] } },
    { id: 2, time: "10:42:03", client: "Claude Code", protocol: "messages", adapter: "Messages", sent: claudeBody("claude-sonnet-5-5", turn1) },
    { id: 3, time: "10:42:09", client: "Claude Code", protocol: "messages", adapter: "Messages", sent: claudeBody("claude-sonnet-5-5", turn2) },
    { id: 4, time: "10:42:15", client: "Claude Code", protocol: "messages", adapter: "Messages", sent: claudeBody("claude-sonnet-5-5", turn3) },
    { id: 5, time: "10:45:31", client: "Codex", protocol: "chat", adapter: "Chat Completions", raw: codexRaw, sent: codexSent },
  ];
  REQUESTS.forEach(function (r) { if (!r.raw) r.raw = r.sent; });
  var PATHS = { messages: "/v1/messages", responses: "/v1/responses", chat: "/v1/chat/completions" };

  // ---------- 三種協定 → 同一個顯示結構 ----------
  function textOf(content) {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) return content.map(function (c) { return typeof c === "string" ? c : c.text || c.output || ""; }).join("\n");
    return content == null ? "" : JSON.stringify(content, null, 2);
  }
  function normalize(protocol, body) {
    var out = { model: body.model, system: [], tools: [], messages: [] };
    if (protocol === "messages") {
      if (body.system) out.system.push(textOf(body.system));
      (body.tools || []).forEach(function (t) { out.tools.push({ name: t.name, description: t.description || "", schema: t.input_schema }); });
      (body.messages || []).forEach(function (m) {
        var parts = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
        parts.forEach(function (p) {
          if (p.type === "text") out.messages.push({ role: m.role, kind: "text", text: p.text });
          else if (p.type === "tool_use") out.messages.push({ role: "assistant", kind: "tool_use", name: p.name, text: JSON.stringify(p.input, null, 2) });
          else if (p.type === "tool_result") out.messages.push({ role: "tool", kind: "tool_result", text: textOf(p.content) });
        });
      });
    } else if (protocol === "chat") {
      (body.tools || []).forEach(function (t) { out.tools.push({ name: t.function.name, description: t.function.description || "", schema: t.function.parameters }); });
      (body.messages || []).forEach(function (m) {
        if (m.role === "system" || m.role === "developer") { out.system.push(textOf(m.content)); return; }
        if (m.role === "tool") { out.messages.push({ role: "tool", kind: "tool_result", text: textOf(m.content) }); return; }
        if (m.content) out.messages.push({ role: m.role, kind: "text", text: textOf(m.content) });
        (m.tool_calls || []).forEach(function (c) { out.messages.push({ role: "assistant", kind: "tool_use", name: c.function.name, text: c.function.arguments }); });
      });
    } else if (protocol === "responses") {
      if (body.instructions) out.system.push(body.instructions);
      (body.tools || []).forEach(function (t) { out.tools.push({ name: t.name, description: t.description || "", schema: t.parameters }); });
      (body.input || []).forEach(function (i) {
        if (i.type === "function_call") out.messages.push({ role: "assistant", kind: "tool_use", name: i.name, text: i.arguments });
        else if (i.type === "function_call_output") out.messages.push({ role: "tool", kind: "tool_result", text: textOf(i.output) });
        else if (i.role === "system" || i.role === "developer") out.system.push(textOf(i.content));
        else out.messages.push({ role: i.role, kind: "text", text: textOf(i.content) });
      });
    }
    return out;
  }
  // 粗估：英文約 4 字元一個 token，中文約 1 字一個 token。
  function tokens(text) {
    var cjk = (text.match(/[\u3400-\u9fff\uff00-\uffef]/g) || []).length;
    return Math.max(1, Math.round(cjk + (text.length - cjk) / 4));
  }
  function isSkillText(text) { return /<system-reminder>/.test(text); }
  function analyze(r) {
    var n = normalize(r.protocol, r.sent);
    var prev = null;
    for (var i = REQUESTS.indexOf(r) - 1; i >= 0; i--) {
      var p = REQUESTS[i];
      if (p.client === r.client && !p.background && !r.background) { prev = normalize(p.protocol, p.sent); break; }
    }
    var newFrom = prev ? prev.messages.length : 0;
    n.messages.forEach(function (m, idx) { m.isNew = idx >= newFrom; m.reminder = isSkillText(m.text); });
    var sizes = { system: 0, tools: 0, reminder: 0, history: 0, fresh: 0 };
    n.system.forEach(function (s) { sizes.system += tokens(s); });
    n.tools.forEach(function (t) { sizes.tools += tokens(t.name + t.description + JSON.stringify(t.schema || {})); });
    n.messages.forEach(function (m) {
      var k = tokens(m.text + (m.name || ""));
      if (m.reminder) sizes.reminder += k; else if (m.isNew) sizes.fresh += k; else sizes.history += k;
    });
    n.sizes = sizes;
    n.total = sizes.system + sizes.tools + sizes.reminder + sizes.history + sizes.fresh;
    n.hasPrev = !!prev;
    return n;
  }

  // ---------- 共用小元件 ----------
  var SEG = [
    { key: "system", label: "System", hint: "客戶端寫給模型的角色與規則" },
    { key: "tools", label: "Tools", hint: "模型可以呼叫的工具與說明" },
    { key: "reminder", label: "Skill／提醒", hint: "塞進對話裡的 skill 清單與專案說明" },
    { key: "history", label: "先前對話", hint: "上一輪已送過、這次又重送一次" },
    { key: "fresh", label: "本輪新增", hint: "這一輪才多出來的內容" },
  ];
  var ROLE_LABEL = { user: "User", assistant: "Assistant", tool: "Tool 結果" };
  function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  function fmt(n) { return n.toLocaleString("en-US"); }
  function highlight(text) {
    return esc(text).replace(/&lt;system-reminder&gt;[\s\S]*?&lt;\/system-reminder&gt;/g, function (m) { return '<mark class="pi-skill">' + m + "</mark>"; });
  }
  function stackBar(n, scale) {
    var w = scale || n.total;
    return '<div class="pi-stack" role="img" aria-label="各區塊大小">' + SEG.map(function (s) {
      var v = n.sizes[s.key]; if (!v) return "";
      return '<span class="pi-seg" data-seg="' + s.key + '" style="width:' + (v / w * 100) + '%" title="' + s.label + " 約 " + fmt(v) + ' tokens"></span>';
    }).join("") + "</div>";
  }
  function legend(n) {
    return '<ul class="pi-legend">' + SEG.map(function (s) {
      var v = n.sizes[s.key];
      return '<li><span class="pi-dot" data-seg="' + s.key + '"></span>' + s.label + '<b>' + (n.total ? Math.round(v / n.total * 100) : 0) + "%</b></li>";
    }).join("") + "</ul>";
  }
  function meta(r, n) {
    return '<p class="pi-meta"><span>' + esc(r.client) + "</span><span>·</span><span>" + esc(n.model) + "</span><span>·</span><span>" + r.adapter + " 協定</span><span>·</span><span>約 " + fmt(n.total) + " tokens</span></p>";
  }
  function messageHtml(m) {
    var cls = "pi-msg role-" + m.role + (m.kind === "tool_use" ? " kind-call" : "") + (m.reminder ? " is-reminder" : "") + (m.isNew ? " is-new" : "");
    var head = m.kind === "tool_use" ? "Assistant 呼叫工具 <code>" + esc(m.name) + "</code>" : (m.reminder ? "User（客戶端自動附加）" : ROLE_LABEL[m.role] || m.role);
    return '<div class="' + cls + '"><div class="pi-msg-head"><span>' + head + "</span>" + (m.isNew ? '<span class="pi-new">本輪新增</span>' : "") + "</div><pre>" + highlight(m.text) + "</pre></div>";
  }
  function toolHtml(t) {
    var skill = t.name === "Skill";
    return '<details class="pi-tool' + (skill ? " is-skill" : "") + '"><summary><code>' + esc(t.name) + "</code><span>" + esc(t.description.split(". ")[0]) + "</span></summary><pre>" + esc(t.description) + "</pre><pre class=\"pi-schema\">" + esc(JSON.stringify(t.schema || {}, null, 2)) + "</pre></details>";
  }
  function rawTabs(r) {
    var same = r.raw === r.sent;
    return '<div class="pi-raw"><div class="modes pi-raw-tabs" role="tablist"><button type="button" class="on" data-raw="sent">送給 Router（' + r.adapter + "）</button><button type=\"button\" data-raw=\"raw\">客戶端原始請求</button></div>" +
      '<pre class="pi-json" data-raw-pane="sent">POST ' + PATHS[r.protocol] + "\n" + esc(JSON.stringify(r.sent, null, 2)) + "</pre>" +
      '<pre class="pi-json" data-raw-pane="raw" hidden>' + (same ? "（這筆請求的 adapter 沒有改變格式，與左邊相同）\n" : "") + esc(JSON.stringify(r.raw, null, 2)) + "</pre></div>";
  }
  function header() {
    return '<header class="page-head"><h2>Prompt 觀察室</h2><p>看看 Coding Agent 每次送給模型的完整內容。</p></header>' +
      '<section class="tile pi-recorder"><div class="pi-rec-state"><span class="pi-rec-dot"></span><div><strong>錄製中</strong><p class="hint">只記在這台電腦的記憶體，最多 20 筆，關掉 VansPod 就清除。只有切到「課堂」的客戶端會被記錄。</p></div></div>' +
      '<div class="pi-rec-actions"><button type="button" class="quiet">暫停</button><button type="button" class="quiet">清除</button></div></section>';
  }
  function filterRow() {
    return '<label class="pi-filter"><input type="checkbox" data-bg' + (state.showBg ? " checked" : "") + "> 顯示背景請求（產生標題等）</label>";
  }
  function visible() { return REQUESTS.filter(function (r) { return state.showBg || !r.background; }); }
  function current() {
    var list = visible();
    return list.filter(function (r) { return r.id === state.id; })[0] || list[list.length - 1];
  }

  // ---------- A：解剖圖（清單 + 分區詳情） ----------
  function variantA() {
    var list = visible(), r = current(), n = analyze(r);
    var items = list.slice().reverse().map(function (x) {
      var nx = analyze(x);
      return '<button type="button" class="pi-req' + (x === r ? " on" : "") + '" data-pick="' + x.id + '"><span class="pi-req-top"><strong>#' + x.id + " " + esc(x.client) + "</strong><span>" + x.time + "</span></span>" +
        '<span class="pi-req-sub">' + (x.background ? '<span class="kind-tag">背景</span> ' + esc(x.note) : esc(nx.messages.filter(function (m) { return m.isNew && !m.reminder; }).map(function (m) { return m.kind === "tool_use" ? "呼叫 " + m.name : m.text; }).slice(-1)[0] || "")) + "</span>" + stackBar(nx) + "</button>";
    }).join("");
    var sections =
      '<details class="pi-sec" data-sec="system" open><summary><span class="pi-dot" data-seg="system"></span>System<span class="pi-count">約 ' + fmt(n.sizes.system) + " tokens</span></summary>" + n.system.map(function (s) { return "<pre>" + highlight(s) + "</pre>"; }).join("") + "</details>" +
      '<details class="pi-sec" data-sec="tools"><summary><span class="pi-dot" data-seg="tools"></span>Tools · ' + n.tools.length + ' 個<span class="pi-count">約 ' + fmt(n.sizes.tools) + " tokens</span></summary>" + (n.tools.length ? n.tools.map(toolHtml).join("") : '<p class="hint">這筆請求沒有附工具。</p>') + "</details>" +
      '<details class="pi-sec" data-sec="messages" open><summary><span class="pi-dot" data-seg="fresh"></span>對話 · ' + n.messages.length + ' 則<span class="pi-count">約 ' + fmt(n.sizes.reminder + n.sizes.history + n.sizes.fresh) + " tokens</span></summary>" + n.messages.map(messageHtml).join("") + "</details>";
    return header() + '<div class="pi-a"><section class="tile pi-list"><div class="tile-head"><h2>請求</h2><span class="badge">' + list.length + " 筆</span></div>" + filterRow() + '<div class="pi-req-list">' + items + "</div></section>" +
      '<section class="tile pi-detail"><div class="tile-head"><h2>#' + r.id + " 解剖</h2>" + (r.background ? '<span class="badge off">背景請求</span>' : "") + "</div>" + meta(r, n) + stackBar(n) + legend(n) +
      '<div class="modes pi-view-tabs"><button type="button" class="' + (state.tab === "parts" ? "on" : "") + '" data-tab="parts">結構</button><button type="button" class="' + (state.tab === "raw" ? "on" : "") + '" data-tab="raw">原始 JSON</button></div>' +
      (state.tab === "raw" ? rawTabs(r) : sections) + "</section></div>";
  }

  // ---------- B：對話劇本（步驟條 + 聊天泡泡） ----------
  function variantB() {
    var list = visible(), r = current(), n = analyze(r);
    var steps = list.map(function (x, i) {
      return '<button type="button" class="pi-step' + (x === r ? " on" : "") + '" data-pick="' + x.id + '"><span class="pi-step-n">' + (i + 1) + "</span><span>" + (x.background ? "背景：" + esc(x.note) : esc(x.client) + " 第 " + (list.filter(function (y) { return y.client === x.client && !y.background && y.id <= x.id; }).length) + " 次") + "</span></button>";
    }).join('<span class="pi-step-line" aria-hidden="true"></span>');
    var firstNew = n.messages.findIndex(function (m) { return m.isNew; });
    var chat = n.messages.map(function (m, i) {
      var divider = n.hasPrev && i === firstNew ? '<div class="pi-divider"><span>以上是上一輪送過的，這次又整段重送 ↓ 以下才是本輪新增</span></div>' : "";
      return divider + messageHtml(m);
    }).join("");
    return header() + '<section class="tile pi-b-steps"><div class="pi-steps">' + steps + "</div>" + filterRow() + "</section>" +
      '<section class="tile pi-b"><div class="tile-head"><h2>這一次送出去的劇本</h2><span class="badge">' + r.adapter + "</span></div>" + meta(r, n) +
      '<div class="pi-stage"><div class="pi-stage-label"><span class="pi-dot" data-seg="system"></span>幕後指示（System）<span class="pi-count">約 ' + fmt(n.sizes.system) + " tokens · 學生看不到，但每次都會送</span></div><details><summary>展開 System prompt</summary>" + n.system.map(function (s) { return "<pre>" + highlight(s) + "</pre>"; }).join("") + "</details></div>" +
      '<div class="pi-props"><div class="pi-stage-label"><span class="pi-dot" data-seg="tools"></span>道具箱（Tools）<span class="pi-count">' + n.tools.length + " 個 · 約 " + fmt(n.sizes.tools) + " tokens</span></div>" +
      '<div class="pi-chips">' + n.tools.map(function (t) { return '<button type="button" class="pi-chip' + (t.name === "Skill" ? " is-skill" : "") + '" data-chip="' + esc(t.name) + '">' + esc(t.name) + "</button>"; }).join("") + "</div>" +
      n.tools.map(function (t) { return '<div class="pi-chip-detail" data-chip-detail="' + esc(t.name) + '" hidden><pre>' + esc(t.description) + '</pre><pre class="pi-schema">' + esc(JSON.stringify(t.schema || {}, null, 2)) + "</pre></div>"; }).join("") + "</div>" +
      '<div class="pi-chat">' + chat + "</div>" +
      "<details class=\"pi-rawbox\"><summary>看原始 JSON</summary>" + rawTabs(r) + "</details></section>";
  }

  // ---------- C：Token 地圖（每輪一條比例尺 + 點區塊看內容） ----------
  function variantC() {
    var list = visible(), r = current();
    var all = list.map(function (x) { return { r: x, n: analyze(x) }; });
    var max = Math.max.apply(null, all.map(function (a) { return a.n.total; }));
    var rows = all.map(function (a) {
      return '<button type="button" class="pi-row' + (a.r === r ? " on" : "") + '" data-pick="' + a.r.id + '"><span class="pi-row-label"><strong>#' + a.r.id + "</strong> " + esc(a.r.background ? a.r.note : a.r.client) + "</span>" + stackBar(a.n, max) + '<span class="pi-row-total">' + fmt(a.n.total) + "</span></button>";
    }).join("");
    var n = analyze(r), seg = state.seg;
    var body;
    if (seg === "system") body = n.system.map(function (s) { return "<pre>" + highlight(s) + "</pre>"; }).join("");
    else if (seg === "tools") body = n.tools.map(toolHtml).join("") || '<p class="hint">沒有工具。</p>';
    else {
      var ms = n.messages.filter(function (m) { return seg === "reminder" ? m.reminder : seg === "history" ? !m.isNew && !m.reminder : m.isNew && !m.reminder; });
      body = ms.length ? ms.map(messageHtml).join("") : '<p class="hint">這一輪沒有這類內容。</p>';
    }
    var info = SEG.filter(function (s) { return s.key === seg; })[0];
    var tabs = SEG.map(function (s) { return '<button type="button" class="pi-seg-tab' + (s.key === seg ? " on" : "") + '" data-segpick="' + s.key + '"><span class="pi-dot" data-seg="' + s.key + '"></span>' + s.label + "<b>" + fmt(n.sizes[s.key]) + "</b></button>"; }).join("");
    return header() + '<section class="tile pi-c-map"><div class="tile-head"><h2>每一次送出去有多大</h2><span class="badge off">tokens 為估算</span></div>' +
      '<p class="hint">同一個比例尺。對話越長，每一輪都要把前面的內容重送一次。</p>' + filterRow() + '<div class="pi-rows">' + rows + "</div>" + legend(n) + "</section>" +
      '<section class="tile pi-c-detail"><div class="tile-head"><h2>#' + r.id + " 裡面裝了什麼</h2><span class=\"badge\">" + r.adapter + "</span></div>" + meta(r, n) +
      '<div class="pi-seg-tabs">' + tabs + "</div><p class=\"pi-seg-hint\">" + info.hint + "</p><div class=\"pi-seg-body\">" + body + "</div>" +
      '<details class="pi-rawbox"><summary>看原始 JSON</summary>' + rawTabs(r) + "</details></section>";
  }

  // ---------- 切換與互動 ----------
  var VARIANTS = { A: { name: "解剖圖", render: variantA }, B: { name: "對話劇本", render: variantB }, C: { name: "Token 地圖", render: variantC } };
  var KEYS = Object.keys(VARIANTS);
  var params = new URLSearchParams(location.search);
  var state = { variant: VARIANTS[params.get("variant")] ? params.get("variant") : "A", id: 4, tab: "parts", seg: "fresh", showBg: false };
  var host = document.getElementById("inspector");

  function switcher() {
    var i = KEYS.indexOf(state.variant);
    var prev = KEYS[(i + KEYS.length - 1) % KEYS.length], next = KEYS[(i + 1) % KEYS.length];
    return '<div class="proto-pill"><button type="button" data-go="' + prev + '" aria-label="上一個版本">‹</button><span>PROTOTYPE · ' + state.variant + " " + VARIANTS[state.variant].name + '</span><button type="button" data-go="' + next + '" aria-label="下一個版本">›</button></div>';
  }
  function render() {
    host.innerHTML = VARIANTS[state.variant].render() + switcher();
    host.className = "pi-variant-" + state.variant;
  }
  function go(v) {
    state.variant = v;
    var url = new URL(location.href); url.searchParams.set("variant", v); history.replaceState(null, "", url);
    render();
  }
  host.addEventListener("click", function (e) {
    var t = e.target.closest("[data-pick],[data-tab],[data-raw],[data-chip],[data-segpick],[data-go]");
    if (!t) return;
    if (t.dataset.go) return go(t.dataset.go);
    if (t.dataset.pick) { state.id = Number(t.dataset.pick); return render(); }
    if (t.dataset.tab) { state.tab = t.dataset.tab; return render(); }
    if (t.dataset.segpick) { state.seg = t.dataset.segpick; return render(); }
    if (t.dataset.raw) {
      var box = t.closest(".pi-raw");
      box.querySelectorAll("[data-raw]").forEach(function (b) { b.classList.toggle("on", b === t); });
      box.querySelectorAll("[data-raw-pane]").forEach(function (p) { p.hidden = p.dataset.rawPane !== t.dataset.raw; });
      return;
    }
    if (t.dataset.chip) {
      var open = t.classList.toggle("on");
      host.querySelectorAll(".pi-chip").forEach(function (c) { if (c !== t) c.classList.remove("on"); });
      host.querySelectorAll("[data-chip-detail]").forEach(function (d) { d.hidden = !open || d.dataset.chipDetail !== t.dataset.chip; });
    }
  });
  host.addEventListener("change", function (e) {
    if (e.target.matches("[data-bg]")) { state.showBg = e.target.checked; render(); }
  });
  document.addEventListener("keydown", function (e) {
    if (e.target.closest && e.target.closest("input,textarea,select,[contenteditable]")) return;
    var i = KEYS.indexOf(state.variant);
    if (e.key === "ArrowLeft") go(KEYS[(i + KEYS.length - 1) % KEYS.length]);
    if (e.key === "ArrowRight") go(KEYS[(i + 1) % KEYS.length]);
  });
  render();
})();

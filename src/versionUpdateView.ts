// 側欄底部的版本更新按鈕與確認對話框（原型 A）。按鈕預設隱藏，管理 API 可用時由腳本顯示。

const DOWNLOAD_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 19h14"/></svg>`;

export const UPDATE_BUTTON = `<button type="button" class="update-button" data-version-update hidden aria-label="檢查更新" title="檢查更新">${DOWNLOAD_ICON}<span class="update-dot"></span></button>`;

export const VERSION_UPDATE_STYLES = `
    .bar .side-foot { margin-top: auto; display: flex; align-items: center; gap: 6px; }
    .update-button { position: relative; display: grid; place-items: center; width: 34px; height: 34px; min-height: 34px; padding: 0; border-radius: 999px; border: 1px solid var(--line); background: transparent; color: var(--muted); cursor: pointer; }
    .update-button[hidden] { display: none; }
    .update-button:hover { color: var(--text); background: light-dark(rgba(13, 13, 13, 0.04), rgba(255, 255, 255, 0.06)); }
    .update-button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .update-button svg { width: 18px; height: 18px; }
    .update-button .update-dot { display: none; position: absolute; top: 3px; right: 3px; width: 7px; height: 7px; border-radius: 999px; background: #2563eb; box-shadow: 0 0 0 2px var(--bg); }
    .update-button.available { color: #2563eb; border-color: rgba(37, 99, 235, 0.45); background: rgba(37, 99, 235, 0.08); }
    .update-button.available .update-dot { display: block; }
    .update-scrim { position: fixed; inset: 0; z-index: 60; display: grid; place-items: center; padding: 16px; background: light-dark(rgba(20, 20, 20, 0.32), rgba(0, 0, 0, 0.55)); }
    .update-dialog { width: min(440px, 100%); background: light-dark(#ffffff, #2a2a2a); color: var(--text); border: 1px solid var(--line); border-radius: 16px; padding: 22px; box-shadow: 0 20px 60px rgba(0, 0, 0, 0.25); }
    .update-dialog h3 { margin: 0 0 14px; font-size: 17px; font-weight: 600; }
    .update-versions { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 10px; padding: 14px; border-radius: 12px; background: light-dark(#f6f6f6, #333333); margin-bottom: 12px; }
    .update-versions small { display: block; color: var(--muted); font-size: 11px; }
    .update-versions b { font-family: Consolas, "Cascadia Mono", monospace; font-size: 16px; }
    .update-versions span { color: var(--muted); }
    .update-text { margin: 0 0 8px; font-size: 12.5px; line-height: 1.55; color: var(--muted); overflow-wrap: anywhere; }
    .update-note { margin: 8px 0; padding: 9px 11px; border-radius: 10px; font-size: 12.5px; line-height: 1.5; overflow-wrap: anywhere; }
    .update-note.ok { background: light-dark(#e9f7ef, #1d3527); color: light-dark(#17703d, #8be0ad); }
    .update-note.warn { background: light-dark(#fff7e6, #3a2f17); color: light-dark(#8a5300, #f5c46b); }
    .update-note.block { background: light-dark(#fdecec, #3d1f1f); color: light-dark(#b91c1c, #f8a5a5); }
    .update-note a, .update-actions a { color: inherit; font-weight: 600; }
    .update-meter { height: 6px; margin: 10px 0 4px; border-radius: 999px; background: light-dark(#ececec, #3a3a3a); overflow: hidden; }
    .update-meter i { display: block; height: 100%; background: #2563eb; transition: width 0.2s; }
    .update-actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; margin-top: 16px; }
    .update-actions a { margin-right: auto; font-size: 12.5px; font-weight: 400; color: var(--muted); }
    .update-actions button { min-height: 34px; padding: 8px 16px; border-radius: 999px; border: 1px solid var(--line); background: transparent; color: var(--text); font-size: 13px; font-weight: 500; cursor: pointer; }
    .update-actions button.primary { background: var(--accent); color: var(--on-accent); border-color: transparent; }
    .update-actions button.danger { background: light-dark(#b91c1c, #dc2626); color: #ffffff; border-color: transparent; }
    .update-actions button:disabled { opacity: 0.45; cursor: not-allowed; }
    .update-reconnect { position: fixed; inset: 0; z-index: 80; display: grid; place-items: center; padding: 16px; text-align: center; color: var(--text); background: light-dark(rgba(255, 255, 255, 0.9), rgba(20, 20, 20, 0.9)); backdrop-filter: blur(4px); }
    .update-reconnect p { margin-top: 6px; color: var(--muted); font-size: 13px; }
    .update-spinner { width: 28px; height: 28px; margin: 0 auto 12px; border-radius: 999px; border: 3px solid var(--line); border-top-color: #2563eb; animation: update-spin 0.8s linear infinite; }
    @keyframes update-spin { to { transform: rotate(360deg); } }
    .update-toast { position: fixed; top: 18px; left: 50%; z-index: 90; transform: translateX(-50%); padding: 9px 16px; border-radius: 999px; background: #16a34a; color: #ffffff; font-size: 13px; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2); }`;

/** 按鈕與對話框的行為；需要管理 API 的 token，所以由 lifecyclePage 注入。 */
export function versionUpdateScript(token: string): string {
  return `<script>
    (function () {
      var token = ${JSON.stringify(token)};
      var button = document.querySelector('[data-version-update]');
      if (!button) return;
      var state = null, open = false, checking = false, confirming = '', message = '', busy = false;
      function esc(value) { return String(value).replace(/[&<>"']/g, function (c) { return '&#' + c.charCodeAt(0) + ';'; }); }
      async function api(body, query) {
        var response = await fetch('/_vanspod/update' + (query ? '?' + query : ''), {method: body ? 'POST' : 'GET', headers: {'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'}, body: body ? JSON.stringify(body) : undefined, cache: 'no-store'});
        if (!response.ok) throw new Error('VansPod 沒有回應。');
        return response.json();
      }
      function paintButton() {
        button.hidden = false;
        var available = !!(state && state.available);
        button.classList.toggle('available', available);
        var label = available ? '有新版本 v' + state.latest : '檢查更新';
        button.title = label; button.setAttribute('aria-label', label);
      }
      function close() { if (busy) return; open = false; confirming = ''; message = ''; render(); }
      function render() {
        paintButton();
        var scrim = document.querySelector('.update-scrim');
        if (!open) { if (scrim) scrim.remove(); return; }
        if (!scrim) {
          scrim = document.createElement('div'); scrim.className = 'update-scrim';
          scrim.addEventListener('click', function (event) { if (event.target === scrim) close(); });
          document.body.appendChild(scrim);
        }
        var s = state || {};
        var html = '<div class="update-dialog" role="dialog" aria-modal="true" aria-label="版本更新"><h3>版本更新</h3>'
          + '<div class="update-versions"><div><small>目前版本</small><b>v' + esc(s.current || '') + '</b></div><span>→</span><div><small>最新版本</small><b>' + (s.latest ? 'v' + esc(s.latest) : '—') + '</b></div></div>';
        if (checking) html += '<p class="update-text">檢查最新版本…</p>';
        else if (!s.latest) html += '<div class="update-note warn">暫時查不到最新版本，請確認網路後再試。</div>';
        else if (!s.available) html += '<div class="update-note ok">v' + esc(s.current) + ' 已是最新版本。</div>';
        if (message) html += '<div class="update-note block">' + esc(message) + '</div>';
        if (s.error && !message) html += '<div class="update-note block">' + esc(s.error) + '</div>';
        if (s.available && s.block) html += '<div class="update-note block">' + esc(s.block) + (s.source === 'exe' ? ' <a href="' + esc(s.releasesUrl) + '/latest" target="_blank" rel="noopener">前往 GitHub 下載</a>' : '') + '</div>';
        if (s.available && !s.block) html += '<p class="update-text">' + esc(s.action || '') + '</p><p class="update-text">重新啟動後，Prompt 觀察室的觀察紀錄會清空。</p>';
        if (confirming) html += '<div class="update-note warn">' + esc(confirming) + '</div>';
        if (s.phase === 'downloading') html += '<div class="update-meter"><i style="width:' + (s.progress || 2) + '%"></i></div><p class="update-text">下載並驗證 VansPod.exe… ' + (s.progress ? s.progress + '%' : '') + '</p>';
        var canRun = s.available && !s.block && !checking && !busy && s.phase === 'idle';
        html += '<div class="update-actions">' + (s.latest ? '<a href="' + esc(s.releasesUrl) + '/tag/v' + esc(s.latest) + '" target="_blank" rel="noopener">版本說明</a>' : '')
          + '<button type="button" data-update-cancel' + (busy ? ' disabled' : '') + '>取消</button>'
          + '<button type="button" class="' + (confirming ? 'danger' : 'primary') + '" data-update-run' + (canRun ? '' : ' disabled') + '>' + (confirming ? '中斷回答並更新' : '立即更新') + '</button></div></div>';
        scrim.innerHTML = html;
      }
      var pendingKey = 'vanspod-update-target';
      function reconnect() {
        try { if (state && state.latest) sessionStorage.setItem(pendingKey, state.latest); } catch (error) {}
        open = false; render();
        var overlay = document.createElement('div'); overlay.className = 'update-reconnect';
        overlay.innerHTML = '<div><div class="update-spinner"></div><b>VansPod 正在更新並重新啟動</b><p>重新連線中…</p></div>';
        document.body.appendChild(overlay);
        var started = Date.now(), wentDown = false;
        (function poll() {
          var done = wentDown ? fetch('/', {cache: 'no-store'}).then(function (response) { if (response.ok) location.reload(); else throw new Error(); }) : api().then(function () { throw new Error(); }, function () { wentDown = true; throw new Error(); });
          done.catch(function () {
            if (Date.now() - started > 180000) { overlay.querySelector('p').textContent = '更新似乎沒有完成，請重新開啟 VansPod。'; return; }
            setTimeout(poll, 1000);
          });
        })();
      }
      async function follow() {
        try { state = await api(); } catch (error) { reconnect(); return; }
        if (state.phase === 'restarting') { reconnect(); return; }
        if (state.phase === 'idle') { busy = false; render(); return; }
        render(); setTimeout(follow, 500);
      }
      async function run() {
        busy = true; message = ''; render();
        try {
          var result = await api({interruptConfirmed: !!confirming});
          if (result.confirmation) { busy = false; confirming = result.message; render(); return; }
          confirming = '';
          if (!result.ok) { busy = false; message = result.message || '無法更新，請稍後再試。'; render(); return; }
          follow();
        } catch (error) { busy = false; message = error.message; render(); }
      }
      button.addEventListener('click', async function () {
        open = true; checking = true; message = ''; render();
        try { state = await api(null, 'refresh=1'); } catch (error) { message = error.message; }
        checking = false; render();
      });
      document.addEventListener('click', function (event) {
        if (!event.target.closest) return;
        if (event.target.closest('[data-update-cancel]')) close();
        if (event.target.closest('[data-update-run]')) run();
      });
      document.addEventListener('keydown', function (event) { if (event.key === 'Escape' && open) close(); });
      function toast(text) {
        var element = document.createElement('div'); element.className = 'update-toast'; element.textContent = text;
        document.body.appendChild(element); setTimeout(function () { element.remove(); }, 4000);
      }
      // 只有這裡讀走上一次的結果。剛更新完重新載入時，更新工具可能還沒寫出結果，最多等 60 秒。
      function load(attempt) {
        var pending = null;
        try { pending = sessionStorage.getItem(pendingKey); } catch (error) {}
        api(null, 'result=1').then(function (next) {
          state = next; render();
          var last = next.lastResult;
          if (!last && pending && attempt < 60) { setTimeout(function () { load(attempt + 1); }, 1000); return; }
          try { sessionStorage.removeItem(pendingKey); } catch (error) {}
          if (last && !last.ok) { open = true; message = last.message || '更新未完成。'; render(); }
          else if ((last && last.target === next.current) || pending === next.current) toast('已更新到 v' + next.current);
        }).catch(function () {});
      }
      load(0);
      setInterval(function () { if (!open) api().then(function (next) { state = next; render(); }).catch(function () {}); }, 600000);
    })();
  </script>`;
}

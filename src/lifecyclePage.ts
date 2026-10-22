import { versionUpdateScript } from "./versionUpdateView";

const TRASH_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>`;

// 完整移除的確認對話框：先列出會刪除／會保留，實際路徑由管理 API 的預覽填入。
const REMOVE_DIALOG = `<div class="power-modal" hidden><div class="power-dialog" role="dialog" aria-modal="true" aria-labelledby="power-remove-title"><h3 id="power-remove-title">移除 VansPod？</h3><p class="power-warn">只在不再使用這台電腦上課時移除。更新版本不需要移除，否則會清掉課堂資料。</p><p class="power-warn" data-uninstall-interruptions hidden></p><div class="power-split"><div class="drop"><h4>會刪除</h4><ul><li>課堂憑證（API Key）</li><li>偏好與模式記憶</li><li>日誌與暫存檔</li><li>VansPod 程式本身</li></ul></div><div class="keep"><h4>會保留</h4><ul><li>學生專案與作品</li><li>Node、Git、VS Code</li><li>個人設定</li></ul></div></div><details class="power-paths"><summary>查看實際路徑</summary><pre data-uninstall-preview>讀取中…</pre></details><div class="power-confirm" data-power-modal-confirm hidden></div><div class="power-actions"><button type="button" class="quiet" data-power-modal-close>取消</button><button type="button" class="danger" data-lifecycle-confirm="uninstall">${TRASH_ICON}<span>確認移除</span></button></div></div></div><!-- /power-modal -->`;

export function lifecyclePage(html: string, token: string): string {
  const stop = `<button type="button" class="power-stop" data-lifecycle="stop">結束 VansPod</button>`;
  const remove = `<button type="button" class="power-remove" data-lifecycle="uninstall">移除 VansPod…</button>`;
  const script = `<script>
    (function () {
      var token = ${JSON.stringify(token)};
      var toggle = document.querySelector('[data-power-toggle]');
      var message = document.querySelector('[data-lifecycle-message]');
      var modal = document.querySelector('.power-modal');
      async function request(action, body) {
        var response = await fetch('/_vanspod/' + action, {method: body ? 'POST' : 'GET', headers: {'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'}, body: body ? JSON.stringify(body) : undefined});
        if (!response.ok) throw new Error('無法完成操作，請重新開啟 VansPod。');
        return response.json();
      }
      // 訊息寫在面板裡；不是成功訊息時，電源鈕亮黃點提醒學生打開看。
      function say(text, ok) {
        message.textContent = text || '';
        message.classList.toggle('ok', !!ok);
        toggle.classList.toggle('has-message', !!text && !ok);
      }
      // 中斷安裝或模型回答前，在面板／對話框裡再問一次，預設停在「取消」。
      // 面板或對話框被關掉時當作取消，按鈕才不會一直停在停用。
      var pending = null;
      function cancelPending(records) {
        if (pending && records.some(function (record) { return record.target.hidden; })) pending(false);
      }
      var watchHidden = new MutationObserver(cancelPending);
      watchHidden.observe(document.getElementById('power-panel'), {attributes: true, attributeFilter: ['hidden']});
      watchHidden.observe(modal, {attributes: true, attributeFilter: ['hidden']});
      function ask(box, text, label) {
        return new Promise(function (resolve) {
          box.textContent = '';
          var question = document.createElement('p'); question.textContent = text;
          var actions = document.createElement('div'); actions.className = 'power-actions';
          var cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'quiet'; cancel.textContent = '取消';
          var go = document.createElement('button'); go.type = 'button'; go.className = 'danger'; go.textContent = label;
          actions.append(cancel, go); box.append(question, actions); box.hidden = false; cancel.focus();
          function done(value) { pending = null; box.hidden = true; box.textContent = ''; resolve(value); }
          pending = done;
          cancel.onclick = function () { done(false); };
          go.onclick = function () { done(true); };
        });
      }
      async function run(action, body, box, label) {
        var result = await request(action, body);
        if (!result.confirmation) return result;
        if (!(await ask(box, result.message, label))) return null;
        return request(action, Object.assign({}, body, {confirmed: true, interruptConfirmed: true}));
      }
      function setModal(open) {
        if (modal.hidden === !open) return;
        modal.hidden = !open;
        if (open) modal.querySelector('[data-power-modal-close]').focus();
        else document.querySelector('[data-lifecycle="uninstall"]').focus();
      }
      // 預覽回來前不能確認：學生要先看到會刪除什麼、會中止哪些工作。
      async function openRemoval() {
        var paths = modal.querySelector('[data-uninstall-preview]');
        var interruptions = modal.querySelector('[data-uninstall-interruptions]');
        var confirm = modal.querySelector('[data-lifecycle-confirm="uninstall"]');
        paths.textContent = '讀取中…';
        interruptions.hidden = true;
        confirm.disabled = true;
        setModal(true);
        var preview = await request('uninstall-preview');
        if (!preview.ok) { setModal(false); say(preview.message); return; }
        paths.textContent = preview.message;
        interruptions.textContent = preview.interruptions || '';
        interruptions.hidden = !preview.interruptions;
        confirm.disabled = false;
      }
      async function remove() {
        var result = await run('uninstall', {confirmed: true}, modal.querySelector('[data-power-modal-confirm]'), '仍要移除');
        if (!result) return;
        setModal(false);
        say(result.message || '操作未完成，請重試。', result.ok);
      }
      async function stop() {
        var result = await run('stop', {confirmed: false}, document.querySelector('[data-power-confirm]'), '仍要結束');
        if (!result) return;
        say(result.message || (result.ok ? 'VansPod 已結束，可關閉此分頁。' : '操作未完成，請重試。'), result.ok);
        if (result.ok) document.querySelector('.power-head').textContent = 'VansPod 已結束';
      }
      document.addEventListener('click', async function (event) {
        var target = event.target;
        if (!target || !target.closest) return;
        if (target.closest('[data-power-modal-close]') || target === modal) { setModal(false); return; }
        var button = target.closest('[data-lifecycle], [data-lifecycle-confirm]');
        if (!button) return;
        button.disabled = true;
        try {
          if (button.dataset.lifecycle === 'stop') await stop();
          else if (button.dataset.lifecycle === 'uninstall') await openRemoval();
          else await remove();
        } catch (error) { setModal(false); say(error.message); }
        finally { button.disabled = false; }
      });
      document.addEventListener('keydown', function (event) {
        if (event.key === 'Escape' && !modal.hidden) setModal(false);
      });
      request('status').then(function (status) {
        if (status.startupError) { say(status.startupError); return; }
        if (status.trayError) { say('右下角的系統匣圖示無法顯示，VansPod 仍在背景執行。要結束時請用側欄底部的電源鈕。'); return; }
        if (status.launchVersion && status.launchVersion !== status.version) say('目前執行版本 ' + status.version + '，本次開啟版本 ' + status.launchVersion + '。換版請先結束 VansPod。');
      }).catch(function () {});
    })();
  </script>`;
  return html
    .replace(/<form method="post" action="\/stop">[\s\S]*?<\/form>/, stop)
    .replace("<!-- /power-panel -->", `${remove}<!-- /power-panel -->`)
    .replace("</body>", `${REMOVE_DIALOG}${script}${versionUpdateScript(token)}</body>`);
}

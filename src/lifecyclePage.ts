export function lifecyclePage(html: string, token: string): string {
  const controls = `<div style="margin-top:16px"><button type="button" data-lifecycle="stop">結束 VansPod</button> <button type="button" data-lifecycle="uninstall">移除 VansPod</button><p role="status" data-lifecycle-message></p></div>`;
  const script = `<script>
    (function () {
      var token = ${JSON.stringify(token)};
      async function request(action, body) {
        var response = await fetch('/_vanspod/' + action, {method: body ? 'POST' : 'GET', headers: {'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'}, body: body ? JSON.stringify(body) : undefined});
        if (!response.ok) throw new Error('無法完成操作，請重新開啟 VansPod。');
        return response.json();
      }
      document.addEventListener('click', async function (event) {
        var button = event.target.closest && event.target.closest('[data-lifecycle]');
        if (!button) return;
        var message = document.querySelector('[data-lifecycle-message]');
        button.disabled = true;
        try {
          var action = button.dataset.lifecycle;
          var confirmed = false;
          if (action === 'uninstall') {
            var preview = await request('uninstall-preview');
            if (!preview.ok) { message.textContent = preview.message; return; }
            confirmed = window.confirm(preview.message + '\\n\\n確定完整移除 VansPod？');
            if (!confirmed) return;
          }
          var result = await request(action, {confirmed: confirmed});
          if (result.confirmation && window.confirm(result.message)) result = await request(action, {confirmed: true, interruptConfirmed: true});
          message.textContent = result.message || (result.ok ? 'VansPod 已結束，可關閉此分頁。' : '操作未完成，請重試。');
        } catch (error) { message.textContent = error.message; }
        finally { button.disabled = false; }
      });
      request('status').then(function (status) {
        if (status.startupError) { document.querySelector('[data-lifecycle-message]').textContent = status.startupError; return; }
        if (status.launchVersion && status.launchVersion !== status.version) document.querySelector('[data-lifecycle-message]').textContent = '目前執行版本 ' + status.version + '，本次開啟版本 ' + status.launchVersion + '。換版請先結束 VansPod。';
      }).catch(function () {});
    })();
  </script>`;
  return html.replace(/<form method="post" action="\/stop">[\s\S]*?<\/form>/, controls).replace('</body>', `${script}</body>`);
}

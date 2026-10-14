
export const installProgressScript = `
  var installBusy = false;
  var installOpening = false;
  function closeInstallDialog(target) {
    target.closest(".confirm-dialog").remove();
    installBusy = false;
  }
  document.addEventListener("click", function (event) {
    var button = event.target?.closest?.("[data-install-dismiss]");
    if (button && !button.disabled) closeInstallDialog(button);
  });
  document.addEventListener("submit", async function (event) {
    var form = event.target;
    if (form?.matches?.("form[data-abort-install]")) {
      if (!window.confirm("停止後安裝可能不完整，確定停止？")) { event.preventDefault(); return; }
      if (!installBusy || !form.closest(".confirm-panel")) return;
      event.preventDefault();
      var abortButton = form.querySelector("button");
      abortButton.disabled = true;
      form.closest(".confirm-panel").querySelector("[data-install-status]").textContent = "正在停止安裝…";
      try {
        var stopped = await fetch(form.action, { method: "POST", headers: { "X-Classroom-Progress": "1" } });
        if (!stopped.ok) throw new Error("abort failed");
      } catch (error) {
        abortButton.disabled = false;
      }
      return;
    }
    if (form?.matches?.('form[action="/environment"]')) {
      var card = form.closest("section");
      if (!card) return;
      card.querySelectorAll('button[form="settings-environment"]').forEach(function (start) { start.hidden = true; });
      card.querySelectorAll("form[data-abort-install]").forEach(function (abort) { abort.hidden = false; });
      return;
    }
    if (form?.matches?.('form[action="/prepare"]')) {
      event.preventDefault();
      if (installOpening || installBusy || document.querySelector(".confirm-dialog")) return;
      installOpening = true;
      var button = form.querySelector("button");
      var card = form.closest(".install-card");
      var previousError = card?.querySelector(".install-open-error");
      if (previousError) previousError.remove();
      button.disabled = true;
      try {
        var prepared = await fetch(form.action, {
          method: "POST",
          headers: { "X-Classroom-Progress": "1" },
          body: new URLSearchParams(new FormData(form)),
        });
        if (!prepared.ok) throw new Error("prepare failed");
        var page = new DOMParser().parseFromString(await prepared.text(), "text/html");
        var dialog = page.querySelector(".confirm-dialog");
        if (!dialog) throw new Error("dialog unavailable");
        document.body.appendChild(dialog);
      } catch (error) {
        var message = document.createElement("p");
        message.className = "error install-open-error";
        message.setAttribute("role", "alert");
        message.textContent = "無法開啟安裝視窗，請確認專案資料夾已設定後再試。";
        form.appendChild(message);
      } finally {
        button.disabled = false;
        installOpening = false;
      }
      return;
    }
    if (!form || !form.matches || !form.matches('form[action="/confirm"], form[action="/cancel"]')) return;
    event.preventDefault();
    if (installBusy) return;
    installBusy = true;
    var panel = form.closest(".confirm-panel");
    var title = panel.querySelector("h2");
    var status = panel.querySelector("[data-install-status]");
    var output = panel.querySelector("[data-install-output]");
    var dismiss = panel.querySelector("[data-install-dismiss]");
    var choices = panel.querySelector(".choices");
    var buttons = panel.querySelectorAll("button");
    buttons.forEach(function (button) { button.disabled = true; });
    if (form.matches('form[action="/cancel"]')) {
      try {
        var canceled = await fetch(form.action, {
          method: "POST",
          headers: { "X-Classroom-Progress": "1" },
          body: new URLSearchParams(new FormData(form)),
        });
        if (!canceled.ok) throw new Error("cancel failed");
        closeInstallDialog(form);
      } catch (error) {
        status.textContent = "取消失敗，請再試一次。";
        buttons.forEach(function (button) { button.disabled = false; });
        installBusy = false;
      }
      return;
    }
    var abortForm = panel.querySelector("form[data-abort-install]");
    if (abortForm) {
      panel.querySelector('form[action="/confirm"]')?.setAttribute("data-reserved", "");
      var cancelForm = panel.querySelector('form[action="/cancel"]');
      if (cancelForm) cancelForm.hidden = true;
      abortForm.hidden = false;
      abortForm.querySelector("button").disabled = false;
    }
    panel.setAttribute("aria-busy", "true");
    title.textContent = "安裝中";
    status.textContent = "正在執行，請稍候…";
    output.hidden = false;
    var finished = false;
    var timer;
    async function update() {
      try {
        var response = await fetch("/command-status", { cache: "no-store" });
        if (!response.ok) throw new Error("status unavailable");
        var progress = await response.json();
        if (finished) return;
        var atBottom = output.scrollTop + output.clientHeight >= output.scrollHeight - 24;
        output.textContent = progress.output || "等待安裝程式輸出…";
        if (atBottom) output.scrollTop = output.scrollHeight;
        status.textContent = "正在執行，請稍候…";
      } catch (error) {
        if (!finished) status.textContent = "暫時無法更新進度，正在重新連線…";
      }
      if (!finished) timer = setTimeout(update, 500);
    }
    try {
      var request = fetch(form.action, {
        method: "POST",
        headers: { "X-Classroom-Progress": "1" },
        body: new URLSearchParams(new FormData(form)),
      });
      update();
      var result = await request;
      if (!result.ok) throw new Error("confirmation failed");
      var outcome = await result.json();
      if (outcome.succeeded && Array.isArray(outcome.installedActionIds)) {
        document.querySelectorAll('form[action="/prepare"] input[name="action_id"]').forEach(function (input) {
          if (!outcome.installedActionIds.includes(input.value)) return;
          var card = input.closest(".install-card");
          if (!card || card.querySelector(".installed-tag")) return;
          var tag = document.createElement("span");
          tag.className = "badge installed-tag";
          tag.textContent = "已安裝";
          card.querySelector(".install-top").appendChild(tag);
        });
      }
      finished = true;
      clearTimeout(timer);
      if (abortForm) abortForm.hidden = true;
      panel.setAttribute("aria-busy", "false");
      title.textContent = outcome.aborted ? "已中止" : outcome.succeeded ? "安裝成功" : "安裝失敗";
      status.textContent = "請查看執行結果，按下確認後關閉。";
      output.textContent = outcome.output || (outcome.succeeded ? "安裝完成。" : "指令執行失敗。");
      choices.hidden = true;
      dismiss.disabled = false;
      dismiss.hidden = false;
    } catch (error) {
      finished = true;
      clearTimeout(timer);
      if (abortForm) abortForm.hidden = true;
      panel.setAttribute("aria-busy", "false");
      title.textContent = "無法確認安裝結果";
      status.textContent = "請重新整理頁面查看結果，避免重複安裝。";
      choices.hidden = true;
      dismiss.disabled = false;
      dismiss.hidden = false;
    }
  });
`;

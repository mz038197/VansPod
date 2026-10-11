export const settingsActionsScript = `
  var settingsBusy = false;
  document.addEventListener("submit", async function (event) {
    var form = event.target;
    if (!form?.matches?.('form[action="/redeem"], form[action="/copy"], form[action="/clear"], form[action="/project-folder"], form[action="/pick-folder"], form[action="/switch"], form[action="/adapter"], form[action="/reload"], form[action="/environment-check"], form[action="/environment"]')) return;
    event.preventDefault();
    if (settingsBusy || installBusy || installOpening || document.querySelector(".confirm-dialog")) return;
    settingsBusy = true;
    var main = document.querySelector("main");
    var card = form.closest(".settings-card, .project-folder-row") || form;
    card.querySelector(".settings-action-error")?.remove();
    form.querySelector(".connection-error")?.remove();
    var body = new URLSearchParams(new FormData(form));
    if (event.submitter?.name) body.set(event.submitter.name, event.submitter.value);
    var buttons = main.querySelectorAll("button, select");
    var disabled = Array.from(buttons, function (button) { return button.disabled; });
    buttons.forEach(function (button) { button.disabled = true; });
    card.setAttribute("aria-busy", "true");
    try {
      var response = await fetch(form.action, {
        method: "POST",
        headers: { "X-Classroom-Settings": "1" },
        body: body,
      });
      if (!response.ok) throw new Error("settings action failed");
      var page = new DOMParser().parseFromString(await response.text(), "text/html");
      var updated = page.querySelector("main");
      if (!updated) throw new Error("settings page unavailable");
      var top = window.scrollY;
      var openDetails = Array.from(main.querySelectorAll("details"), function (detail) { return detail.open; });
      main.replaceChildren(...updated.childNodes);
      initializeCourseSections();
      main.querySelectorAll("details").forEach(function (detail, index) {
        if (index < openDetails.length) detail.open = openDetails[index];
      });
      window.scrollTo({ top: top, behavior: "instant" });
    } catch (error) {
      var adapter = form.querySelector('select[name="adapter"]');
      if (adapter) adapter.value = adapter.querySelector("option[selected]").value;
      var message = document.createElement("p");
      message.className = "error settings-action-error";
      message.setAttribute("role", "alert");
      message.textContent = "操作未完成，請再試一次。";
      (card.querySelector(".connection-feedback") || card.querySelector(".settings-content") || card).appendChild(message);
    } finally {
      buttons.forEach(function (button, index) { button.disabled = disabled[index]; });
      card.removeAttribute("aria-busy");
      settingsBusy = false;
    }
  });
  document.addEventListener("change", function (event) {
    var select = event.target;
    if (!select?.matches?.('form[action="/adapter"] select[name="adapter"]')) return;
    if (settingsBusy || installBusy || installOpening || document.querySelector(".confirm-dialog")) {
      select.value = select.querySelector("option[selected]").value;
      return;
    }
    select.form.requestSubmit();
  });
`;

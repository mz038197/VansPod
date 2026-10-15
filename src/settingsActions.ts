export const settingsActionsScript = `
  var settingsBusy = false;
  document.addEventListener("submit", async function (event) {
    var form = event.target;
    if (!form?.matches?.('form[action="/redeem"], form[action="/copy"], form[action="/clear"], form[action="/project-folder"], form[action="/pick-folder"], form[action="/switch"], form[action="/adapter"], form[action="/reload"], form[action="/environment-check"], form[action="/environment"]')) return;
    event.preventDefault();
    if (settingsBusy || installBusy || installOpening || document.querySelector(".confirm-dialog")) return;
    settingsBusy = true;
    var copyAction = form.matches('form[action="/copy"]');
    var reloadAction = form.matches('form[action="/reload"]');
    if (typeof classroomUpdateBusy === "function") classroomUpdateBusy(true);
    if (reloadAction && typeof classroomUpdateFeedback === "function") classroomUpdateFeedback("幫你去催課堂內容了，披風都還沒熱，等一下。");
    var main = document.querySelector("main");
    var card = form.closest(".settings-card, .project-folder-row, .classroom-update") || form;
    card.querySelector(".settings-action-error")?.remove();
    form.querySelector(".connection-error")?.remove();
    var body = new URLSearchParams(new FormData(form));
    if (event.submitter?.name) body.set(event.submitter.name, event.submitter.value);
    var buttons = (copyAction ? form : main).querySelectorAll("button, select");
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
      if (copyAction && typeof updateCopyFeedback === "function" && updateCopyFeedback(updated)) return;
      var top = window.scrollY;
      var openDetails = Array.from(main.querySelectorAll("details"), function (detail) { return detail.open; });
      var redeemForm = main.querySelector?.('form[action="/redeem"]');
      var connectionDraft = redeemForm && !form.matches('form[action="/redeem"], form[action="/clear"]')
        ? Array.from(redeemForm.querySelectorAll('input'), function (input) { return { name: input.name, value: input.value }; }) : [];
      var folderDraft = !form.matches('form[action="/project-folder"], form[action="/pick-folder"]')
        ? main.querySelector?.('input[name="project_folder"]')?.value : undefined;
      var toolDraft = reloadAction ? Array.from(main.querySelectorAll('input[type="checkbox"]'), function (input) {
        return { name: input.name, value: input.value, checked: input.checked };
      }) : [];
      var mascotState = typeof mascotAnimationState === "function" && !form.matches('form[action="/redeem"], form[action="/clear"]') ? mascotAnimationState() : [];
      if (form.matches('form[action="/copy"]')) mascotState.speechDismissed = false;
      if (typeof returnClassroomUpdateHome === "function") returnClassroomUpdateHome();
      main.replaceChildren(...updated.childNodes);
      var updatedRedeemForm = main.querySelector?.('form[action="/redeem"]');
      updatedRedeemForm?.querySelectorAll('input').forEach(function (input) {
        var draft = connectionDraft.find(function (entry) { return entry.name === input.name; });
        if (draft) input.value = draft.value;
      });
      var folderInput = main.querySelector?.('input[name="project_folder"]');
      if (folderInput && folderDraft !== undefined) folderInput.value = folderDraft;
      if (reloadAction) main.querySelectorAll('input[type="checkbox"]').forEach(function (input) {
        var draft = toolDraft.find(function (entry) { return entry.name === input.name && entry.value === input.value; });
        if (draft && !input.disabled) input.checked = draft.checked;
      });
      if (typeof restoreMascotAnimationState === "function") restoreMascotAnimationState(mascotState);
      initializeCourseSections();
      main.querySelectorAll("details").forEach(function (detail, index) {
        if (index < openDetails.length) detail.open = openDetails[index];
      });
      window.scrollTo({ top: top, behavior: "instant" });
      if (typeof positionClassroomUpdate === "function") positionClassroomUpdate();
      if (typeof refreshClassroomRestart === "function") refreshClassroomRestart();
      window.scrollTo({ top: top, behavior: "instant" });
      if (reloadAction && typeof classroomUpdateFeedback === "function") classroomUpdateFeedback();
    } catch (error) {
      var adapter = form.querySelector('select[name="adapter"]');
      if (adapter) adapter.value = adapter.querySelector("option[selected]").value;
      var message = document.createElement("p");
      message.className = "error settings-action-error";
      message.setAttribute("role", "alert");
      message.textContent = "操作未完成，請再試一次。";
      if (!reloadAction || typeof classroomUpdateFeedback !== "function") {
        (card.querySelector(".connection-feedback") || card.querySelector(".settings-content") || card).appendChild(message);
      }
      if (reloadAction && typeof classroomUpdateFeedback === "function") classroomUpdateFeedback("這次沒更新成，披風也有收訊死角。按更新再試一次。");
    } finally {
      buttons.forEach(function (button, index) { button.disabled = disabled[index]; });
      card.removeAttribute("aria-busy");
      settingsBusy = false;
      if (typeof classroomUpdateBusy === "function") classroomUpdateBusy(false);
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

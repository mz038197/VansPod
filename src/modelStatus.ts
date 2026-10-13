export const modelStatusScript = `
  async function refreshModelStatus() {
    try {
      if (!document.hidden && !settingsBusy) {
        var response = await fetch("/model-status", { cache: "no-store" });
        if (!response.ok) throw new Error("status unavailable");
        var status = await response.json();
        // A settings action redraws the whole page; never paint an older answer over it.
        if (!settingsBusy) applyModelStatus(status);
      }
    } catch (error) {}
    setTimeout(refreshModelStatus, 1000);
  }
  function applyModelStatus(status) {
    document.querySelectorAll("[data-client-light]").forEach(function (light) {
      var next = status.lights[light.getAttribute("data-client-light")];
      if (!next || (light.className === next.className && light.title === next.status)) return;
      light.className = next.className;
      light.title = next.status;
      light.setAttribute("aria-label", next.status);
    });
    var card = document.querySelector('[data-setting="模型"]');
    if (!card) return;
    var banner = card.querySelector(".model-update");
    var holder = document.createElement("template");
    holder.innerHTML = status.restart;
    var updated = holder.content.firstElementChild;
    if (banner?.getAttribute("data-restart-clients") === updated?.getAttribute("data-restart-clients")) return;
    if (banner && updated) banner.replaceWith(updated);
    else if (banner) banner.remove();
    else if (updated) card.querySelector(".settings-actions").before(updated);
  }
  setTimeout(refreshModelStatus, 1000);
`;

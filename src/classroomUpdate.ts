import type { ClassroomAppView } from "./classroomApp";

export function classroomUpdateControl(view: ClassroomAppView, restart: string): string {
  const warning = [view.allowlistError, view.catalogError,
    view.catalog?.source === "local" ? "課程資源使用本機清單，尚未取得老師最新內容。" : undefined,
  ].filter(Boolean).join(" ");
  const escaped = warning.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
  return `<div class="classroom-update-control"><p><span data-classroom-update-status role="status" aria-live="polite" data-update-warning="${escaped}">課堂內容</span><small>模型・課程安裝・課程片段</small></p><form method="post" action="/reload"><button type="submit" aria-label="更新課堂內容"${view.commandRunning ? " disabled" : ""}>↻ 更新</button></form></div><div class="classroom-update-restart">${restart}</div>`;
}

export const classroomUpdateStyles = `
  .classroom-update-home { min-height: 208px; position: relative; }
  .classroom-update { display: flex; flex-direction: column; gap: 8px; }
  .classroom-update-home .connection-mascot { height: 144px; }
  .classroom-update-control { display: flex; align-items: center; gap: 12px; padding: 10px 14px; border: 1px solid var(--line); border-radius: 16px; background: var(--tile); color: var(--text); box-shadow: 0 4px 24px #0000000a; }
  .classroom-update-control p { margin: 0; flex: 1; min-width: 0; font-size: 13px; overflow-wrap: anywhere; }
  .classroom-update-control small { display: block; color: var(--muted); font-size: 11px; margin-top: 3px; }
  .classroom-update-control button { flex-shrink: 0; min-height: 40px; padding: 8px 16px; border: 0; border-radius: 24px; background: var(--accent); color: var(--on-accent); font: inherit; font-size: 13px; }
  .classroom-update-restart:empty { display: none; }
  body.has-classroom-update { padding-bottom: 200px; }
  .classroom-update.docked { position: fixed; z-index: 20; right: 24px; bottom: 22px; width: 288px; }
  .classroom-update.docked .connection-mascot { flex: none; width: 90px; height: 84px; min-height: 84px; margin-left: auto; overflow: visible; padding: 0; }
  .classroom-update.docked .mascot-traveler { width: 84px; max-width: none; left: 0; right: auto; bottom: -4px; animation: none; transform: none; }
  .classroom-update.docked .mascot-facing, .classroom-update.docked .mascot-logo, .classroom-update.docked .mascot-foot { animation: none; }
  .classroom-update.docked .mascot-pause { display: none; }
  .classroom-update.docked button.mascot-play { display: block; width: 136px; max-width: 100%; min-height: 0; padding: 0; border: 0; border-radius: 16px; background: transparent; color: inherit; }
  .classroom-update.docked .mascot-speech { position: absolute; right: 96px; bottom: 4px; width: 184px; }
  .classroom-update.docked button.mascot-speech-close { background: transparent; color: var(--muted); padding: 4px 0; border: 0; font: inherit; font-size: 11px; }
  @media (max-width: 640px) {
    body.has-classroom-update { padding-bottom: 240px; }
    .classroom-update.docked { left: 0; right: 0; bottom: 0; width: auto; gap: 0; padding: 4px 12px max(4px, env(safe-area-inset-bottom)); background: var(--tile); border-top: 1px solid var(--line); }
    .classroom-update.docked .connection-mascot { position: absolute; right: 16px; bottom: 100%; width: 88px; height: 88px; min-height: 88px; }
    .classroom-update.docked .mascot-traveler { width: 88px; }
    .classroom-update.docked .classroom-update-control { min-height: 52px; border: 0; border-radius: 0; padding: 0; box-shadow: none; }
    .classroom-update.docked .classroom-update-control small { display: none; }
    .classroom-update.docked .mascot-speech { right: 96px; width: min(184px, calc(100vw - 128px)); }
    .classroom-update.docked .classroom-update-restart { max-height: 25dvh; overflow: auto; padding-bottom: 4px; }
  }
`;

export const classroomUpdateScript = `
  var classroomUpdateDisabled = [];
  function returnClassroomUpdateHome() {
    var home = document.querySelector('.classroom-update-home');
    var companion = document.querySelector('.classroom-update');
    if (home && companion) { companion.classList.remove('docked'); home.appendChild(companion); }
  }
  function positionClassroomUpdate() {
    var card = document.querySelector('[data-setting="連線"]');
    var home = card?.querySelector('.classroom-update-home');
    var companion = document.querySelector('.classroom-update');
    document.body.classList.toggle('has-classroom-update', Boolean(companion));
    if (!home || !companion) return;
    // Portal out of the card's CSS container so fixed positioning uses the viewport.
    var docked = card.getBoundingClientRect().bottom < 24;
    if (docked !== companion.classList.contains('docked')) {
      var top = window.scrollY;
      if (docked) home.style.minHeight = Math.max(208, companion.offsetHeight) + 'px';
      companion.classList.toggle('docked', docked);
      (docked ? document.body : home).appendChild(companion);
      if (!docked) home.style.minHeight = '';
      window.scrollTo({ top: top, behavior: 'instant' });
    }
  }
  function classroomUpdateBusy(busy) {
    var companion = document.querySelector('.classroom-update');
    if (!companion) return;
    if (busy) {
      classroomUpdateDisabled = Array.from(companion.querySelectorAll('button'), function (button) {
        var previous = { button: button, disabled: button.disabled };
        button.disabled = true;
        return previous;
      });
    } else {
      classroomUpdateDisabled.forEach(function (previous) { previous.button.disabled = previous.disabled; });
      classroomUpdateDisabled = [];
    }
  }
  function classroomUpdateFeedback(message) {
    var companion = document.querySelector('.classroom-update');
    var status = companion?.querySelector('[data-classroom-update-status]');
    if (status) status.textContent = message || status.getAttribute('data-update-warning') || '課堂內容已更新。';
  }
  window.addEventListener('scroll', positionClassroomUpdate, { passive: true });
  window.addEventListener('resize', positionClassroomUpdate);
  positionClassroomUpdate();
`;

import type { ClassroomAppView } from "./classroomApp";

export function classroomUpdateControl(view: ClassroomAppView, restart: string): string {
  const warning = [view.allowlistError, view.catalogError,
    view.catalog?.source === "local" ? "課程資源使用本機清單，尚未取得老師最新內容。" : undefined,
  ].filter(Boolean).join(" ");
  const escaped = warning.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
  return `<div class="classroom-update-control"><p><span data-classroom-update-status data-update-warning="${escaped}">課堂內容</span><small>模型・課程安裝・課程片段</small></p><form method="post" action="/reload"><button type="submit" aria-label="更新課堂內容"${view.commandRunning ? " disabled" : ""}>↻ 更新</button></form></div><template data-classroom-restart>${restart}</template>`;
}

export const classroomUpdateStyles = `
  .classroom-update-home { min-height: 224px; padding-bottom: 16px; position: relative; }
  .classroom-update { display: flex; flex-direction: column; gap: 8px; }
  .classroom-update-home .connection-mascot { height: 144px; }
  .classroom-update-home .connection-mascot.mascot-speaking { height: auto; min-height: 144px; flex-basis: auto; padding: 12px 0 144px; overflow: visible; }
  .classroom-update-home .mascot-speaking .mascot-speech::after { top: auto; bottom: -7px; right: 48px; transform: rotate(135deg); }
  .classroom-update-control { display: flex; align-items: center; gap: 12px; padding: 10px 14px; border: 1px solid var(--line); border-radius: 16px; background: var(--tile); color: var(--text); box-shadow: 0 4px 24px #0000000a; }
  .classroom-update-control p { margin: 0; flex: 1; min-width: 0; font-size: 13px; overflow-wrap: anywhere; }
  .classroom-update-control small { display: block; color: var(--muted); font-size: 11px; margin-top: 3px; }
  .classroom-update-control button { flex-shrink: 0; min-height: 40px; padding: 8px 16px; border: 0; border-radius: 24px; background: var(--accent); color: var(--on-accent); font: inherit; font-size: 13px; }
  body.has-classroom-update { --classroom-update-bottom-gap: 24px; }
  body.has-classroom-update main { padding-bottom: var(--classroom-update-bottom-gap); }
  .classroom-update.docked { position: fixed; z-index: 20; right: 24px; bottom: var(--classroom-update-bottom-gap); width: 288px; }
  .classroom-update.docked .connection-mascot { flex: none; width: 90px; height: 84px; min-height: 84px; margin-left: auto; overflow: visible; padding: 0; }
  .classroom-update.docked .mascot-traveler { width: 84px; max-width: none; left: 0; right: auto; bottom: -4px; animation: none; transform: none; }
  .classroom-update.docked .mascot-facing, .classroom-update.docked .mascot-logo, .classroom-update.docked .mascot-foot { animation: none; }
  .classroom-update.docked .mascot-pause { display: none; }
  .classroom-update.docked button.mascot-play { display: block; width: 136px; max-width: 100%; min-height: 0; padding: 0; border: 0; border-radius: 16px; background: transparent; color: inherit; }
  .classroom-update.docked .mascot-speech { position: absolute; right: 96px; bottom: 4px; width: 184px; }
  .classroom-update.docked .mascot-quote { max-height: min(40dvh, 280px); overflow-y: auto; overflow-x: hidden; }
  .classroom-update.docked button.mascot-speech-close { background: transparent; color: var(--muted); padding: 4px 0; border: 0; font: inherit; font-size: 11px; }
  @media (max-width: 640px) {
    body.has-classroom-update main { padding-bottom: calc(72px + env(safe-area-inset-bottom, 0px)); }
    .classroom-update.docked { left: 0; right: 0; bottom: 0; width: auto; gap: 0; padding: 4px 12px max(4px, env(safe-area-inset-bottom)); background: var(--tile); border-top: 1px solid var(--line); }
    .classroom-update.docked .connection-mascot { position: absolute; right: 16px; bottom: 100%; width: 88px; height: 88px; min-height: 88px; }
    .classroom-update.docked .mascot-traveler { width: 88px; }
    .classroom-update.docked .classroom-update-control { min-height: 52px; border: 0; border-radius: 0; padding: 0; box-shadow: none; }
    .classroom-update.docked .classroom-update-control small { display: none; }
    .classroom-update.docked .mascot-speech { right: 96px; width: min(184px, calc(100vw - 128px)); }
  }
`;

export const classroomUpdateScript = `
  var classroomUpdateDisabled = [];
  var classroomRestartSeen = '';
  function showClassroomSpeech(message) {
    var stage = document.querySelector('.classroom-update .connection-mascot');
    if (!stage) return;
    stage.querySelector('.mascot-speech')?.remove();
    var speech = document.createElement('div');
    speech.className = 'mascot-speech';
    speech.setAttribute('role', 'status');
    speech.setAttribute('aria-live', 'polite');
    speech.setAttribute('data-classroom-speech', '');
    var quote = document.createElement('p');
    quote.className = 'mascot-quote';
    quote.textContent = message;
    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'mascot-speech-close';
    close.setAttribute('aria-label', '收起法鬥台詞');
    close.textContent = '知道啦';
    speech.append(quote, close);
    stage.prepend(speech);
    stage.classList.add('mascot-waiting', 'mascot-speaking');
    mascotSpeechDismissed = false;
  }
  function classroomRestartText() {
    return document.querySelector('[data-classroom-restart]')?.content.textContent.trim() || '';
  }
  function refreshClassroomRestart(html) {
    var source = document.querySelector('[data-classroom-restart]');
    if (!source) { classroomRestartSeen = ''; return; }
    if (typeof html === 'string') source.innerHTML = html;
    var message = classroomRestartText();
    if (message === classroomRestartSeen) {
      if (message && !mascotSpeechDismissed && !document.querySelector('.classroom-update .mascot-speech')) showClassroomSpeech(message);
      return;
    }
    classroomRestartSeen = message;
    if (message) showClassroomSpeech(message);
    else {
      var stage = document.querySelector('.classroom-update .connection-mascot');
      if (stage?.querySelector('[data-classroom-speech]') && !settingsBusy) hideMascotSpeech(stage);
    }
  }
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
    if (!status) return;
    var warning = status.getAttribute('data-update-warning');
    var result = message;
    if (!message) {
      classroomRestartSeen = classroomRestartText();
      result = warning ? '有些內容還沒追到，先別急著怪披風。' + warning + (classroomRestartSeen ? ' ' + classroomRestartSeen : '')
        : classroomRestartSeen || '課堂內容幫你更新好了，手速可以不用拿來爬回頁首了。';
    }
    showClassroomSpeech(result);
  }
  window.addEventListener('scroll', positionClassroomUpdate, { passive: true });
  window.addEventListener('resize', positionClassroomUpdate);
  positionClassroomUpdate();
  refreshClassroomRestart();
`;

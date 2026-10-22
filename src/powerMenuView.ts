// 側欄底部最右邊的電源鈕（原型 F）。只放 icon，點了先開面板說明後果，不會直接結束。
// 面板裡的「結束」是 /stop 表單；有管理 API 時由 lifecyclePage 換成生命週期按鈕並加上完整移除。

const POWER_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 3v8"/><path d="M6.3 6.8a8 8 0 1 0 11.4 0"/></svg>`;

export function powerMenu(version: string): string {
  return `<div class="power-menu"><button type="button" class="power-toggle" data-power-toggle aria-label="結束或移除 VansPod" title="結束 VansPod" aria-haspopup="dialog" aria-expanded="false" aria-controls="power-panel">${POWER_ICON}<span class="power-dot" aria-hidden="true"></span></button><div class="power-panel" id="power-panel" role="dialog" aria-label="結束 VansPod" hidden><div class="power-head"><span class="power-live" aria-hidden="true"></span><strong>VansPod ${version} 執行中</strong></div><p class="power-message" role="status" data-lifecycle-message></p><p class="power-note">下課時再結束。課堂連線會中斷，各工具設定恢復原狀；課堂資料保留，下次開啟可接續。</p><div class="power-confirm" data-power-confirm hidden></div><div class="power-actions"><button type="button" class="quiet" data-power-close>取消</button><form method="post" action="/stop"><button type="submit" class="power-stop">結束 VansPod</button></form></div><!-- /power-panel --></div></div>`;
}

export const POWER_MENU_STYLES = `
    .bar .side-foot { position: relative; }
    .power-menu { margin-left: auto; padding-left: 10px; border-left: 1px solid var(--line); display: flex; }
    .power-toggle { position: relative; display: grid; place-items: center; width: 2.75rem; height: 2.75rem; min-height: 2.75rem; flex: 0 0 auto; padding: 0; border-radius: 999px; border: 1px solid var(--line); background: transparent; color: var(--muted); cursor: pointer; }
    .power-toggle svg { width: 1.2rem; height: 1.2rem; }
    .power-toggle:hover, .power-toggle[aria-expanded="true"] { color: light-dark(#b91c1c, #f87171); border-color: light-dark(rgba(185, 28, 28, 0.35), rgba(248, 113, 113, 0.35)); background: light-dark(rgba(185, 28, 28, 0.05), rgba(248, 113, 113, 0.08)); }
    .power-toggle:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .power-dot { display: none; position: absolute; top: 3px; right: 3px; width: 8px; height: 8px; border-radius: 999px; background: #f59e0b; box-shadow: 0 0 0 2px var(--bg); }
    .power-toggle.has-message .power-dot { display: block; }
    .power-panel { position: absolute; left: 0; bottom: calc(100% + 10px); z-index: 50; width: min(300px, calc(100vw - 32px)); display: flex; flex-direction: column; gap: 10px; padding: 14px; border-radius: 14px; border: 1px solid var(--line); background: var(--tile); box-shadow: 0 16px 40px rgba(0, 0, 0, 0.25); color: var(--text); font-size: 13px; }
    .power-panel[hidden] { display: none; }
    .power-head { display: flex; align-items: center; gap: 8px; }
    .power-live { width: 8px; height: 8px; border-radius: 999px; background: light-dark(#10a37f, #4ecb9d); box-shadow: 0 0 0 3px light-dark(rgba(16, 163, 127, 0.15), rgba(78, 203, 157, 0.15)); }
    .power-note { color: var(--muted); line-height: 1.6; }
    .power-message:empty { display: none; }
    .power-message { padding: 10px 12px; border-radius: 10px; background: light-dark(#fff7ed, #3b3024); color: light-dark(#9a3412, #fed7aa); line-height: 1.6; white-space: pre-line; }
    .power-message.ok { background: light-dark(rgba(16, 163, 127, 0.10), rgba(78, 203, 157, 0.13)); color: light-dark(#0a7d5c, #4ecb9d); }
    .power-confirm { display: flex; flex-direction: column; gap: 10px; padding: 12px; border-radius: 10px; border: 1px solid light-dark(rgba(185, 28, 28, 0.30), rgba(248, 113, 113, 0.30)); background: light-dark(rgba(185, 28, 28, 0.04), rgba(248, 113, 113, 0.06)); line-height: 1.6; white-space: pre-line; }
    .power-confirm[hidden] { display: none; }
    .power-actions { display: flex; justify-content: flex-end; align-items: center; gap: 8px; flex-wrap: wrap; }
    .power-panel button, .power-dialog button { min-height: 34px; padding: 8px 16px; border-radius: 999px; border: 1px solid transparent; background: var(--accent); color: var(--on-accent); font-size: 13px; font-weight: 500; }
    .power-panel button.quiet, .power-dialog button.quiet { background: transparent; color: var(--text); border-color: var(--line); }
    .power-panel button.danger, .power-dialog button.danger { display: inline-flex; align-items: center; gap: 6px; background: light-dark(#b91c1c, #f87171); color: light-dark(#ffffff, #1c1c1e); }
    .power-dialog button.danger svg { width: 15px; height: 15px; }
    .power-panel .power-remove { width: 100%; min-height: 0; padding: 10px 0 0; border: 0; border-top: 1px solid var(--line); border-radius: 0; background: transparent; color: var(--muted); font-size: 12px; text-align: left; }
    .power-panel .power-remove:hover { color: light-dark(#b91c1c, #f87171); }
    .power-modal { position: fixed; inset: 0; z-index: 96; display: grid; place-items: center; padding: 24px; background: light-dark(rgba(20, 20, 20, 0.32), rgba(0, 0, 0, 0.52)); }
    .power-modal[hidden] { display: none; }
    .power-dialog { width: min(34rem, 100%); max-height: calc(100dvh - 48px); overflow: auto; display: flex; flex-direction: column; gap: 12px; padding: 18px; border-radius: 16px; border: 1px solid var(--line); background: var(--tile); color: var(--text); font-size: 13px; }
    .power-dialog > h3 { margin: 0; font-size: 18px; font-weight: 600; }
    .power-warn { padding: 10px 12px; border-radius: 10px; background: light-dark(#fff7ed, #3b3024); color: light-dark(#9a3412, #fed7aa); line-height: 1.6; }
    .power-split { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .power-split > div { padding: 10px 12px; border-radius: 10px; background: var(--input); }
    .power-split h4 { margin: 0 0 6px; font-size: 12px; font-weight: 600; }
    .power-split .drop h4 { color: light-dark(#b91c1c, #f87171); }
    .power-split .keep h4 { color: light-dark(#0a7d5c, #4ecb9d); }
    .power-split ul { margin: 0; padding-left: 18px; line-height: 1.7; }
    .power-paths summary { width: fit-content; cursor: pointer; color: var(--muted); font-size: 12px; }
    .power-paths pre { margin: 6px 0 0; padding: 10px 12px; border-radius: 8px; background: var(--input); font-size: 12px; line-height: 1.6; }
    @media (max-width: 40rem) { .power-split { grid-template-columns: 1fr; } }
    @media (max-width: 760px) { .power-panel { width: 100%; } }`;

/** 面板開關：點電源鈕切換，取消／Esc／點面板外關閉。完整移除的對話框開著時不收面板。 */
export const powerMenuScript = `
    (function () {
      var toggle = document.querySelector("[data-power-toggle]");
      var panel = document.getElementById("power-panel");
      if (!toggle || !panel) return;
      function setOpen(open) {
        panel.hidden = !open;
        toggle.setAttribute("aria-expanded", open ? "true" : "false");
        if (open) panel.querySelector("[data-power-close]").focus();
      }
      document.addEventListener("click", function (event) {
        var target = event.target;
        if (!target || !target.closest) return;
        if (target.closest("[data-power-toggle]")) { setOpen(panel.hidden); return; }
        if (target.closest("[data-power-close]")) { setOpen(false); toggle.focus(); return; }
        if (!panel.hidden && !target.closest(".power-menu") && !target.closest(".power-modal")) setOpen(false);
      });
      document.addEventListener("keydown", function (event) {
        if (event.key !== "Escape" || panel.hidden) return;
        var modal = document.querySelector(".power-modal");
        if (modal && !modal.hidden) return;
        setOpen(false);
        toggle.focus();
      });
    })();
  `;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ClassroomAppView } from "../classroomApp";
import { lifecyclePage } from "../lifecyclePage";
import { renderInspectorPage, renderPage } from "../page";

const view: ClassroomAppView = {
  connected: false,
  detail: "",
  canCopyKey: false,
  installAvailable: false,
  commandRunning: false,
  environmentInstalling: false,
  mode: "native",
  tools: [],
};

const pages = () => [
  lifecyclePage(renderPage(view), "token"),
  lifecyclePage(renderInspectorPage({ recording: false, captures: [], dropped: 0 }), "token"),
];
const panelOf = (html: string) => html.match(/<div class="power-panel"[^>]*>[\s\S]*?<!-- \/power-panel -->/)?.[0] ?? "";

describe("lifecycle controls in the power panel", () => {
  it("ends VansPod through the management API from the power panel, after 取消, on both pages", () => {
    for (const html of pages()) {
      assert.doesNotMatch(html, /action="\/stop"/);
      const panel = panelOf(html);
      const cancel = panel.indexOf("data-power-close");
      const stop = panel.search(/<button type="button"[^>]*data-lifecycle="stop"[^>]*>結束 VansPod<\/button>/);
      assert.ok(cancel !== -1 && stop > cancel);
    }
  });

  it("tucks 移除 VansPod under the panel as a secondary link that opens a hidden dialog", () => {
    for (const html of pages()) {
      const panel = panelOf(html);
      const open = (panel.match(/<div\b/g) ?? []).length - (panel.match(/<\/div>/g) ?? []).length;
      assert.equal(open, 1, "the link sits inside the still-open panel");
      assert.match(panel, /<button type="button" class="power-remove" data-lifecycle="uninstall">移除 VansPod…<\/button>/);
      const modal = html.match(/<div class="power-modal"[^>]*>[\s\S]*?<!-- \/power-modal -->/)?.[0] ?? "";
      assert.match(modal, /^<div class="power-modal" hidden>/);
      assert.match(modal, /role="dialog" aria-modal="true"/);
      assert.match(modal, /會刪除[\s\S]*課堂憑證[\s\S]*會保留[\s\S]*學生專案與作品/);
      assert.match(modal, /更新版本不需要移除/);
      const cancel = modal.indexOf("data-power-modal-close");
      const confirm = modal.indexOf('data-lifecycle-confirm="uninstall"');
      assert.ok(cancel !== -1 && confirm > cancel, "取消 comes before 確認移除");
    }
  });

  it("asks for confirmation inside the page instead of browser dialogs", () => {
    const base = renderPage(view);
    const added = lifecyclePage(base, "token").slice(base.indexOf("</body>"));
    assert.doesNotMatch(added, /window\.confirm/);
  });
});

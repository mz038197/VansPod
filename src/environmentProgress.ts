/**
 * 背景 Environment Install 的進度輪詢：頁面帶 data-environment-progress 時，每 500ms 讀 /environment-status
 * 更新每個工具的階段文字；安裝結束就重新整理頁面顯示結果。狀態在伺服器上，重新整理頁面後照樣接著輪詢。
 */
export const environmentProgressScript = `
  (function () {
    if (!document.querySelector("[data-environment-progress]")) return;
    async function poll() {
      try {
        var response = await fetch("/environment-status", { cache: "no-store" });
        if (!response.ok) throw new Error("status unavailable");
        var status = await response.json();
        if (!status.running) { window.location.reload(); return; }
        status.tools.forEach(function (tool) {
          document.querySelectorAll('[data-environment-stage="' + tool.id + '"]').forEach(function (stage) {
            stage.textContent = tool.stage;
          });
        });
      } catch (error) {}
      setTimeout(poll, 500);
    }
    setTimeout(poll, 500);
  })();
`;

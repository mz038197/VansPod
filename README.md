# VansPod

套件名稱為 `vanspod`。Windows 執行 `npm run dist` 後會產出 `dist/VansPod.exe`。

本機課堂 app。規格是 [classroom-one-click-install#8](https://github.com/mz038197/classroom-one-click-install/issues/8)。

不放進凡思課堂安裝擴充，也不從 opencodex fork。領域詞以該 repo 的 CONTEXT.md 為準。視窗決定見該 repo 的 ADR 0017。

```
npm test
npm start
```

`npm start` 在 Windows 開本機網頁、用系統瀏覽器打開，並在工作列放一顆圖示。再點圖示會打開同一個網址。關掉分頁不會結束這個行程。在啟動它的終端機按 Ctrl+C 才會結束。

## Classroom 上游 API

模型區提供各客戶端的上游 API 選項：Codex 可選 Responses／Chat，Claude Code 可選 Responses／Chat／Messages，兩者均預設 Responses。選擇保存在使用者目錄的 `.vanspod/settings.json`，與課堂憑證分開；重啟、切換模型、清除或重新兌換課堂不會移除偏好。此選項只影響 Classroom 模式的下一個請求。

共用 Adapter 介面下的三個實作負責請求、上游呼叫與回應轉換；所有程式都在 VansPod 內，不需要 opencodex 專案。支援多輪文字、圖片輸入、函式工具往返與串流／非串流；Chat 路徑沿用 Codex 自訂工具的文字包裝及 `apply_patch` 修復。

跨協定不能對等保留的資料會明確報錯，例如 Claude 的 thinking／簽章、工具結果的 `is_error`、快取控制或服務端工具，以及 Codex 的加密 reasoning、工具 namespace 或自訂 grammar 約束。原協定直通可保留其原有資料；轉換失敗不會自動換 adapter 重送。使用者取消或客戶端斷線會中止本機上游請求，串流缺少完成事件會回報失敗。

協定轉換參考官方 [Chat API](https://developers.openai.com/api/reference/resources/chat)、[Responses API](https://developers.openai.com/api/reference/resources/responses) 與 [Claude 串流事件](https://platform.claude.com/docs/en/build-with-claude/streaming)。

驗證指令：`npm run typecheck`、`npm test`、`npm run test:windows-exe`。Windows 驗證使用隔離設定與模擬 Router，涵蓋五條 JSON／SSE 路徑及偏好重啟保存；通過不表示實際 Router 或模型已完成端到端驗證。

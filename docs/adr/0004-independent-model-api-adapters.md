# VansPod 獨立提供可選的 Model API Adapter

VansPod 目前將 Codex 的 Responses 請求轉成 Chat 請求送往 Router，Claude Code 則沿用 Messages 路徑。為增加 Responses 上游支援，我們決定在 VansPod 內維護 Model API Adapter，並由使用者為 Codex 與 Claude Code 分別手動選擇；VansPod 必須保持獨立，不依賴 opencodex 專案。

**狀態：Q1～Q17 訪談已完成，設計已確認；使用者透過 implement skill 授權實作。** 記錄日期：2026-10-11。

## Decision

- VansPod 的建置、測試、打包與執行均不得依賴 opencodex；不匯入、連結或啟動該專案，也不要求它存在於開發或使用者電腦上。adapter 的實作與維護歸 VansPod 所有。
- 抽象邊界以 Router 上游協定為主：提供共用的 Adapter 介面，由 ChatAdapter、ResponsesAdapter 與 MessagesAdapter 各自實作。代理入口辨識客戶端後，透過該介面交付請求；具體 adapter 負責請求轉換、上游呼叫與回應轉換。
- ChatAdapter 內分別實作 Codex Responses ↔ Chat、Claude Code Messages ↔ Chat；ResponsesAdapter 內分別處理 Codex Responses ↔ Responses、Claude Code Messages ↔ Responses。Codex 與 Claude Code 共用上游 adapter 抽象，但各自的協定處理可以分開實作。
- 共用 Adapter 介面定義操作契約，不要求先將兩種客戶端轉成一套共用中間訊息格式。介面的具體型別及串流生命週期仍待設計。
- 保留 Codex 既有的 Responses ↔ Chat 轉換，增加 Responses 上游路徑：將 Codex 的 Responses 請求送往 Router `/v1/responses`，並回傳 Responses 串流。
- Claude Code 保留既有 Messages 上游路徑，增加 Chat 與 Responses 選項；這需要在 VansPod 內處理 Messages 與所選上游協定之間的轉換。
- Claude Code 既有 Messages 上游路徑由 MessagesAdapter 實作同一份 Adapter 介面，僅供 Claude Code 選用；本次不提供 Codex ↔ Messages 轉換。
- Codex 可選 Chat／Responses；Claude Code 可選 Messages／Chat／Responses。兩者各自選擇 Model API Adapter，與既有共用的 Model Switch 是不同概念。
- 現階段由使用者手動選擇，不依 Router 模型 metadata 自動選擇。選項先放在各客戶端的模型選單旁；未來可能移到 VansPod 的系統設定（Settings），這不是本次已承諾實作的範圍。
- 尚未選過 adapter 時，Codex 與 Claude Code 均預設 Responses。
- 保存各客戶端的 adapter 選擇；重啟 VansPod、切換模型或重新兌換課堂後仍保留，未來移至 Settings 時沿用同一份設定。
- adapter 選項僅影響 Classroom 模式。切換不改變正在進行中的請求，下一個請求才使用新選擇；Native 模式沿用原有行為。
- 所選上游協定不支援或請求失敗時，顯示失敗與原因，不自動切換其他 adapter 重送。
- 五條支援路徑均須涵蓋多輪文字、工具呼叫與工具結果回傳，以及串流／非串流回應；保留 Codex 既有自訂工具與 `apply_patch` 相容處理。
- 第一版支援 Codex 與 Claude Code 的圖片輸入，轉為上游協定接受的格式；此範圍不包含圖片生成、音訊或影片。
- 請求中的工具、內容或推理資料若無法由所選 adapter 正確表達，須明確報錯並說明原因，不得靜默刪除後繼續送出；能正確保留的內容應保留。
- 使用者取消、客戶端斷線或 VansPod 停止時，中止對應的上游請求並釋放串流資源。本機中止不保證上游立即停止計費；已回傳部分內容後發生錯誤，須回報失敗，不得標記為正常完成。

## Verification

- 使用本機模擬上游，驗證五條支援路徑的多輪文字、圖片、工具呼叫與結果、串流／非串流、取消及錯誤處理，並保留自訂工具與 `apply_patch` 的相容性覆蓋。
- 驗證兩個客戶端預設 Responses、各自保存選擇、跨重啟／切換模型／重新兌換課堂後保留、僅在 Classroom 模式使用，以及切換只影響後續請求。
- 驗證 Windows 打包結果。
- 實際 Router 的端到端驗證結果另列；本機模擬測試通過不代表真實模型或 Router 已驗證。

## Adapter structure

```text
代理入口（辨識 Codex／Claude Code）
    ↓
Adapter 共用介面
    ├─ ChatAdapter
    │   ├─ Codex Responses ↔ Chat
    │   └─ Claude Code Messages ↔ Chat
    ├─ ResponsesAdapter
    │   ├─ Codex Responses ↔ Responses
    │   └─ Claude Code Messages ↔ Responses
    └─ MessagesAdapter
        └─ Claude Code Messages ↔ Messages
    ↓
Router
```

MessagesAdapter 僅處理 Claude Code Messages ↔ Messages，保留既有上游路徑。兩個客戶端的手動選項各自獨立，但共用同一套 Adapter 介面及具體 adapter 實作。

## Trade-offs and consequences

直接依賴 opencodex 的 adapter 可沿用其現有能力，但違反 VansPod 必須獨立的專案邊界；選擇獨立實作後，協定轉換及相容性驗證由 VansPod 自行承擔。

現階段選擇手動設定，而非依 Router metadata 自動判定，意味著使用者需要選擇與模型相容的上游協定。此決策不表示 Router 原始模型資料一定缺乏協定資訊。

## Implementation

共用介面及三個 adapter 位於 `src/adapters/`；`src/modelProxy.ts` 處理代理交付與錯誤，`src/adapterSettings.ts` 將非敏感偏好保存在 `.vanspod/settings.json`，與 Classroom Connection 分開。`src/classroomApp.ts` 在請求選路時固定當次 adapter，設定切換不更動已開始的請求。

原協定路徑保留正文；跨協定轉換採明確支援範圍，不支援的欄位或內容會報錯。例如 Claude 的 thinking／簽章、工具錯誤標記、快取控制及服務端工具，或 Codex 的加密 reasoning、工具 namespace，不會靜默移除後重送。Chat 自訂工具將完整的 Lark／regex grammar 定義保留在 input schema 的描述中，作為模型指令，沿用 freeform／`apply_patch` 修復；這不代表 Chat 提供 Responses 原生 grammar 的受限解碼保證。

驗證結果須與實作分開判讀；本機模擬及 Windows 打包測試不代表真實 Router 或模型已驗證。

# VansPod 獨立提供可選的 Model API Adapter

VansPod 目前將 Codex 的 Responses 請求轉成 Chat 請求送往 Router，Claude Code 則沿用 Messages 路徑。為增加 Responses 上游支援，我們決定在 VansPod 內維護 Model API Adapter，並由使用者為 Codex 與 Claude Code 分別手動選擇；VansPod 必須保持獨立，不依賴 opencodex 專案。

**狀態：Q1～Q17 訪談已完成，設計已確認並授權實作；功能及本機／Windows 打包驗證已完成。** 記錄日期：2026-10-11。

## Decision

- VansPod 的建置、測試、打包與執行均不得依賴 opencodex；不匯入、連結或啟動該專案，也不要求它存在於開發或使用者電腦上。adapter 的實作與維護歸 VansPod 所有。
- 抽象邊界以 Router 上游協定為主：提供共用的 Adapter 介面，由 ChatAdapter、ResponsesAdapter 與 MessagesAdapter 各自實作。代理入口辨識客戶端後，透過該介面交付請求；具體 adapter 負責請求轉換、上游呼叫與回應轉換。
- ChatAdapter 內分別實作 Codex Responses ↔ Chat、Claude Code Messages ↔ Chat；ResponsesAdapter 內分別處理 Codex Responses ↔ Responses、Claude Code Messages ↔ Responses。Codex 與 Claude Code 共用上游 adapter 抽象，但各自的協定處理可以分開實作。
- 共用 Adapter 介面定義操作契約，不要求先將兩種客戶端轉成一套共用中間訊息格式。
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

Claude 的原協定路徑保留正文；跨協定轉換採明確支援範圍，不支援的欄位或內容會報錯。例如 Claude 的 thinking／簽章、工具錯誤標記、快取控制及服務端工具，或 Codex 傳給 Chat 的加密 reasoning，不會靜默移除後重送。

Codex 的相容處理位於 `src/codexWire/`。兩條上游路徑都將 `additional_tools` 提升為頂層工具宣告。Chat 將工具 namespace 轉為可逆的扁平名稱；依受支援的模型選項建立正文，不對整份客戶端正文套用頂層欄位白名單。`client_metadata`、`access_programs` 與未知客戶端頂層擴充不送給 Chat，也不阻擋請求；已知且無法保留的請求語意，以及工具、內容與推理資料，仍明確驗證。明文 reasoning 保留為 Responses reasoning 資料，`summary: none` 隱藏摘要而保留下一輪所需文字。Responses 移除已確認的 Codex 私有 `access_programs`，保留其他未知上游擴充欄位；將自訂工具宣告、工具選擇、呼叫歷史及配對結果一起降為 Router 接受的 function 格式，保留 `call_id`；回程則依客戶端原始宣告還原 namespace、自訂工具類型與原始輸入，修復一般 function 包裝及原生 custom 輸入包裝。

Chat 與 Responses 的自訂工具降級，都將完整的 Lark／regex grammar 定義保留在 input schema 的描述中，作為模型指令，沿用 freeform／`apply_patch` 修復；這不代表降級後仍提供 Responses 原生 grammar 的受限解碼保證。opencodex 僅作為程式行為參考，VansPod 不匯入或依賴該專案。

驗證結果須與實作分開判讀；本機模擬及 Windows 打包測試不代表真實 Router 或模型已驗證。

2026-10-11 驗證結果：`npm run typecheck` 通過；`npm test` 共 193 項全部通過；`npm run test:windows-exe` 在 Windows、Node.js v24.19.0 通過，涵蓋最新 EXE 的五條 JSON／SSE 路徑、adapter 偏好跨行程恢復及原有憑證生命週期。本次隔離環境已清理，真實使用者設定雜湊未改變。真實 Router／模型端到端驗證尚未執行。

code-review 的 Standards 軸最初提出 1 項重複驗證邏輯的維護建議，Spec 軸提出 5 項工具及截斷處理問題；修正與複查後兩軸均無未解決項目。首次 Windows 驗證在測試資料夾清理時失敗，後續增加清理重試與步驟診斷後完整通過；首次遺留的測試資料夾仍保留，手動清理曾被執行環境拒絕。

2026-10-11 Codex 相容性修正後：`npm run typecheck`、`npm test`（220 項）及 `npm run test:windows-exe` 全部通過。Windows EXE 覆蓋完整客戶端 metadata／模型選項正文，以及自訂工具呼叫與結果的兩輪回送；隔離環境已清理，真實使用者設定雜湊未改變。另以合成腳本及工具結果，對真實課堂 Router 的 `vcr-auto` 驗證 Chat／Responses、JSON／SSE 與 Responses 兩輪往返。這驗證請求及回應格式，不代表已由 Codex 執行真實 MCP 連接器操作。

本輪 code-review 的 Standards 軸提出 1 項遠端工具 grammar 保留問題，Spec 軸提出同一問題及 1 項工具識別歧義問題；補上 JSON／SSE 回歸測試、保留完整 namespace 身分並拒絕衝突宣告／歧義輸出後，兩軸複查均無剩餘項目。

2026-10-11 `access_programs` 修正：移除 Chat 整份客戶端正文的頂層白名單，改為選取支援的模型選項；不送出私有／未知客戶端頂層擴充，仍明確拒絕已知且無法保留的模型語意。Responses 僅剝除已確認的 `access_programs`。`npm test`（224 項）、型別檢查與最新版 Windows EXE 驗證通過，真實課堂 Router 的 Chat／Responses JSON／SSE 在帶有此欄位時皆完成。兩軸審查提出的 prompt／logprobs 語意遺失問題已改為明確報錯，複查無剩餘項目；仍未驗證 Codex 實際 MCP 操作。

2026-10-11 工具提示對齊：參照 opencodex 2.81.0（19bd34a）的 tool-catalog-nudge、responses-code-mode 與 exec 輸出契約，將提示實作於 VansPod 的 codexWire/tool-guidance。Chat 依實際送出的工具名稱追加工具目錄契約；Chat／Responses 在選中的工具含 builtin freeform exec、且沒有 builtin shell bridge 時，追加輸出與 host 契約及 exec input 描述。functions namespace 視為 Codex builtin，遠端同名工具不觸發 code mode；tool_choice=none 不追加目錄，forced／allowed 選擇限制可見工具。保留原始提示詞、訊息位置、grammar 描述及既有 Router 相容轉換，避免重複追加相同提示。這是工具提示行為對齊，不代表所有 adapter 封包或工具結果正規化已逐字複製 opencodex；VansPod 不依賴該專案。

本次驗證：完整測試 230 項與型別檢查通過；最後介面簡化後 65 項轉接相關測試再次通過。Windows EXE 的五條 JSON／SSE 路徑、偏好恢復與憑證生命週期驗證通過，真實使用者設定雜湊不變。離線執行同版 opencodex 與 VansPod 的三組對照輸入，Responses instructions 在純文字、inline 及頂層工具樣本逐字一致；Chat 工具樣本均包含目錄、echo 與 host 契約。規範／需求兩軸審查均無剩餘項目。未在本輪驗證真實課堂模型或 Codex 實際 MCP 執行，不能以提示對齊宣稱 aborted 已修復。

2026-10-11 reasoning.context 相容修正：Chat 的 reasoning 設定改依 opencodex reasoningConfigSchema/parser 選取 effort、summary，不再對整個設定物件套用白名單；context 與未知 reasoning 設定擴充不轉送給 Chat，也不阻擋請求。這不是將 context 內容映射成模型指令；原始請求不修改，input 的推理歷史、加密資料及 summary 設定仍依既有支援範圍驗證。回歸測試由相同的「Chat reasoning 無法轉換欄位 context」400 轉為 JSON／SSE 完成；Windows EXE 測試正文加入相同欄位。

此修正驗證：完整 232 項測試、型別檢查及帶 reasoning.context 的 Windows EXE JSON／SSE 與生命週期測試全部通過；真實使用者設定雜湊未改變。直接執行本機 opencodex reasoningConfigSchema，以同一合成設定確認只保留 effort/summary。規範與需求兩軸審查無剩餘項目；尚未取得使用者實際 context 值，也未在本輪驗證真實課堂模型／MCP 操作。

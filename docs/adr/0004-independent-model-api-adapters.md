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
- Codex 可選 Chat／Responses；Claude Code 可選 Messages／Chat／Responses。兩者各自選擇 Model API Adapter，與 Model Switch 是不同概念。
- Model Switch 現在由 Codex、Claude Code 各自選擇 Native／Classroom，可使用混合模式。只有該客戶端在 Classroom 時才能變更 adapter；各自模式隨 Classroom Connection 保存。舊版共用模式恢復為兩者相同模式，清除連線或課堂清單失效時兩者回到 Native。
- 模型卡片共用展示 Router 回傳的 Session Model Allowlist；它是允許清單，不是客戶端當前所選模型。偵測燈號表示 CLI 或 Codex 桌面程式被偵測到，不表示模型 API 連通。
- 現階段由使用者手動選擇，不依 Router 模型 metadata 自動選擇。選項先放在各客戶端的模型選單旁；未來可能移到 VansPod 的系統設定（Settings），這不是本次已承諾實作的範圍。
- 尚未選過 adapter 時，Codex 與 Claude Code 均預設 Responses。
- 保存各客戶端的 adapter 選擇；重啟 VansPod、切換模型或重新兌換課堂後仍保留，未來移至 Settings 時沿用同一份設定。
- adapter 選項僅影響 Classroom 模式。切換不改變正在進行中的請求，下一個請求才使用新選擇；Native 模式沿用原有行為。
- 所選上游協定不支援或請求失敗時，顯示失敗與原因，不自動切換其他 adapter 重送。
- 五條支援路徑均須涵蓋多輪文字、工具呼叫與工具結果回傳，以及串流／非串流回應；保留 Codex 既有自訂工具與 `apply_patch` 相容處理。
- 第一版支援 Codex 與 Claude Code 的圖片輸入，轉為上游協定接受的格式；此範圍不包含圖片生成、音訊或影片。
- 請求中的工具、內容或推理資料若無法由所選 adapter 正確表達，須明確報錯並說明原因，不得靜默刪除後繼續送出（Codex → Chat 的輸入歷史自 2026-10-11 起有明列的例外，見文末記錄）；能正確保留的內容應保留。
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

Claude 的原協定路徑保留正文；跨協定轉換採明確支援範圍，不支援的欄位或內容會報錯。例如 Claude 的 thinking／簽章、工具錯誤標記、快取控制及服務端工具，不會靜默移除後重送。例外見下方 2026-10-11 與 2026-10-12 的 Codex → Chat 輸入歷史記錄，以及 2026-10-13 的 Claude Code 記錄。

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

2026-10-11 Codex → Chat 輸入歷史相容修正：對照 opencodex 的 Responses parser（`src/responses/schema.ts`、`parser.ts`）。message 項目的 `phase` 與 `internal_chat_message_metadata_passthrough` 屬於客戶端 metadata，不轉送給 Chat，也不阻擋請求。reasoning 項目接受 `encrypted_content`，`summary` 改為選填：明文 summary／content 照舊回放；原生加密內容對 Chat 上游不透明，只帶加密內容的項目直接略過，不產生訊息，也不由密文推導明文。這是對「加密 reasoning 必須報錯」原決策的調整，原因是在 Responses 上游或 Native 產生的歷史，切到 Chat 後會讓每一輪都被 400 擋下。VansPod 不解 opencodex 自有的 ocxr1 信封；內容區塊的未知欄位仍明確報錯。

同日後續調整（使用者決定；其中「仍明確報錯」的範圍已由 2026-10-12 的記錄再放寬）：Codex → Chat 的輸入項目改為與 opencodex 相同的「只取用認得的欄位」。message、reasoning、工具呼叫、工具結果及裸文字項目不再套用項目層級欄位白名單；未知的項目層級欄位不轉送給 Chat，也不阻擋請求。這在項目層級放寬了「無法表達就報錯」原則。仍明確報錯的範圍：未知的項目類型與 message role、內容區塊與 reasoning summary／content 區塊的未知欄位或類型、工具宣告、tool_choice、`additional_tools` 及已知無法保留的頂層請求語意。Responses 上游路徑與 Claude 路徑不變。

2026-10-11 工具結果圖片修正：Codex → Chat 原本把工具結果裡的圖片（例如 `view_image`）直接放進 `role: "tool"` 訊息的 content 陣列。Chat 的 tool 訊息只接受文字，模型看不到圖片而反覆重讀。比照 opencodex `openai-chat/messages.ts`：tool 訊息只保留文字（沒有文字時為 `[image]`），圖片改放在該批工具結果之後的一則 user 訊息。完整 245 項測試通過；尚未以真實課堂 Router／模型驗證迴圈已消失。

2026-10-11 真實 Router 圖片驗證（`vcr-auto`，同一張 JPEG、非串流）：經 VansPod 的 Responses adapter，使用者附圖與工具結果附圖模型都能正確描述；經 Chat adapter 兩者都回答看不到圖片。直接呼叫 Router `/v1/chat/completions` 測試 `image_url` 物件（有無 `detail`）、字串形式、圖片在前、Anthropic image 區塊及遠端 https 圖片，全部看不到，且 `prompt_tokens` 固定約 52，與有無圖片無關；串流回應帶有 `system_fingerprint: fp_ollama`。結論：VansPod 送出的 Chat 圖片格式正確，圖片是在 Router 的 Chat 路徑被丟棄。Chat 的工具結果圖片搬移與 `detail: original → high` 兩項修正仍保留，但在 Router 修正前無法讓 Chat 看圖。

2026-10-12 Codex → Chat 輸入歷史再對齊 opencodex（使用者決定）：未知的輸入項目類型（含 `web_search_call`）改為略過；`compaction`／`compaction_summary`／`context_compaction` 轉成一則 user 訊息，內容為固定說明，因為密文只有產生它的後端能解讀，沒有 payload 的 `context_compaction` 只是標記而略過；`agent_message` 轉成 user 訊息；內容區塊與 reasoning summary／content 區塊的未知欄位剝除；工具結果裡的 `encrypted_content` 區塊換成文字 `[encrypted content omitted]`。已知代價：壓縮前的脈絡與搜尋結果模型實際上看不到，對話可以繼續但不會有錯誤提示。仍明確報錯：`input_file`／`input_audio`／`input_video` 等 Chat 無法承載的內容類型、非空的文字 annotations、`local_shell_call`／`tool_search_call`／`tool_search_output`（會留下 Chat 無法配對的工具呼叫或結果）、未知的 message role、工具宣告與 `additional_tools`。reasoning 的位置與格式、非 JSON arguments 的包裝方式維持 VansPod 原有行為。完整 246 項測試通過；Windows EXE 與真實 Router 未重跑。

2026-10-12 Codex 內建網路搜尋：Codex 的 `web__run` 對模型 base URL 發出 `POST /v1/alpha/search`（依 opencodex 的處理推斷，尚未在 VansPod 實際攔到請求確認）。課堂 Router 沒有搜尋後端，VansPod 也不轉給個人 ChatGPT，因此課堂模式維持不支援，但改回明確的 400 訊息，告知模型不要重試；其他不支援的路徑則在訊息中附上實際路徑。由 Router 提供搜尋端點、或轉給學生自己的 ChatGPT，是尚未決定的後續選項。

2026-10-12 Codex → Chat reasoning 回放格式修正：先前把歷史 reasoning 以 `<reasoning>…</reasoning>` 包成一則 assistant content 回放，模型看到自己過去的回合長這樣，就在可見回答裡照樣輸出 `<reasoning>` 區塊，推理內容因此外洩到對話畫面。改為掛在其後第一則 assistant 訊息（文字或工具呼叫）的 `reasoning_content` 欄位，不再寫入 content；其後沒有 assistant 訊息的 reasoning（例如出現在最終回答之後）直接略過。這取代上一則「reasoning 的位置與格式維持 VansPod 原有行為」。已知風險：嚴格拒絕未知訊息欄位的上游可能不接受 `reasoning_content`，尚未對真實 Router 驗證。完整 247 項測試通過；Windows EXE 與真實 Router 未重跑。

2026-10-13 Claude Code → Chat／Responses 相容修正：實際的 Claude Code 2.1.296 主對話請求一送出就被「Claude → responses 無法轉換欄位 context_management」400 擋下。以本機記錄用假伺服器擷取真實請求（含一輪工具呼叫與結果）後確認，同一份請求還帶有 `thinking: { type: "adaptive", display: "omitted" }`、system／文字／工具呼叫／工具結果上的 `cache_control`、`role: "system"` 的對話中訊息，以及 `tool_result.is_error`；這些原本全部報錯，所以 Claude Code 的跨協定路徑實際上無法使用。這是對上方「thinking、工具錯誤標記、快取控制不會靜默移除」的調整：

- `context_management` 與 `thinking` 設定接受但不轉送。前者是 Anthropic 伺服器端的脈絡編輯，後者的推理深度已由 `output_config.effort` 轉成上游的 reasoning 設定。
- `cache_control` 只是快取提示，不影響模型輸出，接受後不轉送。
- `role: "system"` 的訊息留在原本的對話位置：Chat 沿用 `system`，Responses 改為 `developer`。
- `tool_result.is_error` 不再報錯，改在工具結果前加上文字標記，讓模型仍看得到這次呼叫失敗。
- 上游回傳的 reasoning（Responses 的 reasoning 項目與事件、Chat 的 `reasoning_content`）不再讓回應失敗；其處理方式見下方同日的 reasoning 回放記錄。

同日對照 opencodex 2.81.0（19bd34a）的 `src/claude/inbound.ts`、`inbound-content-options.ts`、`compatibility.ts`，以下做法與它一致或依它調整；VansPod 仍不匯入或依賴該專案：

- 對話中的 system 訊息在 Responses 用 `developer`：opencodex 記錄 ChatGPT 後端會以「System messages are not allowed」拒絕 input 中的 `system`。
- 工具宣告未指定 `strict` 時，Responses 明確送出 `strict: false`。Responses 把省略視為 strict 模式，會把選填參數變成必填。
- `metadata.user_id` 超過 64 字元時改送其 SHA-256；Claude Code 的值是一段 JSON，OpenAI 類上游會拒絕超過 64 字元的 `user`。
- system 開頭的 `x-anthropic-billing-header:` 那一行不送給模型。
- Responses 正文加上 `store: false`。
- 沒有 `output_config.effort` 而 `thinking` 為 `enabled` 時，`budget_tokens` 依 4096／16384 分級為 low／medium／high，不直接轉送。
- 工具錯誤標記的格式為 `[tool error] <內容>`。

同日後續調整（使用者決定）：Claude Code → Chat／Responses 改為與 opencodex 相同的「只取用認得的欄位」，移除這條路徑上所有的欄位白名單。未知的頂層欄位、訊息／內容區塊／工具宣告／`tool_choice`／`thinking`／`metadata` 上的未知欄位，以及未知的內容類型（含工具結果與 system 內的）都不轉送，也不阻擋請求。這進一步放寬「無法表達就報錯」原則，理由與 Codex → Chat 相同：Claude Code 每個版本都會增加欄位，白名單會讓每一輪都被 400 擋下。已知代價：被略過的內容模型看不到，也不會有錯誤提示。

同日 reasoning 回放（使用者決定，實作於 `src/adapters/claude-reasoning.ts`）：沒有回放時，推理模型在工具呼叫迴圈的每一輪都看不到自己先前的推理。實測 Claude Code 2.1.296 會把收到的 thinking 區塊連同 signature 原樣放回下一輪請求，包含 thinking 文字為空的區塊，因此以 signature 作為載體：

- 請求的 `thinking` 為 `enabled`／`adaptive` 時才啟用；否則維持略過上游 reasoning，不回傳 thinking 區塊。
- Responses：請求加上 `include: ["reasoning.encrypted_content"]`；上游的 reasoning 項目轉成 thinking 區塊，signature 為 `vpr1.` 加上 base64url 的 JSON，內含該項目回送時需要的欄位（`id`、`summary`、`content`、`encrypted_content`）。下一輪在原位置還原成同一個 reasoning 輸入項目。串流時在 `response.output_item.done` 一次送出整個區塊，因為加密內容到那時才完整；沒有文字也沒有加密內容的項目不產生區塊。
- Chat：`reasoning_content`／`reasoning` 轉成只帶文字的 thinking 區塊，下一輪掛回同一則 assistant 訊息的 `reasoning_content`，與 Codex → Chat 的回放格式相同。
- `display: "omitted"` 時 thinking 文字留空，內容只放在 signature；否則顯示文字，且 Responses 另送 `reasoning.summary: "auto"`。
- 跨 adapter：Responses 產生的區塊送到 Chat 時以其文字回放；Chat 產生的區塊沒有 Responses 項目，送到 Responses 時略過。
- signature 由客戶端送回，內容不可信：回放時只接受 `type: "reasoning"` 的項目，且只取用上述欄位；其他類型視為回放資料損毀而報錯。
- 這是 VansPod 自有格式，不讀 opencodex 的 ocxr1 信封。opencodex 經 Claude Code 往返時只保留推理文字，VansPod 連同上游的加密內容一起保留。

2026-10-13 reasoning 回放的防護（GitHub #31）：回放的內容留在對話歷史裡，上游一旦拒絕其中一項，之後每一輪都會失敗，學生只能清除對話。以下防護都還沒有在真實 Router 上重現過對應的失敗，是依程式碼推斷預先加上的。

- signature 記錄產生它的模型，推理文字不再另存一份（文字可由項目取得）。Responses 只把 reasoning 項目回放給同一個模型；沒有記錄模型的舊 signature 照舊回放。Chat 回放的是文字，不受模型限制。
- Responses 的 reasoning 項目只在同一則 assistant 訊息內、其後還有文字或工具呼叫時才送出；後面沒有輸出的項目不送，因為上游要求 reasoning 項目後面緊跟它對應的輸出。
- 上游以 400 或 422 拒絕 Claude Code 的 Chat／Responses 請求時，去掉回放加進去的內容（reasoning 項目、`include`、`reasoning.summary`、`reasoning_content`）重送一次。重送成功就用它的回應；重送也失敗，回傳第一次的錯誤。沒有東西可去掉時不重送。代價：拒絕 `include` 的模型每個請求都會多送一次，且該模型實際上沒有回放。
- Messages adapter 送出前移除 signature 為 `vpr1.` 的 thinking 區塊，因為 Anthropic 格式的上游會把它當成無效簽章。
- 串流時沒有 `id` 的 reasoning 項目改以輸出位置區分，不再只留第一個。

沒有處理、接受現狀的：切回 Native 後續接舊對話時，請求不經 VansPod，`vpr1.` 區塊會直接送到 Anthropic；每一輪的加密內容仍留在歷史並重送；`display: "omitted"` 時推理內容仍以 base64 存在 signature，會寫進 Claude Code 的本機對話紀錄。

驗證：以真實 Claude Code CLI 經建置後的 Responses adapter 連到本機假上游，第一輪回傳 reasoning 與工具呼叫，第二輪上游收到的 input 在工具呼叫之前帶有相同的 reasoning 項目（id、summary、encrypted_content 都一致）。

與 opencodex 仍不同之處：它將 `thinking: disabled` 轉成 `effort: "none"`、送出 `prompt_cache_key`，並在後段依模型目錄修正 effort，VansPod 沒有這一層，所以都不送；它把 `stop_sequences` 轉成 Responses 的 `stop`，VansPod 仍報錯；它回放帶 Anthropic 簽章的 thinking 區塊、丟棄沒有對應的伺服器端工具，VansPod 兩者都報錯。

仍明確報錯：signature 不是 VansPod 產生的 thinking 區塊與 redacted_thinking 區塊（在 Messages adapter 或 Native 產生過 thinking 的對話切到 Chat／Responses 會被擋下）、沒有 `input_schema` 的伺服器端工具（網路搜尋已先由 `claudeWebSearch` 改寫）、未知的 message role、`tool_choice` 類型與圖片 source 類型、Responses 的 `stop_sequences`。完整 354 項測試通過，擷取到的真實請求都能轉成 Chat 與 Responses 正文；Windows EXE 與真實 Router／模型尚未驗證：Router 是否接受 `include`、是否回傳 reasoning 項目或加密內容、是否接受回送的 reasoning 項目與 Chat 的 `reasoning_content`，以及 `effort` 的 `xhigh`／`max`，都未確認。

# 搜尋請求樣本擷取（GitHub #23）

本文件說明如何用 VansPod 內建的暫時性紀錄功能，取得 Codex 與 Claude Code 在 Classroom 模式實際送出的搜尋請求。樣本要由人操作真實客戶端取得；這裡只有程序，還沒有任何樣本或結果。

## 紀錄功能

- 預設關閉。只有啟動 VansPod 的行程帶有環境變數 `CLASSROOM_APP_CAPTURE_SEARCH_DIR`（值為一個資料夾路徑）時才會寫檔；沒有設定或值為空時，不寫任何東西。沒有畫面開關，也不會記住設定。
- 開啟後，Codex 或 Claude Code 的 Client Route 處於 Classroom 模式時，每收到一個符合的請求，就在該資料夾寫一個 JSON 檔，檔名為 `<毫秒時間>-<序號>-<codex|claude>.json`，內容是 `{ client, method, path, body }`。`path` 是客戶端實際送出的路徑，含 query string。
- 會被記錄的請求只有兩種：
  - Codex 送到 `/alpha/search` 的請求，不論是哪個指令（`search_query`、開網頁、股價……）。
  - Claude Code 送到 `/messages`、且 `tools` 內宣告了 Anthropic 伺服器端搜尋工具（`type` 以 `web_search` 開頭）的請求。其他 Claude Code 請求不記錄。
- 紀錄發生在 VansPod 收到請求的當下，早於模型允許清單的檢查。Claude Code 的搜尋請求若指定了不在 Session Model Allowlist 的模型，VansPod 照舊回 409，但請求仍會被記錄。
- 紀錄不改變客戶端拿到的回應：Codex 搜尋得到 #22 的拒絕訊息（不論正文有沒有 `model`），Claude Code 請求照原本的方式處理。寫檔失敗、或讀不到 Classroom API Key 時，靜默略過、不寫檔。

### 自動去除的範圍

- 請求標頭一律不寫入檔案。
- Classroom API Key，以及客戶端在憑證類標頭（名稱含 authorization、api-key、cookie、token）送來的值，如果又出現在路徑或正文裡，會換成 `[redacted]`。標頭值會拆開比對：`Bearer xxx` 的 `xxx`、`a=1; b=2` 的每個 cookie 值都各自處理。比對的形式有三種：原文、URL 編碼、JSON 跳脫；正文是 JSON 時先解析再比對，所以 JSON 的寫法不影響結果。
- 拆出來不到 8 個字元的片段不個別比對（否則 cookie `a=1` 會把樣本裡所有的 `1` 都換掉）。
- **偵測不到的**：以其他方式編碼的憑證（例如 base64）、沒有出現在上述標頭裡的憑證、以及學生貼在對話或檔案內容裡的任何金鑰或密碼。這些都會原樣留在檔案裡，必須依「拿到樣本之後」逐檔人工檢查。

正文是完整的請求內容。Claude Code 的樣本會帶有整段 system prompt、對話、工作目錄路徑與 `metadata.user_id` 之類的識別資訊；這些不是憑證，不會被自動去除。

## 程序

1. 完全退出正在執行的 VansPod（含系統匣），否則新行程搶不到連接埠。
2. 在 repo 根目錄用 PowerShell 啟動，資料夾選在 repo 之外：

   ```powershell
   $env:CLASSROOM_APP_CAPTURE_SEARCH_DIR = "$env:TEMP\vanspod-search-capture"
   npm start
   ```

   用打包好的 `VansPod.exe` 也可以，只要從設好這個環境變數的 shell 啟動它。
3. 確認 Classroom Connection 已載入，把 Codex 與 Claude Code 的 Client Route 切到 Classroom。
4. Codex：請它搜尋一個即時問題（例如「搜尋台中近期活動」），取得 `search_query` 樣本。再引導它使用搜尋工具的其他指令至少一個（例如開啟某個網址、查股價或天氣）。資料夾裡有沒有對應的 `-codex.json`，就回答了「其他指令是否走同一個路徑」。
5. Claude Code：請它用 WebSearch 搜尋一個問題。確認資料夾出現 `-claude.json`（即使畫面顯示模型不在課堂允許清單也會有），且 `body.tools` 內有搜尋工具宣告與 `max_uses`。同時記下 Claude Code 畫面上實際發生的事（錯誤訊息、是否重試、是否改用別的工具），這是 #23 要求的實測紀錄。
6. 關閉 VansPod，並移除環境變數（關掉該 PowerShell 視窗，或 `Remove-Item Env:CLASSROOM_APP_CAPTURE_SEARCH_DIR`）。把兩個 Client Route 切回原本的狀態。

## 拿到樣本之後

- 逐檔檢查沒有金鑰或個人資料，再去識別：刪掉或換掉使用者名稱、本機路徑、`metadata`、與搜尋無關的對話與 system prompt。保留搜尋相關的結構原樣（Codex 的 `commands`、Claude Code 的搜尋工具宣告與 `max_uses`）。
- 去識別後的樣本存成測試 fixture，供 #27（Codex 翻譯）與 #28（Claude Code 搜尋迴圈）使用。原始擷取檔不要提交，用完刪除。
- 真實格式若與 #21 的假設不同（路徑、`commands.search_query` 的形狀、回應信封、Claude Code 的工具宣告），在 #21 留言說明差異。
- 這個紀錄功能是暫時的診斷工具，樣本確認足夠後在後續 ticket 整個移除。要刪的地方：
  - `src/searchRequestCapture.ts`（整個檔案）。
  - `src/test/searchRequestCapture.test.ts`（整個檔案），以及 `package.json` 的 `test` 指令裡的 `dist/test/searchRequestCapture.test.js`。
  - `src/start.ts`：`captureSearchRequest` 的 import，以及 Client Route 請求處理中標著「Temporary #23 diagnostic」的那一段（讀取 `CLASSROOM_APP_CAPTURE_SEARCH_DIR` 並呼叫 `captureSearchRequest`）。為了取得金鑰而提出來的 `const storage` 可以留著。
  - 本文件。
  - 不要刪：`src/modelProxy.ts` 的 `isCodexSearch`，拒絕訊息與模型允許清單的檢查都在用。

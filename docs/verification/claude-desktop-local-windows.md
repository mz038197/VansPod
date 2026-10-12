# Claude Desktop Code Local Windows 驗收

本文件記錄 GitHub #20 的隔離實機驗收。它只判斷 Claude Code Client Route 是否能納入 Windows Claude Desktop 的新建 Code Local session；一般 Chat、Cloud、SSH、WSL 與 Cowork 不在路由範圍。驗收不使用本機 CA、TLS 攔截、官方 cookie proxy、內部 picker 改寫或內建模型別名冒充。

## 公開支援邊界

Claude Code 官方文件支援以 `~/.claude/settings.json` 的 `env.ANTHROPIC_BASE_URL` 連到 LLM gateway；Windows Claude Desktop 官方 deep link `claude://code/new` 可開啟新的 Code session。官方 gateway 文件同時說明 Anthropic 不支援透過 gateway 將 Claude Code 路由到非 Claude 模型，且未承諾 Desktop Code model picker 會從任意 gateway `/v1/models` 發現模型。因此 CLI 的 gateway 成功不等於 Desktop Local 通過，必須逐項觀察下列 Desktop 行為。

參考：

- <https://code.claude.com/docs/en/llm-gateway>
- <https://support.claude.com/en/articles/14729294-open-claude-desktop-with-a-link>
- <https://support.claude.com/en/articles/11940350-claude-code-model-configuration>

## 測試環境與乾淨起點

2026-10-13（Asia/Taipei）盤點及執行：

- Windows 10 Pro，build `26300`，x64。
- Claude Desktop `2.31226.1.0`，安裝於 Microsoft Store package `Claude_2.31226.1.0_x64__pzs8sxrjxfjjc`。
- 全域 Claude Code CLI `2.1.296`。
- Claude Desktop 下載的 Code worker `2.1.295`。
- VansPod 基準為 `75808f3`（`issue-11-client-routes` 合併 #19 後）。
- `127.0.0.1:47821`、`:47822`、`:47823` 均無 listener。
- `~/.claude/settings.json` 是有效 JSON，沒有 root 或 `env` 中的 `ANTHROPIC_BASE_URL`；盤點時 SHA-256 為 `EE051BAFB1AFE29F24C06A7FE0741426E1784E00BAA5E5F7032830D1B07A19B2`。只記錄雜湊、欄位存在性與檔案大小，不記錄設定內容或憑證。
- VansPod 的受保護 Classroom Connection 已存在；沒有讀取、解密或輸出 Classroom API Key。
- 第一次盤點時 Claude Desktop 有主 app 與五個既有 Desktop Code worker。取得使用者明確同意關閉及重開後，使用者先正常退出；`2026-10-13T00:04:34+08:00` 再確認 Desktop app 與 Desktop Code worker 均為 0，形成乾淨 Desktop 起點。
- UI 原始碼仍顯示 `Claude Code CLI`；本次結果通過全部準則前不得改名。

## 可重跑程序

1. 完全退出 Claude Desktop，確認沒有 Store package 的 `Claude.exe` 或 `%APPDATA%\Claude\claude-code\*\claude.exe`。
2. 再次確認三個預設 loopback port 沒有 listener，並只以雜湊與布林欄位記錄 Claude 設定起點。
3. 啟動這個基準建置的 VansPod，確認既有 Classroom Connection 與 Session Model Allowlist 正常載入；不要列印 connection 檔案或 API Key。
4. 將 Claude Code Client Route 切到 Classroom。只接受 VansPod 寫入 `env.ANTHROPIC_BASE_URL=http://127.0.0.1:47822` 的正式 gateway 設定與該 listener 的 `/v1/models`、Messages API；不增加其他攔截層。
5. 完全新開 Claude Desktop，再以 `claude://code/new?folder=<URL-encoded-folder>` 建立 Code Local session。由使用者確認資料夾。
6. 在 Desktop Code 的 model picker 觀察 Session Model Allowlist 中的真實 classroom model ID。若模型沒有顯示，立即記為失敗；不得改寫 picker 或套用 Sonnet／Opus 假名。
7. 選取一個 classroom model 並送出不含敏感資料的唯一字串。以 `47822` listener 的成功請求與 Router 成功回應為必要證據；不得用 CLI request 代替 Desktop request。
8. 另外建立普通 Desktop Chat，送出另一個唯一字串。確認該動作沒有連到 `127.0.0.1:47822`，也沒有出現在 VansPod Router capture；普通 Chat 應維持官方連線。
9. 在 VansPod 將 Claude Code Client Route 切回 Native，確認 journal 成功恢復個人設定且 `ANTHROPIC_BASE_URL` 消失。
10. 完全退出並重開 Claude Desktop，再建立新的 Code Local session。確認它回到官方 model 行為；再次確認普通 Chat 未受影響。
11. 比對前後設定的 VansPod-owned 欄位、journal 狀態與憑證掃描。任何失敗都維持 CLI-only，不嘗試不受支援的替代方式。

## 結果

結果為 **未通過，維持 CLI-only**。共執行兩次，沒有安全或受支援的下一步可繞過。

### 第一次：Allowlist 前置條件阻擋

1. 從上述乾淨 Desktop 起點啟動整合基準的 VansPod。三個正式 listener 分別在 `127.0.0.1:47821`、`:47822`、`:47823` 正常監聽，Codex、Claude Code CLI、VS Code 三路均顯示可用。
2. 受保護的 Classroom Connection 能恢復，但 Session Model Allowlist 為 0。按 Reload 後 VansPod 明確回報「重新載入課堂模型失敗，已保留上次成功的模型清單」，而上次成功清單也是空的。
3. Router origin 可連通（未帶憑證的 `HEAD` 回覆 HTTP 405，而不是 DNS、TLS 或連線失敗）；Claude listener 的 `GET /v1/models` 回覆 HTTP 200，但 `data` 為 0 筆。驗證沒有讀取或輸出 Classroom API Key，也沒有直接帶憑證探測 Router。
4. 依 Client Route 規格，沒有有效 allowlist 時 Classroom 按鈕保持停用，VansPod 不得寫入 Claude gateway 設定。因此沒有偽造模型、強行 POST 模式、啟動假 Router、使用內建模型別名，亦沒有建立一個其實未套用 Classroom routing 的 Desktop session 冒充驗收。
5. 本機 Windows computer-use RPC 也未配置：app/browser inventory 為空，bundled helper 回報 `Trusted RPC service is not configured: sky`。即使 allowlist 可用，picker、Desktop request 與普通 Chat 仍需使用者手動操作或先修復該驗證環境；CLI 流量不得取代 Desktop 證據。
6. 透過 VansPod Stop 完成清理後，47821～47823 全部停止監聽；`~/.claude/settings.json` SHA-256 仍為 `EE051BAFB1AFE29F24C06A7FE0741426E1784E00BAA5E5F7032830D1B07A19B2`，且仍沒有 `ANTHROPIC_BASE_URL`；受保護 connection 檔案 SHA-256 亦與起點相同。VansPod settings 只完成 ADR-0006 的 versioned route 初始化，三路皆為 Native／Responses。最後重新啟動 Claude Desktop，恢復使用者原本的 app 狀態。

第一次只證明當時缺少前置條件，不是 Desktop 相容性失敗。使用者要求重試並再次授權同一個安全生命週期後，第二次已取得非空 allowlist。

### 第二次：Desktop picker 未載入 Classroom catalog

1. `2026-10-13T00:08:16+08:00` 關閉 Claude Desktop；確認 Store app 與 Desktop-owned Code worker 均為 0。四個獨立 Claude CLI 行程未受影響，三個 VansPod port 也仍未監聽。
2. 啟動 VansPod 後，首次載入與手動 Reload 都取得 1 個真實 Session Model Allowlist 項目。Claude route 尚為 Native 時，`GET /v1/models` 正確回覆 0 筆。
3. 只透過 VansPod 正式 `/switch` 將 Claude Code Client Route 切到 Classroom。`2026-10-13T00:08:54+08:00` 路由顯示黃色「等待重開」，`~/.claude/settings.json` 只有預期的 loopback gateway 生效，route journal 已建立，`GET http://127.0.0.1:47822/v1/models` 發布 1 筆模型。
4. 使用 Windows 官方 `claude://code/new?folder=...` deep link 開啟新 Desktop Code Local。緊接 deep link 後，主機觀察到兩條對 `127.0.0.1:47822` 的短連線，之後成為 `TIME_WAIT`；這只證明 Desktop 啟動流程接觸過 Claude listener，不足以證明 picker 採用了 catalog。
5. 由於 computer-use RPC 仍不可用，picker 必須由使用者直接觀察。使用者回報沒有出現資料夾確認，且這個 fresh Desktop Code Local model picker **沒有 classroom model**。驗收在 picker 準則失敗；沒有選取模型、沒有送出 prompt，也沒有以 CLI request 冒充 Desktop request。普通 Chat 亦沒有建立測試訊息。
6. `2026-10-13T00:10:38+08:00` 透過 VansPod 正式 `/switch` 切回 Native。路由回到綠色，`ANTHROPIC_BASE_URL` 消失，Claude 設定 SHA-256 精確恢復為 `EE051BAFB1AFE29F24C06A7FE0741426E1784E00BAA5E5F7032830D1B07A19B2`，route journal 已移除。
7. VansPod Stop 後三個 port 全部關閉。再次關閉並重開 Claude Desktop；`2026-10-13T00:11:07+08:00` 確認 Desktop 已啟動、沒有 gateway 設定、沒有 journal、受保護 connection SHA-256 仍為 `21822AEAA8D0C62E6D5D219481A8F22321A641BD2099730EA770CF989C8C787A`。

| #20 驗收項目 | 結果 |
| --- | --- |
| 記錄 Windows、Desktop、Code 版本與乾淨起點 | 通過 |
| Classroom routing 後建立新的 Desktop Code Local session | 第二次已用官方 deep link 開啟；使用者回報沒有資料夾確認 |
| Desktop picker 顯示 classroom models | **失敗：使用者直接觀察不到 classroom model** |
| Desktop 選定模型經 Claude Client Route 成功 | 未執行 |
| 普通 Desktop Chat 保持官方連線 | 未執行；未建立測試對話 |
| Native restoration 後新 Desktop session 回官方行為 | 設定、journal、listener 與 connection 完整性通過；未送普通 Chat 訊息 |
| 無 CA／TLS interception／cookie proxy／picker rewrite／alias impersonation | 通過 |
| 未全數通過時維持 CLI-only 並留下可重跑限制 | 通過 |

第二次結果證明上述 Windows／Claude Desktop／Claude Code 版本組合中，VansPod 的受支援 gateway discovery 沒有讓 fresh Desktop Code Local picker 顯示 classroom model；它不是對所有未來版本做永久不相容判定。因 #20 要求所有準則都通過才能宣稱支援，產品名稱與文件聲明維持 `Claude Code CLI`。

程式回歸基線：`npm test` 為 273/273 通過（另 2 個 retired seam skip），`npm run typecheck` 通過。

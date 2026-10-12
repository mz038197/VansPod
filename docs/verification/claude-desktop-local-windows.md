# Claude Desktop Code Local Windows 驗收

本文件記錄 GitHub #20 的隔離實機驗收。它只判斷 Claude Code Client Route 是否能納入 Windows Claude Desktop 的新建 Code Local session；一般 Chat、Cloud、SSH、WSL 與 Cowork 不在路由範圍。驗收不使用本機 CA、TLS 攔截、官方 cookie proxy、內部 picker 改寫或內建模型別名冒充。

## 公開支援邊界

Claude Code 官方文件支援以 `~/.claude/settings.json` 的 `env.ANTHROPIC_BASE_URL` 連到 LLM gateway；Windows Claude Desktop 官方 deep link `claude://code/new` 可開啟新的 Code session。官方 gateway 文件同時說明 Anthropic 不支援透過 gateway 將 Claude Code 路由到非 Claude 模型，且未承諾 Desktop Code model picker 會從任意 gateway `/v1/models` 發現模型。因此 CLI 的 gateway 成功不等於 Desktop Local 通過，必須逐項觀察下列 Desktop 行為。

參考：

- <https://code.claude.com/docs/en/llm-gateway>
- <https://support.claude.com/en/articles/14729294-open-claude-desktop-with-a-link>
- <https://support.claude.com/en/articles/11940350-claude-code-model-configuration>

## 測試環境與乾淨起點

2026-10-13（Asia/Taipei）盤點：

- Windows 10 Pro，build `26300`，x64。
- Claude Desktop `2.31226.1.0`，安裝於 Microsoft Store package `Claude_2.31226.1.0_x64__pzs8sxrjxfjjc`。
- 全域 Claude Code CLI `2.1.296`。
- Claude Desktop 下載的 Code worker `2.1.295`。
- VansPod 基準為 `75808f3`（`issue-11-client-routes` 合併 #19 後）。
- `127.0.0.1:47821`、`:47822`、`:47823` 均無 listener。
- `~/.claude/settings.json` 是有效 JSON，沒有 root 或 `env` 中的 `ANTHROPIC_BASE_URL`；盤點時 SHA-256 為 `EE051BAFB1AFE29F24C06A7FE0741426E1784E00BAA5E5F7032830D1B07A19B2`。只記錄雜湊、欄位存在性與檔案大小，不記錄設定內容或憑證。
- VansPod 的受保護 Classroom Connection 已存在；沒有讀取、解密或輸出 Classroom API Key。
- Claude Desktop 尚未退出：盤點時有主 app 與五個既有 Desktop Code worker，因此這一刻不是可執行驗收的乾淨 Desktop 起點。
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

尚未執行會終止／重啟 Claude Desktop 或建立、送出 Desktop 對話的步驟。這些動作會中斷現有使用者 session 並產生外部對話，須取得使用者明確授權後才能繼續。現階段不滿足 #20 的 Desktop 通過條件，產品名稱與文件聲明維持 `Claude Code CLI`。

程式回歸基線：`npm test` 為 273/273 通過（另 2 個 retired seam skip），`npm run typecheck` 通過。

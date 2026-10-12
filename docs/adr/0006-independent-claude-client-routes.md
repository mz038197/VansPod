---
status: accepted
---

# Claude Code 與 VS Code Chat 使用獨立 Client Route

Claude Code Client Route 同時包含 Claude CLI 與通過驗證後的 Claude Desktop Code Local session，因為兩者共用官方支援的 `~/.claude/settings.json`；Claude Desktop 的一般 Chat、Cloud、SSH 與 WSL session 不在 VansPod 的 Desktop 接管範圍。VS Code Chat Client Route 指 Visual Studio Code IDE 中可使用 BYOK 模型的 Chat、Agent 與 utility tasks，是另一個 Client Route，不要求 GitHub 登入或 Copilot plan，且不包含 inline code completion、semantic search 與 embeddings。它必須獨立保存 Native／Classroom 模式、Client Model Catalog、Model API Adapter、原設定備份與恢復狀態，不得因 Claude Code 變更而改變，反之亦然。VansPod 將當前 Session Model Allowlist 分別發布為各 Client Route 的 Client Model Catalog，由學生在客戶端內選擇模型，而不將 VansPod 中的單一模型鎖定為該路由唯一可用模型；代理對不在 allowlist 的模型要明確拒絕，不靜默改用另一模型。模型清單在首次連線或恢復連線時載入，之後只在使用者按下 VansPod 的「重新載入」後重新取得與發布，不在背景輪詢；新 allowlist 套用於之後的請求，已開始串流的請求繼續完成。重新載入若無法從 Router 取得 allowlist，保留上次成功清單並明確顯示失敗；若 Router 成功回覆空 allowlist，則將所有 Classroom Client Route 切回 Native、恢復各自個人設定並提示本課沒有開放模型。每個 Client Route 使用不同的 loopback origin，代理在接受連線時即取得可靠的 Client Route 身分，不依賴 User-Agent、秘密 token 或 URL path 推測來源；各路由仍共用現有的協定轉換 implementation。從舊版合併的 Claude 狀態升級時，VansPod 先恢復 Claude 個人設定，再將新 Claude Code Client Route 初始化為 Native，不自動繼承舊 `claude: classroom` 狀態。Client Route 切換只更新持久設定，不強制終止已執行的 CLI、Desktop 或 VS Code；介面必須指示各自需要重開 CLI、建立新 Desktop Local session，或重載 VS Code 才會套用新設定。切回 Native 後，仍向 VansPod proxy 發出的舊 session 請求必須被拒絕並提示重啟客戶端，VansPod 不代轉 Native 流量也不處理官方登入憑證。

每個 Client Route 的代理入口獨立啟動與回報 Client Route Health。單一入口啟動失敗時，該路由顯示紅色失敗狀態、禁止切入 Classroom 且不寫入任何課堂設定；其他健康 Client Route 繼續正常使用，不因單一路由失敗而全部取消。
若該路由上次保存為 Classroom，但本次代理入口啟動失敗，VansPod 將它改回 Native 並恢復個人設定；恢復失敗時保留備份供後續重試，且不影響其他 Client Route。使用者按下「重新載入」時也會重試紅色失敗路由；恢復健康後仍保持 Native，必須由使用者再次手動切入 Classroom。

Codex Client Route 提供 Responses 與 Chat adapter；Claude Code 提供 Responses、Chat 與 Messages；VS Code Chat 只提供 Responses 與 Chat。三條路由都預設 Responses，各自的 adapter 偏好獨立持久化，切回 Native 或清除 Classroom Connection 後仍保留。
健康 Client Route 在 Native 時也可預先變更 adapter 偏好，這不會切入 Classroom；紅色或灰色路由禁止這項操作。Client Route Health 以綠色表示可用、黃色表示等待客戶端重啟／重載、紅色表示入口或恢復失敗、灰色表示未偵測到客戶端；紅色與灰色路由禁止 Classroom 切換、模型與 adapter 操作。
切回 Native 且個人設定恢復成功後，該路由直接轉為綠色，不等待客戶端重啟確認；未重啟的舊 session 若仍呼叫 VansPod proxy，依既定規則拒絕並提示重開。Classroom 設定變更後則保持黃色，直到 VansPod 觀察到該 Client Route 的第一個成功請求。
VS Code Chat 的 Native 只移除或停用 VansPod 擁有的 VCRouter Custom Endpoint provider，保留 GitHub Copilot 內建模型與所有個人 BYOK provider；Classroom 則發布 VCRouter provider，由學生在 VS Code 模型選單選擇具體課堂模型。變更 VS Code adapter 會更新 provider 協定並將狀態設為黃色，直到學生完全退出並重開 VS Code。舊版 VCRouter provider 只有在可驗證為 VansPod 所寫時才遷移；同名但 ownership 不明的 provider 不覆蓋，顯示衝突供使用者處理。
VansPod 為 VS Code provider 使用獨立備份 journal，同時記錄原始 provider 與 VansPod 預期寫入的 provider。只有現值仍符合預期寫入結果時才更新或移除；使用者或其他程式已修改時保留現值並顯示衝突。
已由舊 `classroom-one-click-install` 寫入、且以 `${input:chat.lm.secret...}` 參照 VS Code secret DB 的 VCRouter provider 不由 VansPod 自動接管或刪除；VansPod 將該路由顯示為紅色衝突，要求使用者先在舊擴充清除課堂連線，再按「重新載入」。VS Code Chat 的 adapter 套用於整個 VCRouter provider，其下所有課堂模型共用同一個 Responses 或 Chat `apiType`。判斷是否需要重開 VS Code 時比較整份 VansPod-owned provider 的有效內容，包含模型能力、adapter、endpoint 與 provider 增刪，不只比較模型 ID。
從舊 VansPod 版本升級時，只有形狀為 `{ "name": "VCRouter", "url": "<舊 VansPod localhost>" }` 且 URL 符合已知舊入口的 provider 視為 VansPod 舊資料；首次新版啟動移除它、保留其他 provider，並將 VS Code Chat 初始化為 Native。
未偵測到的 client 不啟動專用代理入口、不佔用額外本機連接埠，也不建立或修改設定；安裝後按「重新載入」才重新偵測、啟動入口並開放切換。使用者按「停止」時，VansPod 對每條 Client Route 先恢復個人設定，成功後才關閉該路由入口；單條恢復失敗時保留它的入口與備份、顯示紅色，其他成功路由仍可停止。單純關閉瀏覽器分頁不停止 VansPod。
三個預設本機入口固定為 `127.0.0.1:47821`（VansPod UI 與 Codex）、`127.0.0.1:47822`（Claude Code）與 `127.0.0.1:47823`（VS Code），避免 VansPod 每次啟動都改寫設定並要求重啟 client。自訂基準 port 的測試或特殊環境依序使用該 port 與後兩個 port；單一 port 被佔用只讓對應 Client Route 紅燈，不影響其他路由。
使用者「清除 Classroom Connection」時，VansPod 先停止接受新課堂請求並刪除 Classroom API Key，再逐條恢復個人設定。單條恢復失敗不撤銷憑證清除：該路由顯示紅色、保留備份，本機入口只能回覆課堂連線已清除，「重新載入」會重試恢復。
本機代理只綁定 `127.0.0.1`，不在客戶端設定、回應或日誌中暴露 Classroom API Key。威脅模型信任同一 Windows 使用者帳號下的本機程式：防止遠端存取與 Key 落地，但不宣稱能防禦已入侵的本機帳號，也不為此加入會干擾 Codex 或 Claude 登入的攔截 token。

Claude CLI 的 Client Model Catalog 使用 Claude Code 官方 gateway model discovery 發布。VS Code Chat 沿用 `classroom-one-click-install` 已驗證的完整 Custom Endpoint provider 模型陣列：VansPod 保留 Router `/extension/chat-language-models` 回傳的模型名稱、tool calling、vision、token 上限等能力資料，將模型 URL 改為 VS Code 專用本機入口，且不在 `chatLanguageModels.json` 寫入 Classroom API Key 或 secret reference。只有 provider 模型清單、adapter 或 endpoint 實際改變才將路由設為黃色並要求完整重開 VS Code；重新載入後內容相同則維持綠色。這不能直接推導 Windows Claude Desktop 第一方 Code 分頁的模型選單也能顯示任意課堂模型。VansPod 明確不採用 first-party TLS 攔截、不安裝本機 CA、不觸碰官方登入 cookie，也不把 Sonnet／Opus 等假名稱綁定到其他實際模型。Windows Desktop 只有在隔離實機驗證證明官方 gateway 方式能讓新建 Code Local session 顯示課堂模型，且不影響一般 Chat 後才納入支援；驗證通過前 UI 只標示「Claude Code CLI」，通過後才改為「Claude Code（CLI + Desktop Local）」；驗證失敗就維持 CLI-only，不在 UI 或文件宣稱 Desktop 可用。

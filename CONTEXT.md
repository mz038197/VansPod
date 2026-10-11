# Classroom App

Classroom App 是學生使用的本機課堂入口。本檔只定義本專案的領域用語；沿用 `classroom-one-click-install/CONTEXT.md` 已有的名稱，但不沿用僅適用於 VS Code 擴充的儲存行為。加密技術與儲存格式屬於 ADR，不屬於領域詞彙。

## Language

**Classroom App**:
學生在本機完成課堂連線、開發環境與本課資源安裝，以及 Model Switch 的入口。它只支援凡思的 Nickname Redeem，不是 Router Portal，也不是 VS Code 課堂擴充。
_Avoid_: Portal、Codex plugin、把 Classroom App 當成 Router 本身

**Nickname Redeem**:
學生用 Invite Code 與 Classroom Nickname，向凡思 Router 兌換某個 Class Session 的 Classroom API Key。不等同 Google 登入。
_Avoid_: Google Sign-in Handoff、全班共用 API Key、登入學生 Google 帳號

**Classroom API Key**:
Nickname Redeem 取得、屬於特定 Class Session 的課堂憑證；本機代理憑此向 Router 呼叫模型 API。它不是上游供應商金鑰，也不是 Invite Code。
_Avoid_: OpenAI／Anthropic 上游 API Key、Google token、Invite Code、在畫面上顯示金鑰明文

**Classroom Connection**:
Classroom App 目前持有、指向一個 Class Session 的連線身分，包含 Classroom API Key 與恢復課堂辨識所需資訊。清除 Classroom Connection 不等於停止本機代理。
_Avoid_: Router Portal session、僅指一把 API Key、把「清除連線」當成「停止代理」

**Persistent Classroom Connection**:
可跨 Classroom App 行程重新啟動恢復的 Classroom Connection；恢復後仍須依當時有效的 Session Model Allowlist 判定能否使用 Classroom 模式。
_Avoid_: 把存有憑證當成已確認模型可用、永久有效的登入

**Temporary Classroom Connection**:
只在當次 Classroom App 行程期間有效的 Classroom Connection；重新啟動後不會自動恢復。
_Avoid_: 未加密的磁碟連線、可以跨重啟恢復的連線

**Class Label**:
已連線時顯示的課堂名稱標籤，由 Class 與 Class Session 名稱組成；不是 Classroom API Key 本體。
_Avoid_: 在畫面上展示 API Key、只顯示學生暱稱而稱為課堂名稱

**Session Model Allowlist**:
老師為單一 Class Session 指定、由 Router 回傳並強制執行的可用模型清單。Classroom App 不以本機預設清單取代它。
_Avoid_: Router Model Template 全集、App 內建模型表、把 Allowlist 塞進 Course Catalog

**Model Switch**:
同一個本機開關，讓 Codex 與 Claude Code 使用 Classroom 模型或各自的 Native 模型。Classroom 模式以有效的 Classroom Connection 與 Session Model Allowlist 為前提。
_Avoid_: 每個客戶端各自切換、把 Native 當成原本的第三方路由、沒有可用模型仍進入 Classroom

**Copy Classroom API Key**:
已連線的學生將 Classroom API Key 複製到系統剪貼簿的動作；畫面不顯示金鑰全文。
_Avoid_: 從畫面選取金鑰文字、複製 Invite Code、清除連線後仍提供複製

**Clear Classroom Connection**:
學生主動撤去本機的 Classroom Connection，移除憑證與 Class Label，並讓 Model Switch 回到 Native；不刪除其他客戶端的個人設定。
_Avoid_: 僅清除畫面狀態卻保留憑證、刪除其他 provider、刪除 Workspace MCP Config

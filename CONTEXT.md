# VansPod

VansPod 是學生使用的本機課堂入口。本檔只定義本專案的領域用語；沿用 `classroom-one-click-install/CONTEXT.md` 已有的名稱，但不沿用僅適用於 VS Code 擴充的儲存行為。加密技術與儲存格式屬於 ADR，不屬於領域詞彙。

## Language

**VansPod**:
學生在本機完成課堂連線、開發環境與本課資源安裝，以及 Model Switch 的入口。它只支援凡思的 Nickname Redeem，不是 Router Portal，也不是 VS Code 課堂擴充。
_Avoid_: Portal、Codex plugin、把 VansPod 當成 Router 本身

**Nickname Redeem**:
學生用 Invite Code 與 Classroom Nickname，向凡思 Router 兌換某個 Class Session 的 Classroom API Key。不等同 Google 登入。
_Avoid_: Google Sign-in Handoff、全班共用 API Key、登入學生 Google 帳號

**Classroom API Key**:
Nickname Redeem 取得、屬於特定 Class Session 的課堂憑證；本機代理憑此向 Router 呼叫模型 API。它不是上游供應商金鑰，也不是 Invite Code。
_Avoid_: OpenAI／Anthropic 上游 API Key、Google token、Invite Code、在畫面上顯示金鑰明文

**Classroom Connection**:
VansPod 目前持有、指向一個 Class Session 的連線身分，包含 Classroom API Key 與恢復課堂辨識所需資訊。清除 Classroom Connection 不等於停止本機代理。
_Avoid_: Router Portal session、僅指一把 API Key、把「清除連線」當成「停止代理」

**Persistent Classroom Connection**:
可跨 VansPod 行程重新啟動恢復的 Classroom Connection；恢復後仍須依當時有效的 Session Model Allowlist 判定能否使用 Classroom 模式。
_Avoid_: 把存有憑證當成已確認模型可用、永久有效的登入

**Temporary Classroom Connection**:
只在當次 VansPod 行程期間有效的 Classroom Connection；重新啟動後不會自動恢復。
_Avoid_: 未加密的磁碟連線、可以跨重啟恢復的連線

**Class Label**:
已連線時顯示的課堂名稱標籤，由 Class 與 Class Session 名稱組成；不是 Classroom API Key 本體。
_Avoid_: 在畫面上展示 API Key、只顯示學生暱稱而稱為課堂名稱

**Session Model Allowlist**:
老師為單一 Class Session 指定、由 Router 回傳並強制執行的可用模型清單。VansPod 不以本機預設清單取代它。
_Avoid_: Router Model Template 全集、App 內建模型表、把 Allowlist 塞進 Course Catalog

**Model Switch**:
每個客戶端各自的本機開關，讓 Codex 與 Claude Code 獨立使用 Classroom 模型或自己的 Native 模型。Classroom 模式以有效的 Classroom Connection 與 Session Model Allowlist 為前提；切換一個客戶端不改變另一個。重新開啟沿用各自上次的模式，開啟本身不代表從 Native 切到 Classroom；返回 Native 時恢復該客戶端原有的個人設定。
_Avoid_: 全域強制一起切換、把 Native 當成原本的第三方路由、沒有可用模型仍進入 Classroom

**Model API Adapter**:
VansPod 配合 Router 上游模型 API 協定、適配 Codex 或 Claude Code 請求與回應的方式。它不同於 Model Switch 的 Classroom／Native 模式選擇。
_Avoid_: Model Switch、模型本身、opencodex 的 adapter 實例

**Copy Classroom API Key**:
已連線的學生將 Classroom API Key 複製到系統剪貼簿的動作；畫面不顯示金鑰全文。
_Avoid_: 從畫面選取金鑰文字、複製 Invite Code、清除連線後仍提供複製

**Clear Classroom Connection**:
學生主動撤去本機的 Classroom Connection，移除憑證與 Class Label，並讓 Model Switch 回到 Native；不刪除其他客戶端的個人設定。
_Avoid_: 僅清除畫面狀態卻保留憑證、刪除其他 provider、刪除 Workspace MCP Config

### Discord 與 ACP

**Discord Agent**:
Classroom App 提供的遠端 Coding Agent 操作入口；學生透過自己的 Discord Bot，向本機的 Agent 提交任務。它不是獨立部署的雲端 Agent。
_Avoid_: Discord 上另有一套模型服務、全班共用的 Bot、把 Discord Bot 當成 Agent 本身

**Bot Owner**:
在 Classroom App 中指定的 Discord 使用者，是這台電腦 Discord Agent 的管理者與 ACP 權限批准者。Public 模式允許其他人發送任務，但不改變 Bot Owner 的批准權。
_Avoid_: Discord Server Owner、頻道管理員、Bot Token 的持有者自動等於 Owner

**Access Mode**:
Discord Agent 接受任務的存取範圍：Private 僅接受 Bot Owner 的指令，Public 接受指定頻道內其他使用者的指令。它不等於 Coding Agent 自身的工具執行權限。
_Avoid_: Agent 的 sandbox mode、模型權限、單靠頻道存在就表示有權批准工具

**Default Agent**:
學生在 Classroom App 選定、建立新 Discord Thread 時使用的 Coding Agent 類型；不會覆蓋既有 Thread 已綁定的 Agent。
_Avoid_: Model Switch、每次送訊息都重新選 Agent、全域強制切換既有 Thread

**Thread Binding**:
一個 Discord Thread 與其 Coding Agent 類型、Project Folder 及可恢復 ACP Session 的關聯。這個關聯可跨 App 重啟保留，但封存或刪除 Thread 後不再保留。
_Avoid_: 一則 Discord 訊息對應一個 Agent、所有 Thread 共用同一個 Session

**Thread Agent Session**:
一個 Discord Thread 內持續接收任務、供參與者共用的 Agent 對話上下文。重建 Session 不會重建或清除 Discord 歷史訊息，也不會清空 Project Folder。
_Avoid_: Discord Thread 本身、Discord 聊天紀錄、獨立的每人 Session

**Agent Task**:
Discord 使用者交給 Thread Agent Session 的單次工作請求；具有可追蹤的排隊、執行與結束狀態。同一 Thread 的任務依序處理。
_Avoid_: 將一整個 Thread 稱為單一 Task、把 Discord 訊息送達等同執行完成

**Task Queue**:
已被 Discord Agent 接受、尚未開始執行的 Agent Task 集合。它與正在執行的任務不同，取消或中斷的任務不會自動重新排隊。
_Avoid_: Discord 離線期間所有歷史訊息、已執行中的 ACP Prompt

**ACP Approval**:
Thread Agent Session 經由 Coding Agent 權限機制提出、等待 Bot Owner 允許或拒絕的一次工具操作請求。它不同於 Access Mode 對「誰可以送任務」的判斷。
_Avoid_: Public 使用者可批准、永久信任同類操作、Agent 原本自動允許的動作也一定會提出批准

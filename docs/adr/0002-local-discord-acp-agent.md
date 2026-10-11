# 以本機 Discord Gateway + ACP 操作學生的 Coding Agent

Classroom App 已有課堂連線、Model Switch 與 Project Folder，但學生也希望透過 Discord 遠端操作本機 Coding Agent。我們選擇在同一個 Classroom App 內提供 Discord Gateway 與 ACP Client，而不另外部署雲端控制服務、不合併 OpenAB 原始碼，也不提供另一份獨立的模型路由設定；這可以維持「學生只安裝 Classroom App」的產品邊界，並繼續沿用既有本機設定。

## Decision

- 每位學生建立並使用**自己的 Discord Bot**，由本機主動連出 Discord Gateway。Bot Token、允許的頻道與 Bot Owner 設定留在學生電腦，不送到 Classroom Router；Bot Token 使用既有跨平台 Secure Storage 方案保護。Gateway 不開公開 HTTP Port，不使用 Tunnel、反向代理或獨立控制平面。
- Classroom App 提供 Coding Agent 的**安裝協助、偵測與 Default Agent 選擇**；實際 Coding Agent 透過學生電腦上的 ACP CLI／Adapter 執行。接入方式是 ACP 的 stdio／JSON-RPC，不把 OpenAB 編成另一個可執行檔，也不在 App 裡重寫 Agent 推理與工具能力。
- 指定頻道內透過 `@Bot` 開啟新 Discord Thread，Thread 後續訊息不必再次提及 Bot。每個 Thread 綁定一種 Agent、建立當下的 Project Folder、獨立的 ACP Session 與在需要時啟動的 Agent Process；Public 模式下，同一 Thread 的多位使用者**共用**這個 Agent Session，同一 Thread 的任務按序執行。
- **Default Agent** 與 **Project Folder** 的設定更新只影響新 Thread；**Model Switch** 仍是全域設定，既有 Thread 的下一個任務也採用任務**開始執行時**的模式，執行中的任務不會被中途切換。必要時重新啟動 Agent Process 並嘗試恢復 Session；不能恢復就建立新 Session 並告知上下文重置。各 ACP Adapter 是否正確繼承現有 Codex／Claude 模型與認證設定，必須實際驗證，不能預設支援。
- Thread Binding 可跨 Classroom App 重啟保留，ACP Process 依需求啟動，閒置後回收；Thread **封存或刪除時**移除 Session 與綁定。封存後重開的 Thread 使用**當時**的 Default Agent／Project Folder 建立新 Session，且不自動匯入 Discord 歷史訊息。

## Rationale and consequences

這個選擇避開雲端代管、公開學生本機服務與為每個 Agent 重做一套通訊流程，也使 Thread 成為可理解的開發工作上下文。代價是必須驗證不同 ACP CLI／Adapter 的安裝、權限事件、取消、Session 恢復及模型設定相容性；ACP 不保證所有 Agent 都能無縫恢復 Session。

Discord Thread 的可見歷史與 Agent Session 的上下文是**不同的事物**：重建 Session 不會刪掉 Discord 舊訊息、既有專案檔案或已完成的外部操作。不同 Thread 可以並行操作同一 Project Folder，不提供檔案互斥鎖，可能互相覆寫檔案。

具體的 Queue、取消、重連、權限與介面行為見 [Discord Agent 設計決策](../design/discord-agent.md)。本 ADR 是決策紀錄，不代表功能已實作。

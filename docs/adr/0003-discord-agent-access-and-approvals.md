# Discord Agent 將指令存取與 ACP 工具批准分開

Discord Agent 可在學生電腦上讀寫檔案、執行命令，因此允許誰送出 Prompt 與允許誰批准工具操作必須是兩個不同的權限判斷。我們選擇由 Classroom App 的 Access Mode 控制 Discord 訊息入口、由指定的 Bot Owner 專屬批准 ACP 權限請求；同時**保留 Coding Agent 原本的工具權限設定**，不聲稱 Discord 層能攔住 Agent 已設定為自動允許的操作。

## Decision

- 學生在本機 UI 手動輸入 **Bot Owner 的 Discord User ID**。Access Mode 預設 **Private**（只收 Owner 指令），可隨時在 UI 直接切換 **Public**（指定頻道內使用者也能發送任務），**不彈二次確認**，但 UI 持續顯示 Public 的風險說明。所有入站訊息與互動按鈕在後端檢查 Discord User ID 和頻道，不能只靠 UI 隱藏。
- **ACP Approval 永遠由 Bot Owner 決定**，Public 使用者不可批准。批准請求優先透過 Discord **DM** 傳給 Owner；原 Thread 只顯示等待狀態，不公開批准詳情。若 DM 不可用，Classroom App 本機 UI 提供備援批准；本機 UI 也需防護非預期的 localhost 請求、CSRF 與未授權操作。
- 多筆 ACP Approval 可以同時等待，必須**逐筆允許一次或拒絕**，沒有 Allow All。先完成的有效決定生效，其他 UI／DM 按鈕立即失效。依使用者選擇，**批准不設逾時**；直到批准、拒絕、任務取消、Bot 停止、Session 重置或 Agent 中斷，該請求才結束。等待批准仍占用執行中任務名額。
- 維持 Agent 本身的既有權限／sandbox 設定，不強制切到更嚴格模式，也不自動批准 ACP 主動提出的請求。因此 Public 模式下，若 Agent 原本能不經詢問就讀寫檔案或執行命令，其他使用者的 Prompt **可能直接觸發這些操作**。
- **Public → Private**：立即拒絕非 Owner 的新指令，取消非 Owner 正在執行與排隊的任務，保留 Owner 的任務，盡可能保留既有 Session。**Private → Public**：先停止收任務、取消所有舊 Running／Queued 任務及 Pending Approvals、終止舊 Agent Process 並重建 Session，再開放 Public；保留 Discord Thread／Agent／Project Folder，但不把 Private 的 ACP 上下文或 Discord 歷史訊息自動帶進新的共用 Session。
- 使用者只能取消自己的任務，Bot Owner 可取消任何任務或整個 Thread 的任務。取消尚未執行的任務會移出 Queue；取消進行中的任務先嘗試 ACP 取消，超過停止期限才強制終止該 Agent Process，並使相關 Pending Approvals 失效。

## Considered options and consequences

我們未採「Public 模式強制所有 Agent 進入受限安全模式」，也未要求開啟 Public 時二次確認；這保留學生既有 Agent 習慣，但**不能保證 Public 模式對本機檔案安全**。應在 UI 顯示清楚且常在的安全說明，不把 Owner-only 的 ACP 批准誤稱為所有工具操作的攔截層。

重建 ACP Session **不會**清除 Discord 原 Thread 的歷史訊息，也不隔離共用 Project Folder。具體 UX、Queue 與 Session 生命週期見 [Discord Agent 設計決策](../design/discord-agent.md)。本 ADR 是決策紀錄，不代表功能已實作。

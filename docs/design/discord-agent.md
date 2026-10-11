# Discord Agent — 已確認的設計決策

**狀態：已完成需求訪談，尚未進入 to-spec／to-tickets／程式實作。**

本文件整理 2026-10-10～2026-10-11 的 Discord × ACP 討論（Q1～Q41 的**最後選擇**）。它是可供後續 to-spec 使用的**行為設計紀錄**，而不是已完成功能的說明。領域名稱以根目錄 [CONTEXT.md](../../CONTEXT.md) 為準；具長期價值的架構與安全取捨分別由 [ADR-0002](../adr/0002-local-discord-acp-agent.md)、[ADR-0003](../adr/0003-discord-agent-access-and-approvals.md) 記錄。此文件取代 [2026-10-10 交接筆記](../../handoff/2026-10-10-discord-acp.md) 內與後續選擇衝突的初步建議。

## 1. 產品及整合邊界

- 學生只需 Classroom App，不另安裝獨立 OpenAB Windows 執行檔、也不將 OpenAB 原始碼併進 App。以 TypeScript 的 `discord.js` 接 Discord Gateway；以 ACP stdio／JSON-RPC 管理學生電腦上的 Coding Agent CLI／Adapter。
- 每位學生建立**自己的** Discord Bot，填入 Bot Token、允許頻道 ID、Bot Owner User ID。學生需先在 Discord Developer Portal 建立 Bot、啟用必要 Intent 並邀請入伺服器。Bot Token 以 Secure Storage 儲存；Discord 設定與 Thread Binding 均留在本機，不上傳到 Classroom Router。
- Discord Gateway 僅由本機向外發起連線；不另開公開 HTTP Port、不暴露既有 localhost UI、不設 Cloudflare Tunnel／nginx／雲端控制平面。
- Classroom App **協助安裝、偵測** ACP Agent／Adapter，讓學生選 Default Agent。可用清單以實際安裝及 ACP 能力為準；「安裝 Agent」與「完成 Agent 登入／授權」是不同步驟。Discord 層不重做 Agent 的推理、工具或 MCP 能力。
- Discord Agent **沿用 Classroom App 現有 Model Switch 與 Codex／Claude 等客戶端設定**；不另外儲存一套 Router API Key 或模型選擇。必須對各個 ACP Adapter 實測是否正確遵守既有模型／認證設定，不能假定其通用相容性。

## 2. Thread 與 Agent Session

1. **建立入口**：在指定頻道 `@Bot` 開啟新 Discord Thread；同 Thread 之後的訊息不用重複 `@Bot`。只有符合當前 Access Mode 與頻道限制的使用者訊息才建立 Agent Task。
2. **一 Thread 一 Agent Session／Process**：Thread 綁定建立時選定的 Agent 類型與 Project Folder；第一次需要處理 Prompt 時才啟動該 Thread 的 ACP Agent Process。Public 模式下，多位參與者共用這一個 Session，上下文並不按發言者隔離。
3. **Default Agent 改變**：僅影響後續新建的 Thread。既有 Thread 持續使用原來的 Agent，即使重啟 Classroom App。
4. **Project Folder 改變**：僅影響新 Thread；既有 Thread 留在建立時的工作目錄。**不同 Thread 可同時操作同一個 Project Folder**，不加資料夾鎖；可能發生程式碼覆寫。
5. **Model Switch 改變**：屬全域設定，既有 Thread 也受影響，但**正在執行中的任務不變**。排隊任務與後續新任務在**真正開始執行時**使用最新模式；若需切換 Agent Process，應在任務界線處處理，嘗試恢復 Session，無法恢復則通知上下文重置。
6. **閒置回收**：預設 30 分鐘未執行任務時結束 Thread 的 Agent Process，保留 Thread Binding 與可恢復的 Session 資訊；學生可在 UI 調整閒置時間。等待 ACP Approval 屬於執行中，不因閒置回收而自動取消。
7. **App 重新啟動**：自動重新連接 Discord（若先前已完成設定），恢復 Thread Binding，但不一次啟動所有 Process。收到新任務時才重啟對應 Agent，嘗試恢復 Session；若不支援恢復則建立新 Session 並通知。新 Session **不從 Discord 歷史訊息補上下文**。
8. **Thread 封存或刪除**：兩者都清除該 Thread 的 Session／Binding，結束 Agent Process、取消相關未完成任務，但不刪 Project Folder 或曾修改的檔案。**封存後重新開啟**仍可在原 Discord Thread 發訊息，但使用**當時**的 Default Agent 與 Project Folder 建立新 Session，並告知先前上下文已重置。
9. **Private → Public 的 Session 重建**是額外的強制重置事件（見 §4）；它保留 Thread Binding 中的 Agent 與 Project Folder，但不保留私人 ACP 上下文。

## 3. Task Queue、取消與執行狀態

| 設定 | 預設 | 調整方式 |
| --- | --- | --- |
| Max Concurrent Tasks | **2** | Classroom App UI 可調 |
| Max Queued Tasks（全域） | **10** | Classroom App UI 可調 |
| Max Queued Tasks Per User | **3** | 本期固定預設，後續再評估 |
| Agent Process Idle Timeout | **30 分鐘** | Classroom App UI 可調 |
| Graceful Cancellation／Shutdown Timeout | **10 秒** | 本期固定預設 |

- 限制的是**同時執行中的 Task**，不是總 Thread／Agent Process 數；**等待 ACP Approval 的任務仍占並行名額**。同一 Thread 的 Prompt 永遠依序處理，跨 Thread 可並行；即使 Project Folder 相同也不另加互斥鎖。
- 達到 Queue 全域或每人上限時拒絕新任務，於 Discord 顯示「佇列已滿」；不默默丟棄。Task 佇列是已接收、尚未開始的任務，不包括 Discord 離線期間尚未被接收的訊息。
- Bot 透過**同一則狀態訊息**更新 `Queued → Running → Completed／Failed／Cancelled／Interrupted`，並顯示排隊順位；Agent 執行中可以依 ACP 事件顯示進度摘要、節流 Discord 更新頻率。不要直接貼完整機密終端輸出、環境變數或憑證。
- **取消尚未執行的 Task**：使用者可取消自己的任務；Bot Owner 可取消任何任務。移出 Queue、更新狀態，無需啟動 Agent。
- **取消執行中的 Task**：先嘗試 ACP Cancel。取消成功保留可用的 Agent Process／Session；最多等待 10 秒，仍無法取消才強制終止該 Thread Process，下個任務再嘗試恢復 Session，失敗則新建並通知。已修改的檔案與外部副作用**不自動回滾**；其他 Thread 不受影響。
- **同 Thread Queue 清理規則**：一般使用者取消執行中任務時，同時清除**該 Thread 內由自己提交**的後續 Queued Tasks，保留其他使用者的排隊任務；Owner 可以選擇取消整個 Thread 的任務。這是 Q31「取消同 Thread Queue」與 Q32「不能取消別人的任務」的合併規則。
- 取消、權限撤銷、Bot 停止、Session 重建或 Process 崩潰後，關聯的 Pending Approvals 失效；遲到的 Discord 按鈕不可讓操作復活。
- **Coding Agent Process 崩潰**：將正在執行的 Task 標為 Failed，釋放名額並繼續 Queue，**不自動重新提交 Prompt**；保留可恢復 Session 資訊供之後的新任務使用。
- **Classroom App 意外關閉**：重啟後將原 Running／Queued 標記為 Interrupted，**不自動重跑或重排**，保留可恢復的 Thread／Session 關聯，並在 Discord 可用時更新狀態。

## 4. Access Mode 與任務權限

- **Bot Owner** 由學生在 UI **手動輸入 Discord User ID**，不是以 Bot Token、Server Owner 或頻道管理員身分推定。Private（預設）只允許 Owner 發 Task；Public 則允許指定頻道的其他使用者發 Task。UI 切換**即時生效，不出現二次確認**，但 Public 的高風險提示應常態可見。
- 權限檢查必須由 Classroom App 後端針對 Discord User ID／Channel ID 驗證，不能僅依賴按鈕顯示。一般使用者只能取消自己提交的任務；Owner 可取消任何人的任務並管理整個 Thread。
- **Public → Private**：立即拒絕其他使用者的新 Task；取消非 Owner 的 Running Tasks 與 Queued Tasks，Owner 任務保留；盡可能保留 Session，撤銷對應的待處理批准請求。這是撤銷存取，不是關閉整個 Bot。
- **Private → Public**：先暫停接收新任務，取消**所有**既有 Running／Queued Tasks 與 Pending Approvals，依 10 秒取消規則結束 Process、清除私人的 ACP Session，再正式開放 Public。保留 Thread 及原本綁定的 Agent／Project Folder；新 Session 從切換後的新訊息開始，**不讀取 Private 時期的 Discord 歷史內容**。
- **Public 不等於執行沙箱**：沿用 Coding Agent 原本的工具授權、sandbox／自動批准設定。即使只有 Owner 可批准 ACP 主動提出的請求，其他 Public 使用者也可能觸發 Agent 原本已允許的讀寫或命令。切換 Access Mode 不會刪掉既有 Discord 訊息，也不會隔離同一 Project Folder。

## 5. ACP Approval

- 若 Agent **主動提出** ACP 工具權限請求，優先以 Discord **DM** 傳給 Bot Owner；原 Thread 只顯示「等待 Owner 批准」。Discord DM 不可用時，Classroom App **本機 UI** 有 Pending Approvals 備援入口；本機批准需限制為授權操作，避免 localhost CSRF／未授權請求。
- 每筆請求獨立顯示 **Allow Once／Deny**，允許多筆同時等待，**沒有 Allow All／Deny All**。同一筆由 Discord 或本機 UI **第一個有效操作**決定結果，其他按鈕失效。
- **沒有批准逾時（Q29 最終選 B）**：只要該 Task 還有效，就可能一直等待；等待期間仍占用 Max Concurrent Tasks 名額。使用者可取消任務、Owner 可停止 Bot；取消後權限請求立即失效。斷線或 DM 失敗不會構成自動批准。
- ACP Approval 與 Access Mode 是兩個不同判斷；Agent 已被設定為**不需詢問**的動作，不會因 Discord Owner-only Approval 而自動被攔截。Discord 中不要將批准細節散播到 Public Thread。

## 6. Gateway 生命週期與離線復原

- 學生首次設定並成功連接後，Classroom App 後續啟動**自動連上 Discord Gateway**，UI 仍提供 Start／Stop；手動 Stop 在同一執行期間不自動恢復連線。
- **手動 Stop**：先停止接受新任務，取消進行中的 ACP Prompt 與 Pending Approvals，結束所有由 Discord Bot 管理的 Process（最多等待 10 秒後強制終止），保留 Thread Binding／可恢復 Session 資訊。未完成任務不會在下次 Start 後偷偷續跑。**不停止** Classroom App 原有的 Router Proxy，也不更改 Model Switch。
- **Discord Gateway 意外斷線**：自動重連；已接受的 Running／Queued Tasks 繼續執行／保留，結果暫存到連線恢復再補發。需使用 Discord Message ID 與任務結果送達狀態去重；無法證明送達時仍須避免無限重發。
- **Discord 離線期間新發送的訊息不補執行**；只處理 Gateway 恢復後的新事件。斷線前已接受的任務及其結果仍要處理，兩者不可混為一談。
- **關閉系統瀏覽器頁面不等於關閉 App 或 Discord Bot**；既有本機代理也維持原本的停止語義。

## 7. UI 決策

Discord Agent 設定區包含：Bot Token、Allowed Channel ID、Bot Owner User ID、Access Mode（Private／Public）、Default Agent（含可用性檢查／安裝協助）、沿用的 Project Folder、Start／Stop、Gateway 連線狀態、Max Concurrent Tasks、Max Queued Tasks、Idle Timeout，以及可處理多筆請求的 Pending Approvals。ACP Approval 的 Discord DM 按鈕與本機 UI 必須指向同一筆請求。Public 切換**不彈警告對話框**，但有持續可見的風險說明。

Discord Thread 中應能看到 Queue 排名、執行進度、最終結果、取消任務按鈕與 Session 上下文重置通知。長時間等待、錯誤及斷線訊息不得回顯 API Key、Bot Token 等機密。

## 8. 明確不做／已撤回的選項

- 不做 Slack／LINE／Telegram／飛書、OpenAB 專用 EXE、對外 HTTP 入口、Cloudflare Tunnel、控制平面、多機器人共享一個學生環境、語音、slash command、表情反應操作。
- 不強制覆寫 Agent 原本工具權限，不讓其他 Public 使用者批准權限，不提供批次批准。
- **Q29 已由「5 分鐘逾時」改為「無限等待」；Q30 最終是「崩潰後不自動重試」**，Q31「重試上限」提問因而不適用。
- **Thread 封存／刪除都清 Session（Q20 最終 B）**；重新開啟封存 Thread 建立新的 Session，而不是恢復舊上下文。
- 舊 [2026-10-10 handoff](../../handoff/2026-10-10-discord-acp.md) 的「ACP CLI 已由學生自行安裝」已被 **Classroom App 協助安裝／偵測** 的新決策更新。

## 9. 進入 to-spec 時需驗證的技術事實

以下是**實作驗證事項，不需要重新詢問已拍板的產品決策**：

- 不同 Agent／ACP Adapter 能否在 Runtime 正確繼承 Model Switch，及如何實現安全的 Session 恢復／重建。
- ACP Cancellation、Permission Requests、Agent Exit 與進度通知的實際能力，尤其多筆等待及無限等待的併行額度。
- Discord Gateway 斷線重連、Thread 封存／重開事件、Message ID 去重、結果發送重試，以及同一 Thread 共享 Session 的順序性。
- Windows SEA 的 `discord.js` 封裝、ACP 子行程安裝／偵測與啟動；跨平台時如何處理缺少的 ACP CLI。
- Discord Bot Token 以既有 Secure Storage 安全保存；Thread／Task metadata 在重啟時如何一致地標示中斷狀態，而不把機密 Prompt／憑證寫成明文檔案。

以上決策供下一階段 **to-spec** 使用；尚未修改 Discord 功能程式碼。

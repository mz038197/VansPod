# 交接：長駐 Streamlit 被誤判為安裝中

## 下一次工作的目標

使用者明確指定下一步修正：VansPod 顯示「安裝中」，實際上是它啟動的 Streamlit 網站仍在背景執行。本次只建立交接，尚未實作這個修正。

使用者指定文件存於本專案 `handoff/`，優先於 handoff 技能的 OS 暫存目錄預設。

## 已取得的證據

- 本機管理狀態回傳 `running: true, installing: true, activeRequests: 0`，「安裝中」狀態持續存在。
- 查看實際程序樹，VansPod 的 Node 服務下有 `cmd.exe → uv.exe → streamlit.exe → python.exe → python.exe`，另有獨立的系統匣程序。
- Streamlit 使用學生專案的虛擬環境執行。專案路徑、使用者名稱及歷史 PID 不記錄於此；重現時須重新查詢，不能沿用先前 PID。
- 這個證據確認有長駐網站程序；目前尚未查明它對應的 Course Catalog action、完整命令或 action 類型，不能假定所有 `commandRunning` 都是網站。
- 使用者要求「關掉全部背景」後，先終止該命令的子程序樹及兩個測試預覽服務，再透過 VansPod 正常 stop 結束本機服務。驗證結果為 `running: false`，相關監聽埠已停止。
- 沒有清除 Classroom Connection、移除程式，或修改學生作品；關閉背景程序不等於完整移除。

## 程式定位與待驗證推論

以下請直接閱讀原始碼，避免把本文件當成另一份規格：

- `src/classroomApp.ts`：`prepare()`／`confirm()`，約 693–737 行。`confirm()` 設定 `commandRunning`，await `commands.run()`，到 finally 才清除；同一狀態也被環境安裝流程使用。`stop()` 約 1642 行會因該狀態拒絕結束。
- `src/commandRunner.ts`：`collectOutput()` 等待 child `close` 才 resolve；`runCommand()` 是 shell 執行包裝，未暴露獨立的長駐服務生命週期。
- `src/start.ts`：管理 status 約 542 行直接把 `app.view().commandRunning` 命名為 `installing`；stop／uninstall 約 549–556 行因此禁止操作；signal shutdown 約 823 行也受同一旗標限制。
- `src/installProgress.ts`：安裝進度呈現與輪詢。
- `src/courseCatalog.ts`、`src/page.ts`：確認 catalog action 的語意、哪些命令能啟動網站，以及 UI 操作入口。

待驗證的主要推論：有限時間的安裝與長駐網站共用「命令尚未結束」旗標，因此網站一直運行就一直被當成安裝。不要只改提示文字或直接取消安裝期間的退出保護。

## 建議下一步

1. 先建立可重現此症狀的測試／隔離程序案例，確認實際 action 與命令鏈；使用暫存專案與模擬長駐程序，不依賴學生原有專案或真實課堂憑證。
2. 對照既有領域文件與生命週期 ADR，決定安裝工作、一次性命令及長駐網站需要如何區分；不要僅靠命令字串含 `streamlit` 判斷。
3. 明確設計網站啟動成功／失敗、執行中、停止及 VansPod 結束時的子程序處理。持續有 stdout 或 child 尚未退出不應等同安裝進行中；單純 spawn 成功也不一定代表網站已可用。
4. 保留真正安裝工作的退出保護、客戶端設定恢復、Classroom Connection 與學生檔案；驗證網站子程序不會成為孤兒或阻止正常結束。
5. 使用者尚未決定網站應隨 VansPod 結束或獨立存活，也未確認新的狀態文案與控制方式。先用程式及 ADR 找出既有約定，再釐清實際需要的產品選擇。

## 已完成工作的參考與目前狀態

本輪前半段的法鬥吉祥物功能與修正已提交，不在下一步重新實作範圍。直接參考 commits：

- `ce206f7`：連線卡片吉祥物、動畫、未連線待機與錯誤泡泡。
- `1b8feba`：胸前文字透明合成修正。
- `0fabb18`：複製 Classroom API Key 成功提示改為法鬥台詞。

上一輪完整測試 380 項通過；型別檢查通過。exe／npm 隔離交付驗證在 `ce206f7` 收尾時通過，後續兩次 UI 修正也重新建置 exe；沒有公開發布。交接前背景服務已按使用者要求關閉，不要自動啟動真實課堂環境。

專案規則與既有決策參照 `AGENTS.md`、`CONTEXT.md`、`docs/agents/domain.md`、`docs/adr/0005-client-route-lifecycle.md`、`docs/adr/0008-student-distribution-and-lifecycle.md`。議題操作依 `docs/agents/issue-tracker.md`；此問題目前未建立 GitHub issue。

使用者偏好直接完成已授權工作、簡短繁體中文進度更新；避免重複詢問已確認事項。不要輸出 API Key、管理 token、完整命令輸出中的敏感資訊，或私人的本機資料路徑。

## Suggested skills

下一位 agent 應依工作階段呼叫 Skill tool（若沒有該工具，讀取對應 `SKILL.md`）：

- `diagnosing-bugs`：建立可判定失敗／成功的重現迴圈，分辨真實安裝與長駐網站。
- `codebase-design`：需要重劃命令執行與服務生命週期界面時使用。
- `tdd`：在確認的公開測試邊界，以長駐程序與正常退出案例進行 red → green。
- `domain-modeling`：若新增領域狀態或改動 ADR，記錄已確認的決策。
- `implement`：正式實作時執行型別檢查、相關單檔測試、最後完整測試，並提交目前分支。
- `code-review`：完成後依 Standards／Spec 兩軸審查；此技能要求平行審查子代理。
- `playwright-cli`：驗證網站狀態、停止入口與安裝進度 UI。

只有實際修改 Streamlit 應用程式本身時，才另用 `developing-with-streamlit`；目前問題主要位於 VansPod 的工作與程序生命週期。

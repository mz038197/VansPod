# Windows Secure Storage 驗證

驗證日期：2026-10-12。範圍為 [Secure Storage ADR](../adr/0001-secure-storage.md)、[Client Route Lifecycle ADR](../adr/0005-client-route-lifecycle.md)、[Independent Client Routes ADR](../adr/0006-independent-claude-client-routes.md) 與 GitHub #8／#11／#19 的實際 Windows SEA 單一 EXE 生命週期；不是只執行編譯後的 JavaScript。

## 環境與重跑方式

- Windows `10.0.26300`、x64；Node.js `v24.19.0`。
- 系統內建 `C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe`，版本 `5.1.26100.9444`。
- 包含整合提交 `65925ea`，以及 #1 review 的資料驗證、模式寫入失敗補償與身分欄位共用 helper 修正。`npm test`：156／156 通過，無略過。
- 真實 SEA 驗證完成 21 組情境，全部通過，包含實際 Copy Key 與原剪貼簿完整還原。
- `npm run test:windows-exe` 先執行 `npm run dist`，再啟動真正的 `dist/VansPod.exe`；加解密使用真實 DPAPI CurrentUser，沒有替代加密器。
- 本次驗證 EXE 的 SHA-256：`ED50E817EA512F4C312B3AFEAA16D398071E38E31AB8120CED27A2F327D9C4FD`。打包包含建置路徑，其他目錄重新建置的雜湊可能不同。

在 Windows 安裝專案依賴後，可重跑：

```powershell
npm test
npm run test:windows-exe
```

測試在獨立暫存根目錄建立 Home、APPDATA、LOCALAPPDATA、TEMP、TMP 與三個可控的合成 client command，僅覆寫 EXE 子行程的環境。所有設定／儲存／ACL 目標均先確認位於該根目錄內。假 Router 只使用合成憑證，保留 Nickname Redeem、Course Catalog、Session Model Allowlist 與模型請求的既有 API 形狀。

`CLASSROOM_APP_HEADLESS=1` 關閉瀏覽器、系統匣及全域 Codex app-server 重啟；`CLASSROOM_APP_PORT` 選擇三個連續且可用的獨立 loopback 連接埠，分別驗證 Codex、Claude Code 與 VS Code Chat。另以實際 port holder 驗證第二、第三路由碰撞及 base-port emergency UI。正常啟動仍使用 47821、47822、47823。Catalog／Allowlist／Redeem 的網路請求有 5 秒截止時間，卡住的 Router 不會無限阻止啟動。

## Packaged multi-route 結果

真實 EXE 另完成以下 #19 驗收：三個 Client Route 的 Native／Classroom 與 adapter 偏好互相獨立；同一 Session Model Allowlist 分別出現在 Codex catalog、Claude `/v1/models` discovery 與移除 credential 欄位後的 VS Code provider；三路並行請求依 listener 決定 route identity 與 adapter，不依賴 User-Agent 或 path 猜測。清單外模型與 Native 後的 stale session 均在送 Router 前拒絕。

Claude 或 VS Code port 碰撞只讓該路由紅燈；解除碰撞後 Reload 會以 Native 恢復。base port 碰撞改用只提供 UI 的臨時 listener，Codex 顯示紅燈且該 listener 拒絕模型流量，其他路由維持獨立。失敗 refresh 保留上次成功清單；成功空清單讓所有 Classroom route 回到 Native。舊 VansPod provider 會遷移，含舊擴充 secret reference 的 provider 則拒絕接管並提供可重試的紅燈狀態。

Clear 的部分恢復失敗以真實共享讀取檔案鎖驗證：失敗路由保留 journal 並顯示紅燈，其他路由成功恢復；解除鎖定後 Reload 完成重試。測試在 switch、Reload、Stop、Clear 與 restart 後檢查個人設定及無關檔案，並掃描沙盒檔案、頁面、錯誤、stdout／stderr 與去敏後的 Router capture，未發現合成 Classroom API Key。

## 實際 EXE 結果

| 情境 | 結果與觀察 |
| --- | --- |
| Nickname Redeem | 成功保存整筆受保護連線；Class／Session／Nickname 的繁體中文與 emoji 正確顯示。 |
| malformed Router 回應 | 實際 EXE 接收 session 陣列與 class_name 數值兩種無效回應，原密文逐位元組不變，畫面／模式保留原課堂，代理仍使用原金鑰；重新啟動後亦保留原課堂。 |
| Copy Classroom API Key | 真實 EXE `/copy` 將當次金鑰放入剪貼簿，原生 helper 在記憶體中核對，最後完整恢復原有格式 ID、順序與每個格式的原始位元組，並再次讀回驗證完全相同。 |
| 同帳號跨行程恢復 | 結束 EXE 後重新啟動，可解密金鑰並恢復 Class Label、Nickname 與 Classroom Mode；以恢復的金鑰送出真實 HTTP 代理請求。 |
| 有效 Allowlist | 允許模型送 Router。請求清單外模型時明確拒絕，Router 不會收到被拒絕的模型 ID。 |
| 空／缺失 Allowlist | 重啟保留受保護憑證及身分，畫面與模型設定處於 Native，課堂代理拒絕請求；恢復清單後重新載入與切換可使用。 |
| Router 回傳離線錯誤 | 不刪除或重寫已存憑證。重啟維持 Native，稍後重新載入成功。 |
| Router 不回應模型清單 | 5 秒後受控完成啟動；不假裝有課堂模型，保留憑證，稍後可重新載入。 |
| 換堂 | 完成後當次畫面、Router 金鑰、模型清單與下一次啟動皆屬於新課堂。 |
| 換堂／清除失敗 | 使用獨立 PowerShell helper 以 `FileShare.Read` 鎖住合成資料，允許讀取但拒絕取代及刪除。動作提供可見錯誤，保留舊身分、Mode、可用金鑰及重啟結果；解除鎖定後可完成換堂。 |
| Persistent 清除 | 清除金鑰及相關身分、移除 Copy 入口、回到 Native，重啟不恢復。代理仍在運行，但不再提供課堂模型或送舊金鑰。 |
| 舊明文遷移成功 | 真實 DPAPI 加密、驗證並取代舊檔；只有金鑰的舊紀錄維持缺少 Class Label／Nickname，不捏造身分；重啟與代理可用。 |
| 遷移保存失敗、舊檔可刪除 | 只在暫存儲存目錄加入不繼承的建立檔案拒絕 ACL。受保護暫存檔建立失敗，但舊檔可刪除；舊憑證不啟用，畫面要求重新連線。 |
| 新 Temporary Connection | 在同一個建立檔案拒絕情境中，新兌換於安全清除舊資料後留在記憶體；因 Client Route 偏好無法安全保存而維持 Native，不寫明文、不接管 client，重新啟動不恢復。測試結束恢復 ACL。 |
| 明文取代與刪除皆失敗 | 真實檔案鎖令遷移及刪除失敗；金鑰不送 Router，畫面給出手動刪除指引。解除鎖定並重新成功兌換後，只剩受保護檔案。 |
| 既有密文不可解 | 合成損壞 DPAPI 封裝保留原樣，但不啟用金鑰；只有新的成功兌換才能取代。 |
| 遺留受保護暫存檔 | 留下完整密文暫存檔後重啟，僅載入正式提交的完整連線，不從暫存檔恢復半筆資料。 |
| 保存期間終止 EXE | 在另一堂兌換開始後的 150、450、900、1400 毫秒終止子行程，重啟均恢復完整的舊或新連線及相符金鑰／Allowlist；若 HTTP 動作已完成，重啟不得回到上一堂。這是觀察到的四次時序，不是所有指令邊界的證明。 |
| 個人設定與隔離 | 合成 Codex／Claude／VS Code 個人欄位及既有 Copilot provider 保留；真實使用者四份設定檔的前後 SHA-256 相同。只終止自己啟動的子行程。 |

## 洩密與失敗邊界

在正常保存、換堂、遷移完成、可清除的失敗路徑、清除與終止／重啟之後，遞迴掃描沙盒中的每個檔案，確認沒有合成 Classroom API Key、Class／Session 名稱或 Nickname 明文。HTTP 頁面及錯誤／代理回應不含金鑰；子行程 stdout／stderr 亦掃描合成敏感字串。保護與解密之間的資料只在記憶體與 stdin 中傳遞。

本次以 Windows 行程資訊實際觀察到 4 筆具備執行檔路徑與命令列的 PowerShell 子行程紀錄：均為系統內建路徑，命令列沒有合成憑證。行程取樣不能證明所有短命子行程均被觀察；此外，儲存邊界測試驗證 stdin 傳入、argv 不含秘密、錯誤輸出不外洩、輸出大小上限及逾時。

實際 Copy 測試前，helper 已完整備份剪貼簿的七個 HGLOBAL 格式：HTML Format、UnicodeText、Chromium internal source RFH token、Chromium internal source URL、Locale、Text、OEMText。資料只保留於 helper 記憶體，未列印或寫磁碟；以有效隱藏 owner HWND 及正確的 handle 所有權規則恢復。成功結果為 `actualCopyKey: true` 與 `exactFormatsAndBytesRestored: true`。若遇到不支援的 GDI／不可鎖定格式，腳本會在變更前拒絕；恢復若需重試，helper 保留備份直到驗證成功，父行程不逾時終止它。其他應用程式仍可能同時操作剪貼簿，測試沒有凍結整個桌面。

刻意鎖住而無法刪除的舊明文測試檔，在解鎖前仍包含合成舊金鑰：這是預期且明確回報的刪除失敗，不是假裝已完成清理。該憑證完全不啟用；解鎖後重新安全兌換，確認明文消失。測試不宣稱一般檔案刪除能物理抹除磁碟殘留。

沒有執行實際環境／課程安裝指令；安裝指令保留、輸出隱藏金鑰及既有路由／provider 行為由 `npm test` 的回歸測試覆蓋。Windows 不需要 PowerShell 7 或 Native Addon 才能完成本次實際儲存生命週期。

## 尚未驗證

- 第二個 Windows 使用者帳號解密失敗：沒有建立或使用第二個測試帳號；改變 USERPROFILE 不算不同 DPAPI 身分。
- 在每一個檔案取代指令邊界精確終止行程：儲存邊界有保護、驗證、寫入／取代與刪除失敗測試，實際 EXE 有四次終止時序與遺留密文暫存檔測試，但未窮盡所有中斷點。

本報告驗證 Encryption at Rest；不宣稱能阻止同一 Windows 使用者呼叫 DPAPI，或讀取程序記憶體／剪貼簿。

## Review 回歸

公共核心／儲存 seam 回歸涵蓋無效連線在保存或 fallback 前拒絕，以及模式客戶端寫入失敗後回到 Native、恢復設定、補償保存 Native，補償失敗時的受控部分失敗提示。嚴格模式保存失敗保留原模式；Copilot 的獨立 Classroom 路由行為維持原規格。

## 設定頁與路由修改整合後驗證

2026-10-11 將既有設定頁、安裝進度、Codex 個人路由還原修改（`dff869e`）及票單草稿（`749dbf3`）與 Secure Storage 的 `82a85f2` 整合。保留版本化連線保存、操作序列、金鑰隱藏及 Native 失敗補償，同時保留連線表單草稿與模型重啟提醒。

- `npm test`：163／163 通過。
- 重新打包的真實 Windows SEA EXE 完整 21 組情境通過；Copy 的原始剪貼簿格式、順序及位元組完整還原，真實個人設定檔雜湊未改變。
- 本次 EXE SHA-256：`567B2514785DAAB64EE15D7D6396BD308376043D28D836359330740F5779C3B7`。
- 實際觀察 6 筆系統內建 PowerShell 子行程命令列，未含合成金鑰。
- EXE 測試改為檢查實際 Copy 表單，避免新增前端腳本的 `/copy` 選擇器或標籤大小寫造成誤判；代理、密文及重啟檢查保留。

上述第二 Windows 帳號與所有精確中斷邊界的未驗證限制維持不變。

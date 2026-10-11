# Windows Secure Storage 驗證

驗證日期：2026-10-11。範圍為 [Secure Storage ADR](../adr/0001-secure-storage.md) 與 GitHub #8 的實際 Windows SEA 單一 EXE 生命週期；不是只執行編譯後的 JavaScript。

## 環境與重跑方式

- Windows `10.0.26300`、x64；Node.js `v24.19.0`。
- 系統內建 `C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe`，版本 `5.1.26100.9444`。
- 包含整合提交 `c36cbea` 的核心、儲存與路由修正，以及此票的啟動控制。`npm test`：151／151 通過，無略過。
- `npm run test:windows-exe` 先執行 `npm run dist`，再啟動真正的 `dist/classroom-app.exe`；加解密使用真實 DPAPI CurrentUser，沒有替代加密器。
- 本次驗證 EXE 的 SHA-256：`30AEF8BF28D985113448E65D9B00F361C1380FC8836D113D8A35F8557D66BCAD`。打包包含建置路徑，其他目錄重新建置的雜湊可能不同。

在 Windows 安裝專案依賴後，可重跑：

```powershell
npm test
npm run test:windows-exe
```

測試在獨立暫存根目錄建立 Home、APPDATA、LOCALAPPDATA、TEMP 與 TMP，僅覆寫 EXE 子行程的環境。所有設定／儲存／ACL 目標均先確認位於該根目錄內。假 Router 只使用合成憑證，保留 Nickname Redeem、Course Catalog、Session Model Allowlist 與模型請求的既有 API 形狀。

`CLASSROOM_APP_HEADLESS=1` 關閉瀏覽器、系統匣及全域 Codex app-server 重啟；`CLASSROOM_APP_PORT` 選擇有效且非零的獨立 loopback 連接埠。正常啟動仍使用原本的桌面行為與 47821。Catalog／Allowlist／Redeem 的網路請求有 5 秒截止時間，卡住的 Router 不會無限阻止啟動。

## 實際 EXE 結果

| 情境 | 結果與觀察 |
| --- | --- |
| Nickname Redeem | 成功保存整筆受保護連線；Class／Session／Nickname 的繁體中文與 emoji 正確顯示。 |
| Copy Classroom API Key | 真實 EXE `/copy` 將當次金鑰放入剪貼簿，原生 helper 在記憶體中核對，最後完整恢復原有格式 ID、順序與每個格式的原始位元組，並再次讀回驗證完全相同。 |
| 同帳號跨行程恢復 | 結束 EXE 後重新啟動，可解密金鑰並恢復 Class Label、Nickname 與 Classroom Mode；以恢復的金鑰送出真實 HTTP 代理請求。 |
| 有效 Allowlist | 允許模型送 Router。請求清單外模型時沿用原有替代行為，Router 收到清單內模型，未收到被拒絕的模型 ID。 |
| 空／缺失 Allowlist | 重啟保留受保護憑證及身分，畫面與模型設定處於 Native，課堂代理拒絕請求；恢復清單後重新載入與切換可使用。 |
| Router 回傳離線錯誤 | 不刪除或重寫已存憑證。重啟維持 Native，稍後重新載入成功。 |
| Router 不回應模型清單 | 5 秒後受控完成啟動；不假裝有課堂模型，保留憑證，稍後可重新載入。 |
| 換堂 | 完成後當次畫面、Router 金鑰、模型清單與下一次啟動皆屬於新課堂。 |
| 換堂／清除失敗 | 使用獨立 PowerShell helper 以 `FileShare.Read` 鎖住合成資料，允許讀取但拒絕取代及刪除。動作提供可見錯誤，保留舊身分、Mode、可用金鑰及重啟結果；解除鎖定後可完成換堂。 |
| Persistent 清除 | 清除金鑰及相關身分、移除 Copy 入口、回到 Native，重啟不恢復。代理仍在運行，但不再提供課堂模型或送舊金鑰。 |
| 舊明文遷移成功 | 真實 DPAPI 加密、驗證並取代舊檔；只有金鑰的舊紀錄維持缺少 Class Label／Nickname，不捏造身分；重啟與代理可用。 |
| 遷移保存失敗、舊檔可刪除 | 只在暫存儲存目錄加入不繼承的建立檔案拒絕 ACL。受保護暫存檔建立失敗，但舊檔可刪除；舊憑證不啟用，畫面要求重新連線。 |
| 新 Temporary Connection | 在同一個建立檔案拒絕情境中，新兌換於安全清除舊資料後留在記憶體；當次可代理，不寫明文，重新啟動不恢復。測試結束恢復 ACL。 |
| 明文取代與刪除皆失敗 | 真實檔案鎖令遷移及刪除失敗；金鑰不送 Router，畫面給出手動刪除指引。解除鎖定並重新成功兌換後，只剩受保護檔案。 |
| 既有密文不可解 | 合成損壞 DPAPI 封裝保留原樣，但不啟用金鑰；只有新的成功兌換才能取代。 |
| 遺留受保護暫存檔 | 留下完整密文暫存檔後重啟，僅載入正式提交的完整連線，不從暫存檔恢復半筆資料。 |
| 保存期間終止 EXE | 在另一堂兌換開始後的 150、450、900、1400 毫秒終止子行程，重啟均恢復完整的舊或新連線及相符金鑰／Allowlist；若 HTTP 動作已完成，重啟不得回到上一堂。這是觀察到的四次時序，不是所有指令邊界的證明。 |
| 個人設定與隔離 | 合成 Codex／Claude／VS Code 個人欄位及既有 Copilot provider 保留；真實使用者四份設定檔的前後 SHA-256 相同。只終止自己啟動的子行程。 |

## 洩密與失敗邊界

在正常保存、換堂、遷移完成、可清除的失敗路徑、清除與終止／重啟之後，遞迴掃描沙盒中的每個檔案，確認沒有合成 Classroom API Key、Class／Session 名稱或 Nickname 明文。HTTP 頁面及錯誤／代理回應不含金鑰；子行程 stdout／stderr 亦掃描合成敏感字串。保護與解密之間的資料只在記憶體與 stdin 中傳遞。

本次以 Windows 行程資訊實際觀察到 6 筆具備執行檔路徑與命令列的 PowerShell 子行程紀錄：均為系統內建路徑，命令列沒有合成憑證。行程取樣不能證明所有短命子行程均被觀察；此外，儲存邊界測試驗證 stdin 傳入、argv 不含秘密、錯誤輸出不外洩、輸出大小上限及逾時。

實際 Copy 測試前，helper 已完整備份剪貼簿的七個 HGLOBAL 格式：HTML Format、UnicodeText、Chromium internal source RFH token、Chromium internal source URL、Locale、Text、OEMText。資料只保留於 helper 記憶體，未列印或寫磁碟；以有效隱藏 owner HWND 及正確的 handle 所有權規則恢復。成功結果為 `actualCopyKey: true` 與 `exactFormatsAndBytesRestored: true`。若遇到不支援的 GDI／不可鎖定格式，腳本會在變更前拒絕；恢復若需重試，helper 保留備份直到驗證成功，父行程不逾時終止它。其他應用程式仍可能同時操作剪貼簿，測試沒有凍結整個桌面。

刻意鎖住而無法刪除的舊明文測試檔，在解鎖前仍包含合成舊金鑰：這是預期且明確回報的刪除失敗，不是假裝已完成清理。該憑證完全不啟用；解鎖後重新安全兌換，確認明文消失。測試不宣稱一般檔案刪除能物理抹除磁碟殘留。

沒有執行實際環境／課程安裝指令；安裝指令保留、輸出隱藏金鑰及既有路由／provider 行為由 `npm test` 的回歸測試覆蓋。Windows 不需要 PowerShell 7 或 Native Addon 才能完成本次實際儲存生命週期。

## 尚未驗證

- 第二個 Windows 使用者帳號解密失敗：沒有建立或使用第二個測試帳號；改變 USERPROFILE 不算不同 DPAPI 身分。
- 在每一個檔案取代指令邊界精確終止行程：儲存邊界有保護、驗證、寫入／取代與刪除失敗測試，實際 EXE 有四次終止時序與遺留密文暫存檔測試，但未窮盡所有中斷點。

本報告驗證 Encryption at Rest；不宣稱能阻止同一 Windows 使用者呼叫 DPAPI，或讀取程序記憶體／剪貼簿。

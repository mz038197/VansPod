# 使用跨平台 Secure Storage 保護 Classroom Connection

VansPod 原先把 Classroom API Key 明文存於本機 `connection.json`，任何能讀取該檔案的程式都可能直接取得金鑰。我們決定以跨平台的 Secure Storage 介面隔離憑證儲存，先實作 Windows DPAPI；目標是**防止單靠讀取持久化檔案就取得明文憑證**，而非阻止同一使用者權限下的惡意程式使用作業系統解密能力。

## Decision

- VansPod 的核心依賴可替換的 Secure Storage 介面（`get / set / delete`），而非直接依賴 DPAPI。未來 Discord Bot Token 等敏感資料可沿用此介面，但這次只遷移 Classroom Connection。
- Windows Adapter 採用 **DPAPI CurrentUser**。以 Windows 內建的 `powershell.exe` 呼叫 .NET `ProtectedData`，避免 Native Addon 對 Node.js SEA 單一 EXE 的打包負擔；敏感資料以 **stdin** 傳給子行程，不出現在命令列參數、暫存腳本、日誌或錯誤訊息中。
- 持久化單位是同一筆受保護的 Classroom Connection 資料：Classroom API Key、Class Label 所需的課堂資料、暱稱與 Model Switch 選擇等必要狀態一起儲存；檔案只包含可辨識版本的加密封裝，不另外寫入明文金鑰或課堂身分資訊。保留學生手動複製 API Key 到剪貼簿的功能，但畫面不回顯金鑰。
- macOS 與 Linux 的平台安全儲存 Adapter 留待後續實作。現階段僅提供 **Temporary Classroom Connection**（行程內記憶體），不以自訂 AES／寫死在程式裡的共用金鑰／明文檔案替代平台安全儲存。
- 平台安全儲存暫時不可用時，允許新兌換的課堂連線僅在記憶體內使用，關閉行程即失效；正常的記憶體模式不額外顯示警告。這不授權讀取既有明文檔案作為 fallback。

## Legacy migration and failure handling

持久化位置為使用者目錄的 `.vanspod/connection.json`。首次啟動會將舊 `%LOCALAPPDATA%/classroom-app/connection.json` 移至新位置；若新位置已有連線，以新位置為準並移除舊檔，避免清除後重新恢復舊課堂。加密方式維持 DPAPI CurrentUser。

1. 啟動時若發現舊版明文 `connection.json`，先加密並驗證可解密，再安全地替換為加密封裝；成功後不得留下可正常存取的明文舊檔。
2. **明文遷移失敗**時，刪除舊明文憑證並要求重新進行 Nickname Redeem（此決策取代先前「失敗保留舊檔」的想法）。若刪除失敗，停止使用該憑證並提示手動清除，不允許明文 fallback。一般檔案刪除不等於物理安全抹除。
3. **既有密文無法解密**時，保留密文但不得使用，要求重新兌換；新兌換成功後方可取代原有資料。
4. **換堂兌換**若不能安全替換或清除舊持久化連線，不得啟用可能在重啟後回到舊課堂的新記憶體連線；應拒絕切換並保留原本狀態。若已安全移除舊連線但無法持久化新連線，才可使用記憶體模式。
5. **清除連線**必須清除記憶體與持久化的課堂憑證及相關課堂資料，並退回 Native；其他客戶端設定不受影響。

## Restart and router behavior

- VansPod 啟動時，若可恢復 Persistent Classroom Connection，就恢復 Classroom API Key、Class Label 與先前的 Model Switch 選擇，並重新取得 Course Catalog 及 Session Model Allowlist。
- Router 暫時連不上時，不刪除有效儲存的憑證。沒有可用的 Session Model Allowlist 就不能假裝 Classroom 模型可用；稍後允許重新載入。已在執行中的先前成功清單仍遵守原有的暫留規則。
- Temporary Classroom Connection 不會跨行程恢復，也不得令下一次啟動意外恢復到更早的課堂。

## Rejected alternatives and consequences

- 不採用「自行用 AES 加密但把共用加密金鑰內建在 App」：跨平台雖容易，卻可透過取得程式內金鑰還原憑證。也不直接將核心綁定 Windows API，以保留未來 macOS Keychain／Linux Secret Service 的 Adapter 空間。
- 代價是 Windows 需維護 PowerShell 子行程橋接與 SEA 相容性；其他平台暫不能持久化課堂連線。DPAPI CurrentUser **不是應用程式隔離**：同一 Windows 使用者身分下的其他程式仍可能呼叫 DPAPI 或竊取執行時金鑰。

## Verification

- **單元測試**：Secure Storage 抽象、連線儲存／讀取／清除、明文遷移與刪除失敗、密文解密失敗、記憶體模式、換堂一致性、重啟後恢復連線與 Model Switch，以及 Router 暫時失敗。
- **Windows 整合測試**：DPAPI CurrentUser 同帳號跨行程加解密、在可建立第二測試帳號的環境驗證跨使用者不可直接解密、磁碟不含明文、API Key 不進入子行程命令列／日誌，並對打包後的 SEA EXE 進行實際驗證。

本 ADR 記錄決策與驗收範圍，**不代表功能已實作**。

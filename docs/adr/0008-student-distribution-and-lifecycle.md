# 學生以 exe 或 npm 手動啟動同一個 VansPod

2026-10-14，grill-with-docs 討論中 Q1～Q10、Q12～Q21 已確認；Q11 的「通通刪除」已由 Q12 界定範圍。使用者已確認整體共識，並以 implement 授權實作；指令名稱採用 `vanspod start`，取代原提案的 `vanspod open`。公開發佈尚未執行。

VansPod 本身協助學生準備開發環境，因此提供包含 Node runtime 的 Windows exe 作為教材主要入口，同時提供 npm 安裝給已有 Node.js 的學生；兩種入口提供相同功能。第一版完整使用體驗以 Windows 為支援範圍，macOS 與 Linux 留待後續驗證與支援，不能以提供 npm 套件等同完整跨平台支援。

學生手動啟動後，VansPod 在背景執行；關閉瀏覽器或啟動用終端機不結束服務。電腦重新啟動後，學生須再次手動開啟 VansPod，不設定開機自動啟動。此選擇讓兩種入口維持相同的課堂使用習慣，也避免把 VansPod 預設為持續開機常駐的服務。

## 同一個執行中的 VansPod

同一個 Windows 使用者的 exe 與 npm 入口共用一個執行中的 VansPod。再次雙擊 exe、執行 `vanspod` 或 `vanspod start`，皆開啟既有畫面，不建立第二套代理。

系統匣「結束 VansPod」與 `vanspod stop` 採用相同的結束流程：恢復被接管的客戶端個人設定，停止本機服務，保留已保存的 Classroom Connection 與每個客戶端上次的 Model Switch 選擇。下次啟動按既有規則恢復，仍須重新確認課堂連線與模型可用性；結束程式不等於 Clear Classroom Connection。設定恢復遵守 ADR-0005，失敗時保留 VansPod 執行與必要備份並顯示原因，允許重試，不得宣稱已恢復。

## 交付與更新

exe 維持單檔交付，學生下載後放在固定資料夾即可執行，第一版不另做安裝精靈；logo 與執行所需資產均包含在 exe 中。學生可自行建立桌面捷徑，移動或更換 exe 不影響使用者目錄中的設定。

第一版採用手動更新，老師可指定課堂版本，上課途中不自動換版。更新前先結束 VansPod；exe 下載新版替換，npm 安裝指定版本，更新保留課堂連線與設定。

本文件記錄目標決策，不表示現有 exe 已具備完整背景生命週期或 npm 發佈功能。

## 已確認的操作邊界

- Q8：結束時若任一客戶端個人設定恢復失敗，保留 VansPod 執行並顯示失敗的客戶端，允許重試結束；已恢復的客戶端維持個人設定，失敗的保留備份。
- Q9：尚未執行時，`vanspod start` 與 `vanspod` 均啟動服務並開啟瀏覽器。啟動成功後可關閉啟動用終端機；失敗須回報清楚錯誤。
- Q10：第一版提供 `vanspod`、`vanspod start`、`vanspod status`、`vanspod stop`、`vanspod --version`、`vanspod --help`。課堂連線、模型切換與課程安裝在瀏覽器操作；`status`、`--version`、`--help` 不啟動服務。`status` 顯示是否執行中、執行中的版本與本機網址；`--version` 顯示目前指令所屬的安裝版本。
- Q11 由 Q12 釐清：完整移除刪除 VansPod 程式及它自己的全部資料，包括課堂憑證、偏好、模式記憶、日誌與暫存檔。先恢復客戶端設定，確認成功後才清除 VansPod 的備份；保留學生的課程專案、作品、Node／Git／VS Code 與客戶端原有個人設定。exe 與 npm 共用資料。
- Q13：正在安裝環境或課程專案時，結束操作提示安裝中、請完成後再結束；本次不退出，也不強制中斷安裝。
- Q14：有模型請求進行中時，結束操作須確認中斷目前回答；確認後才取消請求、恢復客戶端設定並退出。沒有請求時直接執行結束流程。畫面與 `vanspod stop` 遵守相同規則，命令列無法互動確認時回報原因並保持執行。
- Q15：頁面提供「移除 VansPod」，命令列提供 `vanspod uninstall`；兩者先列出刪除內容，學生確認後才恢復客戶端設定、停止服務、移除程式與 VansPod 資料。安裝中禁止移除；設定恢復失敗時保留程式與備份供重試。教材統一使用完整移除入口。
- Q16：同時存在 exe 與 npm 入口時，完整移除涵蓋兩者；只處理可確認屬於 VansPod 的安裝位置與檔案，不掃描整台電腦找同名 exe。未登記的其他副本提示學生自行刪除；保留程式所在資料夾的其他檔案。
- Q17：exe 透過本 GitHub 專案 Releases 提供，npm 版發佈至公開 npm registry，學生無須登入 npm 即可安裝；兩者使用相同版本號。套件包含可執行 JavaScript 與必要資產，不包含學生的課堂憑證。
- Q18：開啟入口版本與執行中版本不同時，仍開啟既有畫面並顯示兩個版本不同，不自動替換執行中的程式。換版須先結束目前 VansPod，再開啟指定版本。
- Q19：npm 套件首選名稱為 `vanspod`，安裝指令為 `npm install -g vanspod`；若正式發佈時無法使用，改採使用者持有的 npm scope，並回報確切名稱。2026-10-14 公開 registry 查不到 `vanspod`，不代表已保留名稱或保證可以發佈。
- Q20：設定已恢復但部分程式或資料刪除失敗時，明確顯示移除未完成、列出剩餘項目並保留重試入口。程式與移除工具安排於清理流程最後刪除，不將部分成功顯示為完整移除。
- Q21：教材僅教頁面「移除 VansPod」或 `vanspod uninstall` 作為完整移除方法。直接刪除 exe 或 `npm uninstall -g vanspod` 無法保證清除資料與恢復客戶端設定；完整清理須在 VansPod 程式仍存在時執行。

## npm 完整移除的技術依據

npm 官方 Scripts 文件明確指出 npm v7 起不支援卸載 lifecycle hooks，因此不能依賴 `preuninstall`、`uninstall` 或 `postuninstall` 完成產品清理。完整移除入口須先完成 VansPod 清理，再移除 npm 套件。

來源：[npm Scripts：卸載腳本限制](https://docs.npmjs.com/cli/v12/using-npm/scripts/#a-note-on-a-lack-of-npm-uninstall-scripts)、[vanspod 公開 registry](https://registry.npmjs.org/vanspod)。

## 品牌資產

沿用使用者指定的專案 logo，統一 exe／捷徑、Windows 系統匣與瀏覽器 favicon。exe 的必要品牌資產須包含於單檔交付，npm 套件亦須包含相同資產，不依賴建置機器上的檔案路徑。

## 實作

啟動入口與背景服務分開，以使用者專屬的執行紀錄辨識同一實例；本機管理 API 使用每個實例的隨機授權值，拒絕不符合本機網址或來源的管理操作。`status --json` 提供可供驗證使用的非憑證狀態。

課堂憑證與偏好沿用 `~/.vanspod`；執行紀錄、安裝位置、系統匣資產和移除工具位於 `%LOCALAPPDATA%/VansPod`。分開管理是為了保留 ADR-0001 的安全儲存不可用時暫時連線行為：課堂資料夾不可寫，不應讓整個程式無法啟動。完整移除的確認畫面包含兩個資料位置。

Windows 移除工具使用獨立隱藏視窗，在背景服務及提出移除要求的 exe 退出後才刪除已登記程式。exe 以登記時的 SHA-256 確認內容，npm 以套件位置、名稱與 bin 確認；拒絕跨越資料目錄的刪除與 reparse point，保留資料夾內非 VansPod 的檔案。部分刪除失敗時保留完整計畫、移除工具與失敗項目，允許重試。

單檔 exe 內含 logo、icon、系統匣與移除腳本；npm 套件包含編譯後程式與同樣資產，排除測試、exe 與 SEA 暫存產物。公開 npm／GitHub 發佈仍是後續操作。

# 版本更新 Windows 實機驗收

本文件記錄 ADR-0010「版本更新」以真的 exe 做的隔離驗收。自動測試涵蓋管理 API、更新工具與下載驗證，但從原始碼執行的 VansPod 不會真的換 exe，所以 exe 換版要用兩個建置出來的 exe 手動驗。

## 準備

1. 把 `src/version.ts` 與 `package.json` 暫時改成 `0.2.1`，執行 `npm run dist`，把 `dist/VansPod.exe` 與 `dist/VansPod.exe.br` 複製到 `<驗收>/release/v0.2.1/`，並在同一個資料夾產生 `SHA256SUMS.txt`（每個檔案一行 `<sha256>  <檔名>`，與 `release.yml` 的 Create checksum 相同）。要驗沒有壓縮版的舊 Release 時，只放 `VansPod.exe` 並只列它那一行。
2. 改回 `0.2.0`，再執行一次 `npm run dist`，把 `dist/VansPod.exe` 複製到 `<驗收>/student/`。確認 `git diff src/version.ts` 沒有變化。
3. 在本機開一個 HTTP 服務：`/vanspod/latest` 回 `{"name":"vanspod","version":"0.2.1"}`，`/download/<路徑>` 回 `<驗收>/release/<路徑>` 的檔案。

## 執行

用隔離的使用者目錄啟動學生的 exe，避免動到本機真正的客戶端設定：

```sh
USERPROFILE=<驗收>\home HOME=<驗收>\home APPDATA=<驗收>\home\roaming LOCALAPPDATA=<驗收>\home\local \
CLASSROOM_APP_HEADLESS=1 CLASSROOM_APP_PORT=51000 \
VANSPOD_UPDATE_REGISTRY=http://127.0.0.1:48900/vanspod/latest \
VANSPOD_UPDATE_DOWNLOADS=http://127.0.0.1:48900/download \
<驗收>/student/VansPod.exe start
```

在瀏覽器開 `http://127.0.0.1:51000/`，按側欄底部的更新按鈕，確認對話框顯示 v0.2.0 → v0.2.1 與要取代的 exe 路徑，再按「立即更新」。

## 預期結果

- 頁面顯示「重新連線中…」，之後自動重新載入，版本標籤變成 v0.2.1，並短暫顯示「已更新到 v0.2.1」。不會另開新分頁。
- `<驗收>/student/VansPod.exe` 的 SHA-256 等於 release 的 `SHA256SUMS.txt` 中 `VansPod.exe` 那一行，旁邊沒有 `.old` 或 `.new`。
- HTTP 服務的紀錄只出現 `VansPod.exe.br` 的下載，沒有完整 `VansPod.exe`。
- `<驗收>/home/local/VansPod/installations.json` 的 `sha256` 換成新 exe 的值，完整移除仍能辨認它。
- `update-plan.json`、`update-ready`、`update-tool.ps1` 都已清掉；`update-result.json` 在頁面讀到結果後被刪除。

## 2026-10-19 結果

依上述步驟通過。驗收過程抓到兩個問題，已補自動測試並修正：更新工具繼承了舊 worker 的 `VANSPOD_WORKER_TOKEN`，使重新啟動被拒絕；以及更新結果在新版就緒後才寫出，頁面要稍等才讀得到。

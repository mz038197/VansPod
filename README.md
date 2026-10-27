# VansPod

VansPod 是 Windows 學生使用的本機課堂入口。提供含 Node runtime 的單檔 `VansPod.exe`，以及給已有 Node.js 24 以上環境的 npm 套件；兩者共用同一個背景服務和學生設定。

## 學生操作

雙擊 exe 或執行 `vanspod start`，會啟動背景服務並開啟瀏覽器。再開一次會回到既有畫面；關閉瀏覽器或啟動用終端機不會停止課堂代理。Windows 右下角的 VansPod logo 可重新開啟畫面，右鍵「結束 VansPod」可恢復客戶端個人設定後退出。電腦重新啟動後須手動開啟，不設定開機自動啟動。

已有 Node.js 24 以上的學生可從 npm 安裝：

```powershell
npm install -g vanspod
vanspod start
```

| 指令 | 用途 |
| --- | --- |
| `vanspod` / `vanspod start` | 啟動並開啟瀏覽器，或開啟既有畫面 |
| `vanspod status` | 顯示是否執行中、執行版本、PID 與本機網址 |
| `vanspod stop` | 恢復客戶端設定後結束，保留課堂連線與模式記憶 |
| `vanspod uninstall` | 列出刪除內容，確認後完整移除 |
| `vanspod --version` / `vanspod --help` | 顯示安裝版本／說明，不啟動服務 |

安裝環境或課程專案時不能結束或移除。模型回答中須確認中斷；命令列無法互動確認時保持執行。設定恢復失敗會保留服務與備份，顯示失敗的客戶端並允許重試。

完整移除請用頁面的「移除 VansPod」或 `vanspod uninstall`。這會先恢復客戶端設定，再清理 VansPod 憑證、偏好、日誌、暫存與已登記的 exe／npm 安裝；保留學生作品、課程專案、Node、Git、VS Code 和客戶端個人設定。結果以 Windows 訊息顯示，刪除失敗會保留移除工具和失敗項目供重試；未登記的其他 exe 副本須自行刪除。直接刪 exe 或 `npm uninstall -g vanspod` 無法保證完整清理。

更新前先結束 VansPod。exe 下載指定版本替換，npm 使用 `npm install -g vanspod@<老師指定版本>`；兩者使用相同版本號，上課途中不自動更新。開啟入口與執行版本不同時會提示，先結束才能換版。

## 開發與本機打包

```powershell
npm install
npm run typecheck
npm test
npm start
npm run dist
npm pack --pack-destination dist
```

exe 產物為 `dist/VansPod.exe`，本機套件為 `dist/vanspod-0.4.11.tgz`；可在 Windows 用 `npm install -g <套件路徑>` 安裝測試。圖片、favicon、系統匣與移除腳本均包含在發佈產物中。更新 logo 後執行 `powershell.exe -NoProfile -File scripts/build-icon.ps1` 重建多尺寸 Windows icon。

exe 發佈管道為本專案 GitHub Releases，npm 為公開 registry 的 [`vanspod`](https://www.npmjs.com/package/vanspod) 套件。更新時不要執行完整移除，否則會清除課堂資料。

## GitHub Actions 發佈

一般 push 不發佈；推送 `v*` tag 會在 Windows runner 安裝 Node.js 24、檢查型別、執行測試、打包並驗證 exe／npm 生命週期，全部通過後才建立 GitHub Release，最後發佈 npm 套件。學生從 Release 下載 `VansPod.exe`，同頁提供 `SHA256SUMS.txt`。Release 另附 brotli 壓縮的 `VansPod.exe.br`（約三分之一大小），程式內更新只下載這份，解壓後再比對 `VansPod.exe` 的 SHA-256；SHA256SUMS 沒列出它的舊版 Release 則下載完整 exe。

發版前同步 `package.json`、`package-lock.json` 與 `src/version.ts` 的版本；tag 必須等於 `v` 加版本號，否則流程失敗。以 `0.4.11` 為例：

```powershell
git push origin master
git tag -a v0.4.11 -m "VansPod 0.4.11"
git push origin v0.4.11
```

新版本使用新的版本號與 tag。相同 tag 的 Actions 重跑會更新該 Release 的產物。

## 發佈 npm

GitHub Release 建立後，同一流程以 npm Trusted Publishing（OIDC）發佈 `vanspod`，不在 GitHub 保存 npm token，並附上來源證明（provenance）。npm 上須將 `mz038197/VansPod` 的 `release.yml` 設為 Trusted Publisher。npm 已有該版本時略過發佈，因此重跑同一 tag 只更新 Release 產物。

可用 `npm view vanspod dist-tags` 確認 `latest`。npm 同一版本號只能發佈一次，發佈 72 小時後幾乎無法撤下。若 Actions 的 npm 步驟失敗，修正後重跑該 tag，或由維護者在本機 PowerShell 執行 `npm publish` 並完成 2FA。

本機課堂 app。規格是 [classroom-one-click-install#8](https://github.com/mz038197/classroom-one-click-install/issues/8)。

不放進凡思課堂安裝擴充，也不從 opencodex fork。領域詞以該 repo 的 CONTEXT.md 為準。視窗決定見該 repo 的 ADR 0017。

設計與操作邊界見 [ADR-0008](docs/adr/0008-student-distribution-and-lifecycle.md)。

## Classroom 上游 API

模型區提供各客戶端的上游 API 選項：Codex 可選 Responses／Chat，Claude Code 可選 Responses／Chat／Messages，兩者均預設 Responses。選擇保存在使用者目錄的 `.vanspod/settings.json`，與課堂憑證分開；重啟、切換模型、清除或重新兌換課堂不會移除偏好。此選項只影響 Classroom 模式的下一個請求。

共用 Adapter 介面下的三個實作負責請求、上游呼叫與回應轉換；所有程式都在 VansPod 內，不需要 opencodex 專案。支援多輪文字、圖片輸入、函式工具往返與串流／非串流；Chat 路徑沿用 Codex 自訂工具的文字包裝及 `apply_patch` 修復。

跨協定不能對等保留的資料會明確報錯，例如 Claude 的 thinking／簽章、工具結果的 `is_error`、快取控制或服務端工具，以及 Codex 的加密 reasoning 或工具 namespace。Chat 自訂工具將完整的 Lark／regex grammar 定義保留在 input schema 的描述中，作為模型指令；Chat 不提供 Responses 原生 grammar 的受限解碼保證。原協定直通可保留其原有資料；轉換失敗不會自動換 adapter 重送。使用者取消或客戶端斷線會中止本機上游請求，串流缺少完成事件會回報失敗。

協定轉換參考官方 [Chat API](https://developers.openai.com/api/reference/resources/chat)、[Responses API](https://developers.openai.com/api/reference/resources/responses) 與 [Claude 串流事件](https://platform.claude.com/docs/en/build-with-claude/streaming)。

驗證指令：`npm run typecheck`、`npm test`、`npm run test:windows-exe`。Windows 驗證使用隔離的合成 USERPROFILE／APPDATA 與模擬 Router，涵蓋三個 Client Route、47821～47823／自訂 base port、port collision、獨立模式與 adapter、client-native catalog、失敗恢復，以及五條 JSON／SSE adapter 路徑；測試前後亦確認真實使用者設定未變。通過不表示實際 Router 或模型已完成端到端驗證。

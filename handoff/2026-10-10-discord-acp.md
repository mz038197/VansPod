# Discord 連線用 TypeScript 寫進 VansPod

> **2026-10-11 更新**：這是早期交接筆記，並非最新實作規格。後續 Q1～Q41 已定案的行為（Agent 安裝與選擇、Thread／Session、Queue、Private／Public、ACP Approval）請優先閱讀 [Discord Agent 設計決策](../docs/design/discord-agent.md)、[ADR-0002](../docs/adr/0002-local-discord-acp-agent.md) 與 [ADR-0003](../docs/adr/0003-discord-agent-access-and-approvals.md)。下方內容保留作為歷史背景；與新文件衝突時以新文件為準。尚未開始實作。

日期：2026-10-10

下一輪要做的事：在 VansPod 裡加一段本機 Discord Gateway，讓學生貼自己的 bot token 和頻道 ID 後，討論串的話能交給這台電腦上的 ACP CLI。不要另編 OpenAB 的 Windows 執行檔，也不要把 OpenAB 原始碼併進來。

## 已拍板

- 學生只安裝 VansPod，同時有現有的課堂連線，以及自己的 Discord 機器人。
- 每個學生用自己的 bot token。全班共用一顆 token 會在 Discord Gateway 上互相踢下線。
- Token 和頻道 ID 留在學生電腦，不送到課堂 router。
- Discord 方向是本機主動連出去。不要加 Cloudflare Tunnel、nginx，也不要對外開 VansPod 的 `127.0.0.1:47821`。
- 連接埠不用跟現有頁面共用。Gateway 本身不需要聽一個公開 port。

學生貼 token 之前仍要自己完成：在 Discord Developer Portal 建機器人、打開 Message Content Intent、把機器人邀請進伺服器。Token 裡沒有頻道，所以 UI 還要收頻道 ID。

## 實作範圍

只對齊 OpenAB 這三個檔的行為，不逐行翻譯：

- Discord 收訊與討論串：https://github.com/openabdev/openab/blob/main/crates/openab-core/src/discord.rs
- ACP 子行程與 stdio JSON-RPC：https://github.com/openabdev/openab/blob/main/crates/openab-core/src/acp/connection.rs
- 一個討論串一支行程：https://github.com/openabdev/openab/blob/main/crates/openab-core/src/acp/pool.rs

行為：

1. 用 `discord.js` 連 Gateway。
2. 允許的頻道裡，被 @ 才開新討論串。同一串裡的後續訊息不用再 @。
3. 該討論串第一次要回覆時拉起一支 ACP CLI，之後沿用。
4. 對那支行程送 `session/new` 與 `session/prompt`，把回覆貼回 Discord。
5. VansPod 負責從畫面收下 token、頻道 ID，並啟動這段連線。現有的 `spawn` 在 `src/start.ts`。課堂連線與 Codex、Claude、VS Code 設定仍走 `src/classroomApp.ts`，不要改那條路徑的語意。

ACP CLI 用學生機器上已經裝好的程式。模型要打哪一台伺服器，沿用 VansPod 已經寫進本機設定的 base URL，不要在 Discord 這段再寫一份。

## 明確不做

Slack、LINE、Telegram、飛書、Kubernetes、Helm、AWS、cron、語音轉文字、slash command、表情反應、控制平面、多機器人協作。OpenAB `0.10.0-beta.5` 發布檔沒有 Windows 執行檔，所以不走「打包 openab.exe」這條。

OpenAB 本身：https://github.com/openabdev/openab

## 現有程式

- 產品邊界與啟動方式：`README.md`
- 規格來源：https://github.com/mz038197/classroom-one-click-install/issues/8
- 領域詞與視窗決定在該 repo 的 `CONTEXT.md` 與 ADR 0017，不在本資料夾。
- 頁面：`src/page.ts`。本機只聽 `127.0.0.1:47821`，見 `src/start.ts`。
- 依賴目前只有 `yaml`。`discord.js` 是這次為了 Gateway 才加的依賴。

## Suggested skills

下一輪先讀並照做：

1. `.agents/skills/tdd/SKILL.md`。先跟使用者確認 seam，再寫會失敗的測試。建議的 seam 是「允許頻道裡的一則訊息，對應到哪一個討論串的 ACP session，以及回覆文字」。不要先測 `discord.js` 的連線細節。
2. `.agents/skills/implement/SKILL.md`。只做上面的範圍。該 skill 寫完成後要 commit。使用者這次只要求留下決定，沒有要求 commit。實作做完時先問要不要 commit。
3. 做完後再讀 `.agents/skills/code-review/SKILL.md`。

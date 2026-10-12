# Web Search 由 Router 提供乾淨端點，客戶端格式翻譯留在 VansPod

**狀態：設計已與使用者逐題確認，尚未實作。** 日期：2026-10-12。

## Context

課堂模式沒有搜尋後端。Codex 的內建搜尋被 VansPod 擋下後，模型改用 shell 逐站抓網頁，一輪 4 分鐘跑了 27 次工具呼叫、約 100 萬 input token。Claude Code 的 WebSearch 在課堂模式同樣不可用（依程式碼推斷，未實測）。

## 決定

- Router（`vans_coding_router`）新增一個自己的搜尋端點，收查詢、回標題／網址／內文片段，不實作任何客戶端專屬格式。
- 客戶端格式的翻譯屬於 VansPod：Codex 的 `/v1/alpha/search` 信封由 VansPod 翻成 Router 端點再包回；Claude Code 的伺服器端搜尋工具由 VansPod 換成一般函式工具，在本機攔截呼叫、向 Router 搜尋、讓模型續講，最後包回 Anthropic 的搜尋結果格式（仿 opencodex）。
- Classroom 模式的搜尋一律經 Router，即使學生電腦有 ChatGPT 登入也不轉給個人帳號。要用自己帳號搜尋的學生切回 Native。
- 老師對每個 Class Session 個別開關，預設關，由 Router 強制執行。未開放時 VansPod 回一個模型讀得懂的「搜尋不可用」結果，不讓請求失敗，也不暗示模型改用其他方式。
- Router 只做搜尋並在結果附內文片段。Codex 的開網頁、頁內找字、股價、天氣等指令回明確的不支援。
- 搜尋後端為純搜尋 API，預設 Tavily，在 Router 內做成可替換；動工時以真實繁體中文查詢對照 Exa 後定案。
- 不做用量統計。只加煞車：每把 Classroom API Key 每分鐘 10 次搜尋請求、每次最多 3 個查詢；Claude Code 單次請求最多 5 次搜尋。
- VansPod 畫面不顯示搜尋是否開放。

## Considered Options

- **Router 直接實作 Codex 的 `/v1/alpha/search`，VansPod 原樣轉送。** 否決：該端點沒有公開規格，Codex 改版就得重新部署 Router；Claude Code 也無法重用。
- **Classroom 模式下有 ChatGPT 登入就轉給 ChatGPT（opencodex 的做法）。** 否決：老師關閉搜尋的課堂裡，剛好有帳號的學生仍能搜尋，開關失效且無人知情。
- **由一個帶搜尋工具的模型代為搜尋並摘要。** 否決：貴一個量級，且等於在 Session Model Allowlist 之外使用另一個模型。
- **Router 也代為開網頁。** 暫不做：Router 會代學生連任意網址；先靠結果附內文，觀察真實使用後再議。

## Consequences

- 這個開關只決定 Router 是否代為搜尋，不是斷網：Claude Code 的 WebFetch 與 agent 的 shell 連網都發生在學生電腦上，不受影響。
- Codex 的請求格式目前只有 opencodex 測試 fixture 這個二手來源；動工第一步是在 VansPod 攔下真實請求確認。
- 分三段交付，各自可獨立上線：Router 端點 → VansPod × Codex → VansPod × Claude Code。
- 取代 ADR-0004 中「由 Router 提供搜尋端點、或轉給學生自己的 ChatGPT，是尚未決定的後續選項」一句。

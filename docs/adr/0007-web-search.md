# Web Search 由 Router 提供乾淨端點，客戶端格式翻譯留在 VansPod

**狀態：設計已與使用者逐題確認；VansPod 端已在整合分支 `issue-21-web-search` 實作，真實客戶端的實機驗證尚待 GitHub #30。** 日期：2026-10-12。

## Context

課堂模式沒有搜尋後端。Codex 的內建搜尋被 VansPod 擋下後，模型改用 shell 逐站抓網頁，一輪 4 分鐘跑了 27 次工具呼叫、約 100 萬 input token。Claude Code 的 WebSearch 在課堂模式同樣不可用（依程式碼推斷，未實測）。

## 決定

- Router（`vans_coding_router`）新增一個自己的搜尋端點，收查詢、回標題／網址／內文片段，不實作任何客戶端專屬格式。
- 客戶端格式的翻譯屬於 VansPod：Codex 的 `/v1/alpha/search` 信封由 VansPod 翻成 Router 端點再包回；Claude Code 的伺服器端搜尋工具由 VansPod 換成一般函式工具，在本機攔截呼叫、向 Router 搜尋、讓模型續講，最後包回 Anthropic 的搜尋結果格式（仿 opencodex）。
- Classroom 模式的搜尋一律經 Router，即使學生電腦有 ChatGPT 登入也不轉給個人帳號。要用自己帳號搜尋的學生切回 Native。
- 老師對每個 Class Session 個別開關，預設關，由 Router 強制執行。未開放時 VansPod 回一個模型讀得懂的「搜尋不可用」結果，不讓請求失敗，也不暗示模型改用其他方式。
- Router 只做搜尋並在結果附內文片段。Codex 的股價、天氣等指令回明確的不支援；開網頁、點連結、頁內找字（`open`、`click`、`find`）不是 Web Search，由 VansPod 告訴模型自行讀取那一頁（2026-10-13 修訂，原本一律回不支援，見實作紀錄）。
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

## 實作紀錄

2026-10-13 VansPod × Codex（GitHub #27）：請求格式以 `src/test/fixtures/codex-search/` 的真實樣本為準。回應格式取自 Codex 原始碼（`openai/codex` tag `rust-v0.162.1`）：`codex-rs/codex-api/src/search.rs` 的 `SearchResponse { encrypted_output, output, results }`，以及 `codex-rs/ext/web-search/src/tool.rs`——模型只讀 `output`，`results` 只供客戶端顯示，非 2xx 回應是 `FunctionCallError::Fatal`。因此未開放、太頻繁、不可用、上游失敗與不支援的指令一律回 200，把說明放在 `output`；這個回應尚未以真實 Codex 端對端驗證。

2026-10-13 VansPod × Claude Code 的上限與錯誤結果（GitHub #29）：錯誤結果的格式與代碼取自 Anthropic 的 web search tool 文件——`web_search_tool_result` 的 `content` 是單一物件 `{ type: "web_search_tool_result_error", error_code }`。Router 的 `web_search_rate_limited` 對應 `too_many_requests`；`web_search_disabled`、`web_search_unavailable` 與上游失敗沒有更貼近的代碼，一律是 `unavailable`，差別只在模型讀到的說明，該說明與 Codex 共用同一組文字。搜尋次數（含失敗的）用完後，下一個模型請求帶 `tool_choice: none`，模型只能作答；仍要求搜尋的呼叫不送 Router，回 `max_uses_exceeded`，再犯一次就結束回覆，並在回覆最後補一段給學生看的文字，說明已達這次回答的搜尋次數上限。超過 1000 字元或沒有查詢文字的呼叫不送 Router，分別回 `query_too_long` 與 `invalid_tool_input`，不像 Codex 那樣截斷。

2026-10-13 VansPod × Claude Code 的搜尋迴圈（GitHub #28、#29）：Router 的 `POST /v1/search` 只收 `queries`，因此 Claude Code 搜尋工具宣告上的 `allowed_domains`、`blocked_domains` 與 `user_location` 沒有地方可放，一律不帶給 Router，搜尋結果不受這些設定限制；`max_uses` 只用來決定上限。三種 Model API Adapter（Responses、Chat、Messages）都跑同一個迴圈：選 Messages 時搜尋工具宣告同樣換成一般函式工具，不會原樣送到上游，否則搜尋就繞過了老師的開關。向 Router 搜尋的呼叫、結果的整理與給模型讀的失敗說明集中在 `src/webSearch.ts`，Codex 與 Claude Code 兩條路共用。被 `max_tokens` 截斷而 JSON 不完整的搜尋呼叫視同沒有查詢文字，回 `invalid_tool_input`；這只會發生在 Messages adapter，Chat 與 Responses adapter 在迴圈之前就會拒絕任何參數不是有效 JSON 的工具呼叫。

2026-10-13 Codex 的讀網頁指令改為放行：原本 `open`、`click`、`find` 與股價、天氣一樣回不支援，並附上「不要用 shell 抓網頁」。但那句話當初要擋的是沒有搜尋時模型逐站亂爬來代替搜尋；搜尋上線後，它連「搜尋完讀其中一頁」和「讀學生貼的網址」也一併擋掉，模型只能靠摘錄作答。讀一個已知網址不是 Web Search（見 `CONTEXT.md`），所以現在這三個指令不經 Router、也不看老師的開關，VansPod 回一段說明請模型自己抓：只抓要求的那一頁、一頁一次、只留可讀文字並截斷、不自行順著連結往下爬；帶網址時把網址寫回，帶編號時請它改用搜尋結果列出的網址（模型只讀得到 `output`，看不到 `results` 裡的 `turn0search0`；VansPod 也不保存任何已開頁面）。共用的那句禁令相應收窄為「不要用 shell 代替搜尋或逐站爬」，凡是引用它的說明都跟著變：四種搜尋失敗說明，以及 Claude Code 的搜尋次數已達上限說明。Codex 的不支援指令說明（股價、天氣等）不跟著收窄，改用自己的一句「不要用 shell 以其他方式取得那項資訊」，因為查一次天氣網站不算搜尋，卻正是要擋的事。這些說明仍不主動提可以讀指定網址，只有模型自己發出這三個指令時才說；同一個請求裡搜尋被拒又帶了這三個指令時，放行的那段排在所有拒絕說明之後，並先聲明它與前面的拒絕無關、要求讀網頁不算重試搜尋。已知代價：Codex 沒有 shell 以外的抓取工具，Windows 上未設定沙箱時每個指令都要學生核准，設定了沙箱則預設禁止連網、失敗後提權重跑才跳核准（依 `rust-v0.162.1` 原始碼，未實機驗證），核准政策為 `never` 時讀不到；抓回的內容也只靠這段文字約束，VansPod 攔不住。改由 VansPod 在學生電腦上代抓並整理成文字可以免去核准並省 token，但要做 HTML 轉文字與已開頁面的狀態，留待觀察真實使用後再議。這段回應同樣尚未以真實 Codex 端對端驗證。

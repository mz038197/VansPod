# Claude Code WebSearch 請求樣本（GitHub #23）

2026-10-13 以 Claude Code `2.1.296`（`claude -p`，`--allowedTools WebSearch`）實際送出的請求。`{ client, method, path, anthropic-beta, anthropic-version, body }` 是擷取時加的外層；`body` 是 Claude Code 送出的正文。

- `web-search-request.json`：主對話的模型呼叫 `WebSearch` 工具後，Claude Code 另外發出的那一個模型請求。它只有一則使用者訊息（`Perform a web search for the query: …`），`tools` 只有 Anthropic 伺服器端搜尋工具 `web_search_20250305`，`max_uses` 為 8。主對話的內容不在這個請求裡。

取樣方式：不是經過 VansPod。為了不改動 `~/.claude/settings.json`，用一個獨立的 Claude Code 行程（環境變數指向本機的記錄用假伺服器、臨時的設定資料夾）取得。因此：

- `model` 是那個行程的預設模型（`claude-opus-5-5`），不是課堂模型。
- 只有請求。Claude Code 期待的搜尋回應（`server_tool_use`、`web_search_tool_result`）沒有真實樣本，假伺服器回的是一段純文字。
- Claude Code 的 WebSearch 目前在 Classroom 模式的實際行為沒有實測。

去識別：`metadata.user_id` 裡的 `device_id` 與 `session_id` 換成固定值。

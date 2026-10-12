# Codex 搜尋請求樣本（GitHub #23）

2026-10-13 以 `codex-cli 0.162.1` 在 Classroom 模式（模型 `VCRouter/vcr-auto`）實際送出、由 VansPod 的暫時性紀錄功能擷取的請求。`{ client, method, path, body }` 是紀錄功能的外層；`body` 是 Codex 送出的正文。

- `search-query.json`：`commands.search_query`
- `open.json`：`commands.open`
- `finance.json`：`commands.finance`

去識別：`body.id`（Codex session id）、`turn_id`、`create_time` 換成固定值。提示文字是取樣時輸入的測試句子，原樣保留。

只有請求。Codex 期待的成功回應格式沒有真實樣本：VansPod 當時回的是 #22 的 400 拒絕。

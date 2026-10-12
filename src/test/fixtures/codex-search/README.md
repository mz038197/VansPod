# Codex 搜尋請求樣本（GitHub #23）

2026-10-13 以 `codex-cli 0.162.1` 在 Classroom 模式（模型 `VCRouter/vcr-auto`）實際送出的請求，由 VansPod 當時一個僅供取樣、現已移除的診斷紀錄擷取。`{ client, method, path, body }` 是擷取時加的外層；`body` 是 Codex 送出的正文。

- `search-query.json`：`commands.search_query`
- `open.json`：`commands.open`
- `finance.json`：`commands.finance`

去識別：`body.id`（Codex session id）、`turn_id`、`create_time` 換成固定值。提示文字是取樣時輸入的測試句子，原樣保留。

只有請求。Codex 期待的成功回應格式沒有真實樣本：VansPod 當時回的是 #22 的 400 拒絕。 回應格式改以 Codex 原始碼為準，見 ADR-0007 的實作紀錄。

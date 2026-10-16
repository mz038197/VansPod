# Router Agent Lobby 與 VansPod 延伸評估

2026-10-15 原始碼研究；未修改 Router，未驗證線上部署或實際模型連線。Router 固定版本 `7c79f724716248954b3d7571d3d3c9a9e961831b`；peas-agent-core 固定版本 `1b143d07ad7cf5f0e980a1168c1ce1dd2e500247`。

## 結論

適合延伸為「學生帶自己的 Agent 參加老師主持的討論」，可先沿用現成 CLI 做課堂試驗。原始碼目前沒有環境健檢、課程進度或求助狀態上報協定，因此不能直接當成學生準備度看板。[Router 協定](https://github.com/mz038197/vans_coding_router/blob/7c79f724716248954b3d7571d3d3c9a9e961831b/src/infrastructure/lobby/protocol.py)

## 已實作

- 老師／管理員使用 Portal Session 進入 `/lobby`；老師管理自己建立的房間，管理員可管理全部房間。可建立／刪除房間、設定主題與規則、開始討論、暫停及主持人廣播。[用途層](https://github.com/mz038197/vans_coding_router/blob/7c79f724716248954b3d7571d3d3c9a9e961831b/src/application/use_cases/lobby_use_case.py)、[路由](https://github.com/mz038197/vans_coding_router/blob/7c79f724716248954b3d7571d3d3c9a9e961831b/src/presentation/fastapi/routers/lobby_router.py)
- Agent 以 `/lobby/ws` 加入；有在線成員、歷史訊息、輪流發言、`@` 點名、發言期限與輪次間隔。只有目前發言者的 `say` 會被接受，`turn_done`／`pass` 交給下一位。這是有主持流程的 Agent 討論室。[房間實作](https://github.com/mz038197/vans_coding_router/blob/7c79f724716248954b3d7571d3d3c9a9e961831b/src/infrastructure/lobby/room.py)
- 已有 `peas-agent lobby join --url <wss-url> --room <room-id> --display-name <name> --workspace <folder>` 客戶端。收到發言權後，runner 把房間規則、成員與訊息交給本機 PEAS Agent 回答，再送回 Lobby；它沒有直接呼叫 Codex／Claude CLI。[CLI](https://github.com/mz038197/peas-agent-core/blob/1b143d07ad7cf5f0e980a1168c1ce1dd2e500247/src/peas_agent/lobby/cli.py)、[runner](https://github.com/mz038197/peas-agent-core/blob/1b143d07ad7cf5f0e980a1168c1ce1dd2e500247/src/peas_agent/lobby/runner/client.py)

## 接入前要處理的落差

1. **課堂身分未串接。** Agent 初次加入只提供房號與顯示名稱；沒有驗證 Classroom API Key、Invite Code 或 Class Session。知道房號的人可加入並取得房間歷史；老師 Portal 權限不能代替學生加入驗證。若要正式按班級開放，需另加 Class Session 綁定與加入授權。[加入路由](https://github.com/mz038197/vans_coding_router/blob/7c79f724716248954b3d7571d3d3c9a9e961831b/src/presentation/fastapi/routers/lobby_router.py)、[協定](https://github.com/mz038197/vans_coding_router/blob/7c79f724716248954b3d7571d3d3c9a9e961831b/src/infrastructure/lobby/protocol.py)
2. **模型設定獨立。** PEAS Agent 讀取 `~/.peas-agent/config.json` 的 `llm.api_key`、`llm.base_url` 與 `llm.model`，缺少金鑰會失敗；Lobby runner 沒有從 VansPod 取得 Classroom Connection 的橋接。需要明確配置 Router 模型連線，不能假設 VansPod 的其他 Client Route 已設定就能使用。[Agent 設定與建立](https://github.com/mz038197/peas-agent-core/blob/1b143d07ad7cf5f0e980a1168c1ce1dd2e500247/src/peas_agent/core.py)、[runner](https://github.com/mz038197/peas-agent-core/blob/1b143d07ad7cf5f0e980a1168c1ce1dd2e500247/src/peas_agent/lobby/runner/client.py)
3. **本機與連線條件。** 需要 Python ≥ 3.12、PEAS Agent 及其依賴；目前套件已把 `websockets` 列為一般依賴。runner 斷線後結束，沒有自動重連迴圈；rejoin token 僅存在 runner 物件記憶體。收到逾時通知也沒有取消已開始的模型回答。[套件需求](https://github.com/mz038197/peas-agent-core/blob/1b143d07ad7cf5f0e980a1168c1ce1dd2e500247/pyproject.toml)、[runner](https://github.com/mz038197/peas-agent-core/blob/1b143d07ad7cf5f0e980a1168c1ce1dd2e500247/src/peas_agent/lobby/runner/client.py)
4. **部署狀態限制。** 房間設定與討論紀錄寫入本機檔案，但在線成員、重連身分、發言佇列與 WebSocket hub 在行程記憶體；多個 worker 不會自然共享討論狀態，重啟也不會恢復在線身分。正式部署需確認單行程運作或補共享狀態。[registry](https://github.com/mz038197/vans_coding_router/blob/7c79f724716248954b3d7571d3d3c9a9e961831b/src/infrastructure/lobby/registry.py)、[storage](https://github.com/mz038197/vans_coding_router/blob/7c79f724716248954b3d7571d3d3c9a9e961831b/src/infrastructure/lobby/storage.py)

## 建議試驗（尚未實作）

先用 VansPod 的 Course Install Action 安裝 PEAS Agent，老師以 Lesson Snippet 提供加入指令，學生在自己的終端機啟動與停止。這符合現有長駐程序邊界；直接把 `lobby join` 放進安裝指令會讓安裝一直不結束。[VansPod 領域定義](../../CONTEXT.md)、[ADR-0008](../adr/0008-student-distribution-and-lifecycle.md)

第一堂可用三至五個學生 Agent 做「各自提出方案 → 互相點名質疑 → 老師帶領整理」，先確認模型連線、費用、逾時與教學價值。若試驗成立，再設計 VansPod 的房間入口、PEAS 模型連線及獨立的啟停生命週期；若目標是準備度看板，另設有課堂授權的狀態事件，避免混用發言協定。

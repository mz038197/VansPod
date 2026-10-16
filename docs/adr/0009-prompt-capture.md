# Prompt Capture 抓 adapter 之後的請求，只存在記憶體

**狀態：已實作（#35，ticket #36–#40）。** 日期：2026-10-16。版面採用原型 A「解剖圖」（原型保存在拋棄式分支 `prototype/prompt-inspector` 的 `scripts/prototype-prompt-inspector.*`）。

## Context

老師想讓學生看到 Coding Agent 送給模型的完整內容，用來學 system prompt、user／assistant 訊息、tool 與 skill 描述。Classroom 模式的每一次模型請求都會經過 VansPod 的 Model API Adapter，所以 VansPod 是唯一看得到全部內容的地方。

## 決定

- **抓取點在 adapter 之後**：記錄 VansPod 實際送往 Router 的請求本文，並附上引發它的客戶端原始請求。結構化畫面只解析前者；後者只以原始 JSON 顯示、不解析。
- **只存在記憶體**：最多 20 筆，超過就丟掉最舊的；關掉 VansPod 或按「清除」就消失。不存任何標頭，Classroom API Key 不會進入紀錄；圖片等 base64 內容只留大小。
- **錄製預設關閉**：每次啟動 VansPod 都是關閉，學生自己開。開啟期間每一次請求都記錄，不論 Prompt 觀察室畫面有沒有開著。
- **只記請求，不記回應**；失敗的請求只多記 HTTP 狀態碼。Web Search 迴圈追加的每一次請求都各記一筆；Codex 的 `/alpha/search` 不是模型請求，不記錄。
- 「本輪新增」的判斷方式：往前找對話剛好是這一筆開頭的那筆紀錄來比較；找不到就標成「新對話」。不判斷哪些是背景請求、也不提供篩選。

## Considered Options

- **抓 adapter 之前的客戶端原始請求來解析。** 否決：一旦有新客戶端帶來新的格式或特殊欄位，顯示層就得跟著改。adapter 本來就要吸收客戶端之間的差異，它的輸出固定是 Messages、Responses、Chat Completions 三種協定之一，所以新增客戶端時顯示層不用改。adapter 改動的只有欄位結構，prompt 文字本身不變，對教學目的沒有影響。
- **寫入磁碟，跨重啟保留。** 否決：紀錄裡有學生的對話和程式碼。只存在記憶體，就不用另外處理加密、保存期限和刪除的問題。
- **永遠記錄，不設開關。** 否決：使用者選擇由學生明確開啟。

## Consequences

- Native 模式的流量不經過 VansPod，所以 Prompt 觀察室看不到，畫面上要直接說明。
- 學生看到的是 VansPod 轉換後的協定，例如選了 Chat adapter 的 Codex 會顯示成 Chat Completions。畫面上標示「客戶端 · 協定」，讓學生知道這一點。
- token 數是用字元數估算的，不呼叫 Router 計算。

# VS Code Chat 以 `chat.defaultModel` 讓新對話使用 VCRouter

**狀態：已實作。** 日期：2026-11-10。

## Context

VansPod 只把 VCRouter provider 寫進 `chatLanguageModels.json`，從不指定 Chat 目前用哪個模型。學生連上 Classroom 後，VS Code 不會自己切到 VCRouter：對話中途才出現的模型不會被選取，重啟後「還原上一個對話」又會換回那個對話的模型。偶爾看起來有切過去，只是 VCRouter 在同一個視窗裡先消失又出現，觸發了 VS Code 自己的還原記憶模型。

## 決定

- VS Code Chat 進入 Classroom 時，把 VS Code 使用者設定 `chat.defaultModel` 設為 Session Model Allowlist 的第一個 VCRouter 模型 id。VS Code 監看這個公開設定，空白對話（含每次開新對話）立刻套用，不必重啟。
- 原值記在既有的 `vscode-route-journal.json`（`defaultModel: { previous, written }`），先寫 journal 再改設定。返回 Native 時只有設定仍等於 `written` 才還原 `previous`（原本沒有就刪除）；學生自己改過就不動。
- 只改 `chat.defaultModel` 那一行，不重新序列化整份 `settings.json`，保留學生的註解與排版。用能辨識字串、註解與巢狀層級的 scanner 找頂層的 key（與 VS Code 一樣以最後一個重複 key 為準），語言區塊（如 `"[python]"`）裡的同名 key 不動；寫入用暫存檔再 rename。
- 同一個模型已寫過時（例如 VansPod 重新啟動），不再寫入，避免蓋掉學生之後自己改的值。
- 寫入 `chat.defaultModel` 不算進 VS Code 需要重啟的變更；讀寫失敗也不擋 Classroom／Native 切換。
- 與 classroom-one-click-install 擴充同一套規則（擴充 ADR 0018），兩邊不各用一種切換方式。

## Considered Options

- **改 `state.vscdb` 的 `chat.currentLanguageModel.panel`**：否決。要重啟才生效、重啟後仍被還原對話蓋掉，且是未公開格式。
- **透過擴充的 `vscode://` URI 代為呼叫 `workbench.action.chat.open`**：否決。學生不一定裝擴充，且會變成兩種機制。

## Consequences

- 已有內容的舊對話不會被強切，學生開新對話就會用 VCRouter。
- 殘留的 `chat.defaultModel` 在 VCRouter 消失後由 VS Code 退回自己的預設，不會讓 Chat 壞掉。

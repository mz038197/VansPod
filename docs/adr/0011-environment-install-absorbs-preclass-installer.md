# Environment Install 取代獨立的課前安裝助手

**狀態：已決定，尚未實作。** 日期：2026-10-20。

## Context

學生的開發工具原本有兩套安裝程式：VansPod 的 Environment Install（uv、Git、Node.js、PowerShell 7），以及獨立的「凡思課前安裝助手」（`mz038197/vans-classroom-installer`，PowerShell 5.1 + WPF）。課前安裝助手多了 VS Code、嚴格的就緒驗證與官方安裝檔的簽章檢查，但兩套各自維護，對「已安裝」的判定也不一致。VansPod exe 內含 Node runtime，裸機即可執行（ADR-0008），所以課前安裝助手沒有非存在不可的理由。

## 決定

- **Environment Install 是學生準備開發工具的唯一入口。** 把課前安裝助手的能力移植進 VansPod（TypeScript）：VS Code、Environment Tool Readiness（含「需要修復」）、一個工具失敗不影響其他工具、安裝後以驗證判定成功、安裝紀錄。移植完成後封存 `vans-classroom-installer`，不再發佈學生 zip。
- **winget 優先，沒有 winget 才從官方網站直接下載。** Git、Node.js、PowerShell 7 平時用 winget；偵測不到 winget 時改下載官方安裝檔。VS Code 一律用官方 User 安裝檔，uv 一律用官方 install script，兩者都不需要 winget。
- **直接下載的安裝檔一律驗證簽章後才執行。** Authenticode 必須有效，且簽署者是該工具預期的發行者；不符就不執行。下載有進度、最多重試三次；安裝檔留在下載快取，工具驗證通過才刪除，中止時立即刪除。

## Considered Options

- **兩套並存，課前用 bat、上課用 VansPod。** 否決：同一個概念維護兩份實作，判定標準會繼續分歧。
- **VansPod 呼叫課前安裝助手的 PowerShell 腳本。** 否決：WPF 與瀏覽器頁面兩套介面，進度與 Abort Install 要跨語言溝通，一個產品維護兩種語言。
- **全部改成直接下載，不用 winget。** 否決：Git 與 PowerShell 的最新版本要查 GitHub API，未驗證的請求每個 IP 每小時 60 次；教室學生共用對外 IP，全班同時安裝會一起失敗。winget 沒有這個限制。

## Consequences

- Abort Install 沿用 ADR-0008，不採用課前安裝助手「不終止官方安裝程式」的做法；差別只在直接下載階段可以乾淨取消（見 ADR-0008 的補充）。
- 沒有 winget 的電腦仍可能在下載備援時碰到 GitHub 次數上限，畫面須如實顯示為失敗並可重試。

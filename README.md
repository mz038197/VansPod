# VansPod

套件名稱為 `vanspod`。Windows 執行 `npm run dist` 後會產出 `dist/VansPod.exe`。

本機課堂 app。規格是 [classroom-one-click-install#8](https://github.com/mz038197/classroom-one-click-install/issues/8)。

不放進凡思課堂安裝擴充，也不從 opencodex fork。領域詞以該 repo 的 CONTEXT.md 為準。視窗決定見該 repo 的 ADR 0017。

```
npm test
npm start
```

`npm start` 在 Windows 開本機網頁、用系統瀏覽器打開，並在工作列放一顆圖示。再點圖示會打開同一個網址。關掉分頁不會結束這個行程。在啟動它的終端機按 Ctrl+C 才會結束。

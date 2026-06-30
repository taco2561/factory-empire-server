# Factory Empire v3 — Server (Phase 1)

## 這是什麼

第一階段多人化改造的成果：把六個核心遊戲邏輯模組（economy / npc-ai /
government-system / stock-system / bank-system / game-loop）搬到 Node.js
伺服器執行，讓伺服器自己跑一份完整的遊戲世界（1 玩家 + 80 家 AI 公司）。

**本階段不含任何網路功能**：沒有 WebSocket、沒有 API、沒有多人同步、
沒有資料庫。伺服器啟動後就是自顧自跑 tick，純粹用來驗證「遊戲邏輯搬到
伺服器執行」這件事是否可行。前端（`game.html`）完全沒有被改動，仍然是
目前的單機版運作方式。

## 目錄結構

```
server-phase1/
├── package.json
└── src/
    ├── server.js          ← 伺服器進入點，啟動 tick 迴圈
    └── modules/           ← 從 outputs/ 複製過來的遊戲邏輯模組
        ├── utils.js
        ├── constants.js
        ├── data.js
        ├── economy.js          ← 核心模組
        ├── state.js            ← 核心模組依賴（含 world 初始化）
        ├── bank-system.js      ← 核心模組
        ├── reception.js        ← 核心模組依賴
        ├── game-loop.js        ← 核心模組（tick 主迴圈）
        ├── npc-ai.js           ← 核心模組
        ├── income-analysis.js
        ├── monitor.js          ← 核心模組依賴
        ├── stock-system.js     ← 核心模組
        ├── government-system.js ← 核心模組
        └── news.js             ← 核心模組依賴
```

## 如何啟動

```bash
cd server-phase1
node src/server.js
```

不需要 `npm install`，目前沒有任何外部套件依賴（只用 Node.js 內建模組
`fs`/`path`/`vm`）。

啟動後會在終端機看到：

```
[Phase1 Server] 載入遊戲邏輯模組中…
[Phase1 Server] 模組載入完成，world 已初始化。
[Phase1 Server] 初始狀態 → day: 1  tick: 0  公司數: 81
[Phase1 Server] 啟動 Server Tick，間隔 3000ms（與前端 1x 速度相同）…
```

之後每跨過一個遊戲天（20 個 tick，約 60 秒），會印一行狀態摘要：

```
[Phase1 Server] Day 2 | Tick 20 | 玩家現金 $10000 | 存活NPC 80 | 破產NPC 0 | 景氣 🟡 平穩（EI 45）
```

按 `Ctrl+C` 停止伺服器。

## 注意事項

- 伺服器世界狀態只存在記憶體中，**重啟伺服器即重置**（這是刻意的，
  本階段規格明確要求不碰資料庫、不碰 localStorage 邏輯本身）。
- 伺服器與瀏覽器前端是兩個完全獨立的世界，互不影響，這是本階段
  「先驗證搬遷可行性」的過渡狀態，尚未真正多人化。

---

# Phase 2：部署到 Railway

## 這支服務的部署型態

這是一個**純背景程序（background worker）**，不開任何 HTTP port、
不提供任何 API。Railway 完全支援這種部署方式，會用 process 是否存活
（而不是 ping 某個網址）來判斷服務是否健康，並依照 `railway.toml` 裡
設定的重啟策略，在程式異常結束時自動重啟。

## 部署前準備：把專案放上 GitHub

Railway 最常見的部署方式是連接 GitHub repo，自動偵測更新並重新部署。

1. 到 [github.com](https://github.com) 建立一個新的 repository（public 或
   private 皆可），例如取名 `factory-empire-server`。
2. 把 `server-phase1` 整個資料夾的內容推上去這個 repo（可以用 GitHub
   Desktop 這種圖形化工具，不一定要打指令）。
3. 確認推上去的內容裡有：`package.json`、`railway.toml`、`src/server.js`、
   `src/modules/`（14 個檔案）、`.gitignore`。

## 部署步驟

1. 到 [railway.com](https://railway.com) 註冊/登入帳號。
2. 點 **New Project**。
3. 選擇 **Deploy from GitHub repo**，授權 Railway 存取你的 GitHub 帳號
   （第一次會跳出 GitHub 授權畫面）。
4. 選擇你剛剛建立的 `factory-empire-server` repo。
5. Railway 會自動偵測到這是 Node.js 專案（透過 `package.json`），開始
   建置與部署，不需要手動填任何指令（`railway.toml` 已經寫好
   `startCommand`）。
6. 等待畫面上的部署狀態變成 **Active** / 綠色勾勾，代表部署成功。

## 如何驗證雲端 Server 正常運作

部署完成後，在 Railway 專案頁面點進這個服務，切到 **Deployments** 分頁，
點最新的那次部署，可以看到即時 log。你應該會看到跟本機測試時一樣的輸出：

```
[Phase1 Server] 載入遊戲邏輯模組中…
[Phase1 Server] 模組載入完成，world 已初始化。
[Phase1 Server] 初始狀態 → day: 1  tick: 0  公司數: 81
[Phase1 Server] 啟動 Server Tick，間隔 3000ms（與前端 1x 速度相同）…
```

等待約 60 秒後，應該會看到第一行 `Day 2 | Tick 20 | ...` 的狀態摘要，
代表伺服器在雲端持續、正確地推進遊戲世界，且**就算你關掉電腦、關掉
瀏覽器，這個服務依然會在 Railway 上 24 小時繼續運行**（這是跟本機
執行最大的差別）。

## 如何查看 Server Log

在 Railway 專案頁面：服務 → **Deployments** 分頁 → 點選任一次部署 →
即可看到該次部署從啟動至今的完整 log（會持續即時更新）。也可以用
**Observability** / **Logs** 分頁看跨部署的歷史記錄。

## 如何重新部署新版程式

只要把修改後的程式碼推上同一個 GitHub repo 的對應分支（通常是 `main`），
Railway 預設會自動偵測到新的 commit 並重新建置部署，不需要任何手動
操作。如果想手動觸發重新部署，可以在 Railway 服務頁面右上角點
**Deploy** 按鈕。

## 費用提醒

Railway 採用用量計費，新帳號通常有免費額度。這個背景服務會 24 小時
持續執行運算（80 家 AI 公司決策、市場撮合等），建議部署後留意 Railway
後台的用量/帳單頁面，確認費用在預期範圍內。


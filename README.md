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

---

# Phase 3：World 狀態存進 Supabase（PostgreSQL）

## 這個階段做了什麼

在 Phase 1/2，伺服器的世界狀態只存在記憶體裡，**重啟伺服器（或
Railway 重新部署）就會整個重置**。Phase 3 把世界狀態改成存進
Supabase 的 PostgreSQL 資料庫，伺服器重啟後能恢復上一次跑到的進度。

## 設計決策：為什麼用單一 JSONB 欄位整包存，而不是拆成多張表

`world` 物件裡 `companies`（80家AI公司+1個玩家）佔了整包資料 90% 以上
的大小，且被 9 個遊戲邏輯模組、超過 60 處程式碼直接用
`.find()`/`.forEach()`/`.filter()` 操作整個陣列。如果改成「一家公司
一列」的關聯式資料表，這 60 處呼叫全部都要重寫成 SQL 查詢，等同重寫
遊戲核心邏輯——這違反 Phase 3「不修改遊戲規則」的規格要求。

因此採用「整包 JSONB 儲存」：跟原本 `localStorage.setItem(key,
JSON.stringify(world))` 的精神完全一致，只是儲存位置從瀏覽器換成
資料庫，**六個核心遊戲邏輯模組沒有被修改任何一行**。

## 新增的資料表

### `game_world`（主要資料表）

| 欄位 | 型別 | 說明 |
|---|---|---|
| `id` | INTEGER (固定為1) | 單人模式只有一份世界狀態 |
| `world_data` | JSONB | 完整的 world 物件（公司、市場、政府、股票…全部） |
| `updated_at` | TIMESTAMPTZ | 最後一次寫入時間 |
| `created_at` | TIMESTAMPTZ | 第一次建立時間 |

### `game_world_log`（除錯用，非必要）

| 欄位 | 型別 | 說明 |
|---|---|---|
| `id` | BIGSERIAL | 流水號 |
| `event_type` | TEXT | `load` / `save` / `init` |
| `detail` | TEXT | 簡短說明，例如 `day:5 tick:100` |
| `created_at` | TIMESTAMPTZ | 事件發生時間 |

完整建表語法見 `sql/001_create_game_world.sql`（伺服器啟動時也會
自動檢查並建立這兩張表，所以就算你忘記手動跑這段 SQL 也沒關係）。

## 如何建立 Supabase 專案

1. 到 [supabase.com](https://supabase.com) 註冊/登入帳號。
2. 點 **New Project**。
3. 填寫專案名稱（例如 `factory-empire-db`）、設定一組資料庫密碼
   （**請妥善保存，等一下會用到**）、選擇地區（建議選離 Railway
   伺服器近的區域，例如同樣是美西）。
4. 等待專案建立完成（約 1～2 分鐘）。

## 如何取得連線字串（DATABASE_URL）

1. 進入專案後，左側選單點 **Connect**（或 Project Settings → Database）。
2. 找到 **Connection string** 區塊，選擇 **Session pooler**（這是
   給「長連線、持續運行的伺服器」用的模式，跟 Serverless 用的
   Transaction pooler 不同）。
3. 複製那串網址，格式類似：
   ```
   postgresql://postgres.xxxxxxxxxxxx:[YOUR-PASSWORD]@xxxxx.supabase.com:5432/postgres
   ```
4. 把 `[YOUR-PASSWORD]` 換成你剛剛設定的資料庫密碼。

## 如何在 Railway 設定環境變數

1. 進入 Railway 的 `factory-empire-server` 服務頁面。
2. 點上方的 **Variables** 分頁。
3. 點 **New Variable**，新增：
   - **Key**：`DATABASE_URL`
   - **Value**：貼上剛剛從 Supabase 複製、已經替換密碼的完整連線字串
4. 儲存後，Railway 會自動重新部署服務套用新的環境變數。

## 如何測試資料庫是否正常運作

部署完成後，到 Railway 的 Deploy Logs 應該會看到：

```
[Phase3 Server] 連接資料庫中…
[Phase3 Server] 資料庫目前沒有存檔，將建立全新世界。
[Server] 模組載入完成，world 已初始化。
[Phase3 Server] 資料庫背景同步已啟用，每次 saveWorld() 都會非阻塞地寫回 Supabase。
```

接著到 Supabase 後台 → **Table Editor** → 選 `game_world` 表，應該會
看到一筆 `id=1` 的資料，`world_data` 欄位裡有完整的遊戲世界 JSON。

**驗證「重啟後能恢復進度」**：到 Railway 服務頁面，點右上角選單選
**Restart**，等服務重新啟動後再看一次 Deploy Logs，這次應該會看到：

```
[Phase3 Server] 已從資料庫讀到既有存檔（day:X tick:Y）。
[Server] 初始狀態 → day: X  tick: Y  公司數: 81
```

這裡的 `day`/`tick` 應該要跟重啟前最後看到的數字相符（或非常接近），
代表進度真的有被保留下來，不是從頭開始。

## 如果資料庫連線失敗會怎樣

伺服器設計成「優雅降級」：如果 `DATABASE_URL` 沒設定或連線失敗，
不會讓整個伺服器崩潰，而是會在 log 印出原因，並自動退回純記憶體
模式繼續運行（行為等同 Phase 1/2，但這次重啟就會遺失進度）。



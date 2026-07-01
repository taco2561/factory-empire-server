-- ══════════════════════════════════════════════════════════════
-- Factory Empire v3 — Phase 3：World 狀態資料表
--
-- 設計決策說明：
--   原本 world 物件用 localStorage.setItem(key, JSON.stringify(world))
--   整包存成一個 JSON 字串。Phase 3 的目標是「把儲存位置從瀏覽器換成
--   資料庫」，而不是「重新設計遊戲的資料模型」。
--
--   經分析，world.companies（80+1家公司）佔了整包資料 90% 以上的大小，
--   且被 9 個核心模組、超過 60 處程式碼用 .find()/.forEach()/.filter()
--   直接操作整個陣列。若改成關聯式資料表（每家公司一列），這 60 處
--   呼叫全部都要改寫成 SQL 查詢，等同重寫遊戲核心邏輯，這違反 Phase 3
--   規格「不修改遊戲規則」「優先重用現有程式碼」的要求。
--
--   因此採用「JSONB 整包儲存」策略：用 PostgreSQL 的 JSONB 型別存放
--   完整的 world 物件，這跟原本 localStorage 的精神一致（整包讀、整包
--   寫），但換成資料庫儲存後可以：
--     - 24 小時運行的 Server 重啟後能恢復進度（這是 Phase 3 的核心目標）
--     - 之後若要做拆表/索引優化，可以在後續階段再評估，不影響本階段
--
--   本階段只有「一份」世界狀態（單人模式），所以資料表設計成單列
--   （id 固定為 1），保留 created_at/updated_at 方便除錯與未來擴充。
-- ══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS game_world (
  id          INTEGER PRIMARY KEY DEFAULT 1,
  world_data  JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- 本階段固定只有一筆資料（單人模式、單一世界）
  CONSTRAINT game_world_single_row CHECK (id = 1)
);

-- updated_at 索引：方便之後查詢「最近一次更新時間」、排查存檔頻率
CREATE INDEX IF NOT EXISTS idx_game_world_updated_at ON game_world (updated_at);

-- ── 簡單的審計記錄表（選用，非必要，但方便除錯）──────────────
-- 記錄每次伺服器啟動/載入/存檔事件，不影響遊戲邏輯，純粹是維運用的
-- log，资料量小，方便你之後在 Supabase 後台查「伺服器是否真的有定期
-- 存檔」「重啟後是否成功讀到舊資料」。
CREATE TABLE IF NOT EXISTS game_world_log (
  id          BIGSERIAL PRIMARY KEY,
  event_type  TEXT NOT NULL,         -- 'load' | 'save' | 'init'
  detail      TEXT,                  -- 簡短說明，例如 "day:5 tick:100"
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_game_world_log_created_at ON game_world_log (created_at);

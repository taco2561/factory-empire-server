-- ══════════════════════════════════════════════════════════════
-- Factory Empire v3 — Phase 7A：多 World 架構（Main World + Tournament
-- World）資料庫模型
--
-- 設計決策：
--   1. room_id → world_id 更名：Phase 6B 當時預留的是通用「房間」概念，
--      後來確認實際需求是「一個 Main World + 官方建立的 Tournament
--      World」，不是玩家自建房間，world_id 語意才正確。用條件式
--      DO 區塊做更名（見 db.js/auth.js），對已經部署過 Phase 6B 的
--      環境（room_id 已存在）安全更名一次；全新環境則從 Phase 6B
--      的 ALTER ADD COLUMN 開始就已經是完整流程。
--
--   2. worlds 表：每個 World（不管 Main 還是 Tournament）的中繼資料
--      ——類型、狀態、起訖時間、賽制參數（settings JSONB：起始資金、
--      NPC 數量……等）。跟 game_world.world_id 是 1:1，worlds 存
--      「這個 world 是什麼」，game_world 存「目前狀態的完整 JSONB」。
--
--   3. player_world_memberships 表：取代 players.company_id 原本
--      「一個玩家只能對應一家公司」的限制。多 World 架構下，玩家在
--      Main World 有一家公司，報名 Tournament World 時會在那個
--      world 另外開一家新公司，兩者資產完全獨立，用這張表分別記錄
--      「這個玩家在這個 world 底下，對應的是哪家公司」。
--      （Phase 7A 先建表 + 回填既有資料，實際登入/報名流程改成寫入
--      這張表是 Phase 7B/7C 的工作，目前 handleRegister/handleLogin
--      仍先寫 players.company_id，啟動時的回填 INSERT 保持兩邊同步）
--
--   4. tournament_results 表：Tournament World 結束後的結算榮譽榜，
--      獨立於 game_world 的 JSONB 存在，就算之後把已結束比賽的
--      world JSONB 卸載/清掉（省資源），排名結果仍然查得到。
--      排名依據（已跟你確認）：現金＋建築估值＋股票市值－負債。
--
--   5. players 新增兩個欄位：
--      - is_admin：只有你自己會被設成 true，部署後手動跑一次 SQL：
--          UPDATE players SET is_admin = true WHERE username = '你的帳號';
--      - monthly_pass_expires_at：Tournament World 報名門檻（需要有效
--        月卡）。這裡先準備好欄位跟檢查邏輯，實際收款串接（Stripe /
--        綠界等）是之後的工作，串好後只要能寫入這個欄位就能接上。
--
-- 這份 .sql 檔案是文件記錄，跟 001/002/003 一樣，程式不會讀取這個
-- 檔案——實際的遷移邏輯寫在 db.js 的 ensureSchema() 和 auth.js 的
-- ensureAuthSchema()，Server 每次啟動都會自動、安全地重跑一次（都是
-- IF NOT EXISTS / 條件式判斷，不會重複套用或破壞既有資料）。
-- ══════════════════════════════════════════════════════════════

-- ── room_id → world_id 更名 ─────────────────────────────────
-- （條件式：只有「room_id 還在、world_id 還沒出現」時才更名）
ALTER TABLE game_world     RENAME COLUMN room_id TO world_id;
ALTER TABLE players        RENAME COLUMN room_id TO world_id;
ALTER TABLE game_world_log RENAME COLUMN room_id TO world_id;

-- ── worlds：World 中繼資料 ───────────────────────────────────
CREATE TABLE IF NOT EXISTS worlds (
  id          SERIAL PRIMARY KEY,
  type        TEXT NOT NULL CHECK (type IN ('main','tournament')),
  name        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'scheduled'
              CHECK (status IN ('scheduled','active','ended','archived')),
  starts_at   TIMESTAMPTZ,
  ends_at     TIMESTAMPTZ,
  settings    JSONB NOT NULL DEFAULT '{}',
  created_by  BIGINT,          -- 對應 players.id（建立這個 world 的管理員），不設 FK 避免建表順序耦合
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_worlds_status ON worlds (status);

INSERT INTO worlds (id, type, name, status) VALUES (1, 'main', '主世界', 'active')
ON CONFLICT (id) DO NOTHING;

-- ── player_world_memberships：玩家 ↔ World ↔ 公司 ──────────
CREATE TABLE IF NOT EXISTS player_world_memberships (
  id          BIGSERIAL PRIMARY KEY,
  player_id   BIGINT NOT NULL REFERENCES players(id),
  world_id    INTEGER NOT NULL REFERENCES worlds(id),
  company_id  TEXT NOT NULL,
  joined_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (player_id, world_id)
);
CREATE INDEX IF NOT EXISTS idx_pwm_player ON player_world_memberships (player_id);
CREATE INDEX IF NOT EXISTS idx_pwm_world  ON player_world_memberships (world_id);

-- ── tournament_results：比賽結算榮譽榜 ──────────────────────
CREATE TABLE IF NOT EXISTS tournament_results (
  id               BIGSERIAL PRIMARY KEY,
  world_id         INTEGER NOT NULL REFERENCES worlds(id),
  player_id        BIGINT NOT NULL,
  company_name     TEXT NOT NULL,
  cash             NUMERIC NOT NULL,
  buildings_value  NUMERIC NOT NULL,
  stock_value      NUMERIC NOT NULL,
  total_debt       NUMERIC NOT NULL,
  net_worth        NUMERIC NOT NULL,   -- 排名依據：cash + buildings_value + stock_value - total_debt
  rank             INTEGER,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tournament_results_world ON tournament_results (world_id);

-- ── players：管理員權限 + 月卡到期時間 ──────────────────────
ALTER TABLE players ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE players ADD COLUMN IF NOT EXISTS monthly_pass_expires_at TIMESTAMPTZ;

-- ── 資料回填：既有 players.company_id → world_id=1 的 membership ──
INSERT INTO player_world_memberships (player_id, world_id, company_id)
SELECT id, 1, company_id FROM players WHERE company_id IS NOT NULL
ON CONFLICT (player_id, world_id) DO NOTHING;

-- ══════════════════════════════════════════════════════════════
-- Factory Empire v3 — Phase 6A：玩家身份系統資料表
--
-- 設計決策：
--   1. 帳號系統自己實作（不用 Supabase Auth），只用 PostgreSQL 存資料
--      原因：Supabase Auth 需要前端引入 SDK，增加複雜度；
--            自己實作只需要在 Server 端處理，前端只傳帳密即可。
--   2. 密碼用 bcrypt hash 儲存（不存明文）
--   3. 登入後發 JWT token，前端持有，之後所有 API/WS 帶上這個 token
--   4. JWT 不需要資料庫查詢驗證（Server 重啟後仍有效）
--   5. 玩家公司以 company_id 對應到 world.companies 陣列裡的某個公司
--      company_id 是 world.companies[i].id（一個 uid 字串）
-- ══════════════════════════════════════════════════════════════

-- ── 玩家帳號表 ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS players (
  id            BIGSERIAL PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,           -- 玩家名稱（登入用，也是遊戲內顯示名稱）
  password_hash TEXT NOT NULL,                  -- bcrypt hash，不存明文
  company_id    TEXT,                           -- 對應到 world.companies[i].id
  company_name  TEXT,                           -- 公司名稱（冗餘存一份，方便查詢）
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ,

  CONSTRAINT username_length CHECK (char_length(username) >= 2 AND char_length(username) <= 20)
);

CREATE INDEX IF NOT EXISTS idx_players_username ON players (username);
CREATE INDEX IF NOT EXISTS idx_players_company_id ON players (company_id);

-- ── 登入記錄表（選用，方便除錯）────────────────────────────
CREATE TABLE IF NOT EXISTS player_login_log (
  id          BIGSERIAL PRIMARY KEY,
  player_id   BIGINT REFERENCES players(id),
  event_type  TEXT NOT NULL,   -- 'register' | 'login' | 'logout'
  ip          TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

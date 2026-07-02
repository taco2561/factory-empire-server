-- ══════════════════════════════════════════════════════════════
-- Factory Empire v3 — Phase 6B：玩家資料關聯 + 房間系統預留欄位
--
-- 設計決策：
--   1. 這個階段「不」實作房間系統（依規格），但為了避免 Phase 7
--      加入房間系統時要大幅修改資料表結構，這裡先幫兩張既有的表
--      加上 room_id 欄位，預設值固定為 1（代表目前唯一的「大廳」）。
--      Phase 7 若要支援多房間，只需要：
--        - game_world：對每個 room_id 各存一列 world_data
--        - players：把玩家的 room_id 改成他實際所在的房間
--      不需要更動任何欄位型別或既有資料。
--
--   2. world.companies（JSONB 內）新增 playerId 欄位（對應
--      players.id），讓「玩家資料」在 world 內部也能直接反查回
--      資料庫的玩家帳號，不必只靠 players.company_id 單向對應。
--      這個欄位是由 Server 端程式碼（auth.js）在建立玩家公司時
--      寫入 JSONB，不需要資料庫 migration（JSONB 無固定 schema）。
--
--   3. Company 內部已包含 buildings（工廠）、warehouse（資源庫存）等
--      欄位，這些資料本來就整包存在 company 物件裡（Phase 3 的
--      JSONB 整包儲存設計），所以只要 company 本身跟 playerId 建立
--      關聯，底下的工廠/資源資料就自動跟著關聯，不需要另外處理。
-- ══════════════════════════════════════════════════════════════

-- ── game_world：加入 room_id，預設 1（目前唯一的世界／大廳）──
ALTER TABLE game_world ADD COLUMN IF NOT EXISTS room_id INTEGER NOT NULL DEFAULT 1;

-- 移除原本「只能有一列、id 必須是 1」的限制，
-- 改成「每個 room_id 只能有一列」，讓 Phase 7 可以直接新增列即可支援多房間。
ALTER TABLE game_world DROP CONSTRAINT IF EXISTS game_world_single_row;
CREATE UNIQUE INDEX IF NOT EXISTS idx_game_world_room_id ON game_world (room_id);

-- ── players：加入 room_id，預設 1（目前所有玩家都在同一個世界）──
ALTER TABLE players ADD COLUMN IF NOT EXISTS room_id INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_players_room_id ON players (room_id);

-- ── game_world_log：順便記錄是哪個房間的事件（預留，目前都是 1）──
ALTER TABLE game_world_log ADD COLUMN IF NOT EXISTS room_id INTEGER NOT NULL DEFAULT 1;

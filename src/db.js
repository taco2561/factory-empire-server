// ══════════════════════════════════════════════════════════════
// Factory Empire v3 — Phase 3 資料庫連線模組
//
// 這支檔案獨立於六個核心遊戲邏輯模組之外，不屬於「遊戲規則」的
// 一部分，純粹負責跟 Supabase（PostgreSQL）對話：
//   - loadWorldFromDb(worldId)：啟動時讀取指定 world 的存檔 JSON
//   - saveWorldToDb(worldId, worldObject)：把指定 world 的狀態寫回資料庫
//
// 連線資訊一律從環境變數讀取（DATABASE_URL），不把任何帳密寫死
// 在程式碼裡。
// ══════════════════════════════════════════════════════════════

const postgres = require("postgres");

const DATABASE_URL = process.env.DATABASE_URL;

let sql = null;

function getClient(){
  if(!DATABASE_URL){
    throw new Error(
      "[Phase3 Server] 找不到環境變數 DATABASE_URL。\n" +
      "請在 Railway 的 Variables 分頁設定 DATABASE_URL（Supabase 連線字串）。"
    );
  }
  if(!sql){
    sql = postgres(DATABASE_URL, {
      ssl: "require",   // Supabase 一律要求 SSL 連線
      max: 5,            // 這是純背景服務、單一連線即可，保守設定連線池上限
      idle_timeout: 20,
      connect_timeout: 10,
    });
  }
  return sql;
}

// ── 啟動時：確保資料表存在（若不存在則自動建立，避免你忘記先跑 SQL）──
async function ensureSchema(){
  const client = getClient();
  await client`
    CREATE TABLE IF NOT EXISTS game_world (
      id          INTEGER PRIMARY KEY DEFAULT 1,
      world_data  JSONB NOT NULL,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT game_world_single_row CHECK (id = 1)
    )
  `;
  await client`
    CREATE TABLE IF NOT EXISTS game_world_log (
      id          BIGSERIAL PRIMARY KEY,
      event_type  TEXT NOT NULL,
      detail      TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  // ── [Phase 6B] 為未來房間系統預留欄位（本階段不啟用房間邏輯，
  //    只是先把欄位加上，避免 Phase 7 要大改資料表）──
  //    room_id 預設 1，代表目前唯一的世界／大廳，行為完全不變。
  await client`ALTER TABLE game_world ADD COLUMN IF NOT EXISTS room_id INTEGER NOT NULL DEFAULT 1`;
  await client`ALTER TABLE game_world DROP CONSTRAINT IF EXISTS game_world_single_row`;
  await client`CREATE UNIQUE INDEX IF NOT EXISTS idx_game_world_room_id ON game_world (room_id)`;
  await client`ALTER TABLE game_world_log ADD COLUMN IF NOT EXISTS room_id INTEGER NOT NULL DEFAULT 1`;

  // ── [Phase 7A] 確定了不是通用房間系統，而是「Main World + Tournament
  //    World」，room_id 這個命名語意不對，更名成 world_id。
  //    用 DO 區塊做條件判斷：只有「room_id 還在、world_id 還沒出現」時
  //    才更名，確保每次啟動重跑這段都是安全的（已經改過名就不會再跑）。
  await client`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='game_world' AND column_name='room_id')
         AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='game_world' AND column_name='world_id') THEN
        ALTER TABLE game_world RENAME COLUMN room_id TO world_id;
        ALTER INDEX idx_game_world_room_id RENAME TO idx_game_world_world_id;
      END IF;
    END $$;
  `;
  await client`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='game_world_log' AND column_name='room_id')
         AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='game_world_log' AND column_name='world_id') THEN
        ALTER TABLE game_world_log RENAME COLUMN room_id TO world_id;
      END IF;
    END $$;
  `;

  // ── [Phase 7A] worlds：每個 World（Main 或 Tournament）的中繼資料。
  //    game_world.world_id 對應到這裡的 id，兩者是 1:1
  //    （worlds 存「這個 world 是什麼」，game_world 存「目前狀態 JSONB」）。
  await client`
    CREATE TABLE IF NOT EXISTS worlds (
      id          SERIAL PRIMARY KEY,
      type        TEXT NOT NULL CHECK (type IN ('main','tournament')),
      name        TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'scheduled'
                  CHECK (status IN ('scheduled','active','ended','archived')),
      starts_at   TIMESTAMPTZ,
      ends_at     TIMESTAMPTZ,
      settings    JSONB NOT NULL DEFAULT '{}',
      created_by  BIGINT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await client`CREATE INDEX IF NOT EXISTS idx_worlds_status ON worlds (status)`;

  // Main World 種子資料：固定 id=1，只有第一次啟動時會真的插入
  await client`
    INSERT INTO worlds (id, type, name, status)
    VALUES (1, 'main', '主世界', 'active')
    ON CONFLICT (id) DO NOTHING
  `;
  // 手動指定過 id=1，要把 SERIAL 序列往後推，避免下次自動產生 id 時撞號
  await client`SELECT setval('worlds_id_seq', GREATEST((SELECT MAX(id) FROM worlds), 1))`;

  // ── [Phase 7A] tournament_results：比賽結算榮譽榜（Tournament World
  //    結束後寫入，就算之後把該 world 的 JSONB 卸載/清掉，排名結果仍保留）
  await client`
    CREATE TABLE IF NOT EXISTS tournament_results (
      id               BIGSERIAL PRIMARY KEY,
      world_id         INTEGER NOT NULL REFERENCES worlds(id),
      player_id        BIGINT NOT NULL,
      company_name     TEXT NOT NULL,
      cash             NUMERIC NOT NULL,
      buildings_value  NUMERIC NOT NULL,
      stock_value      NUMERIC NOT NULL,
      total_debt       NUMERIC NOT NULL,
      net_worth        NUMERIC NOT NULL,
      rank             INTEGER,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await client`CREATE INDEX IF NOT EXISTS idx_tournament_results_world ON tournament_results (world_id)`;

  // ── [Phase 7B] game_world.id 原本 DEFAULT 是常數 1（單人模式時代
  //    的殘留設計：反正永遠只有一列，id 寫死 1 就好）。多 World 情境
  //    下每個 world 各自一列，繼續用常數 1 當預設值，第二個 world
  //    存檔時就會撞 PRIMARY KEY。改成用序列自動遞增，且業務邏輯上
  //    的識別／upsert 一律改用 world_id（已經有 UNIQUE INDEX），
  //    不再依賴 id 本身的值，所以這個修正對現有資料完全無感。
  await client`CREATE SEQUENCE IF NOT EXISTS game_world_id_seq`;
  await client`SELECT setval('game_world_id_seq', GREATEST((SELECT MAX(id) FROM game_world), 1))`;
  await client`ALTER TABLE game_world ALTER COLUMN id SET DEFAULT nextval('game_world_id_seq')`;
}

// ── 讀取指定 world 目前存檔（若資料庫裡還沒有任何資料，回傳 null）──
// [Phase 7B] 加入 worldId 參數：每個 World（Main 或 Tournament）各自
//一列，用 world_id 查詢（不再假設永遠只有 id=1 這一列）。
async function loadWorldFromDb(worldId){
  const client = getClient();
  const rows = await client`SELECT world_data FROM game_world WHERE world_id = ${worldId}`;
  if(rows.length === 0) return null;
  return rows[0].world_data; // postgres.js 會自動把 JSONB 轉成 JS 物件
}

// ── 寫入指定 world 的存檔（UPSERT：第一次是新增，之後都是更新同一列）──
// [Phase 7B] 加入 worldId 參數；ON CONFLICT 改用 world_id（已有 UNIQUE
// INDEX），不再依賴 id 欄位，id 交給資料庫自己用序列產生即可。
async function saveWorldToDb(worldId, worldObject){
  const client = getClient();
  await client`
    INSERT INTO game_world (world_id, world_data, updated_at)
    VALUES (${worldId}, ${client.json(worldObject)}, now())
    ON CONFLICT (world_id) DO UPDATE
      SET world_data = EXCLUDED.world_data,
          updated_at = now()
  `;
}

// ── 簡單的事件記錄（除錯用，非必要）────────────────────────────
// [Phase 7B] 加入可選的 worldId 參數（預設 1＝Main World，向下相容
// 沒有帶這個參數的舊呼叫）。
async function logEvent(eventType, detail, worldId){
  try{
    const client = getClient();
    await client`
      INSERT INTO game_world_log (event_type, detail, world_id)
      VALUES (${eventType}, ${detail || null}, ${worldId || 1})
    `;
  }catch(err){
    // log 記錄失敗不應該影響主流程，只印出來看
    console.error("[Phase3 Server] 寫入 game_world_log 失敗：", err.message);
  }
}

module.exports = {
  ensureSchema,
  loadWorldFromDb,
  saveWorldToDb,
  logEvent,
  getClient,
};

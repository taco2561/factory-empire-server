// ══════════════════════════════════════════════════════════════
// Factory Empire v3 — Phase 3 資料庫連線模組
//
// 這支檔案獨立於六個核心遊戲邏輯模組之外，不屬於「遊戲規則」的
// 一部分，純粹負責跟 Supabase（PostgreSQL）對話：
//   - loadWorldFromDb()：啟動時讀取資料庫裡的 world JSON
//   - saveWorldToDb(jsonString)：把目前的 world JSON 寫回資料庫
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
}

// ── 讀取目前存檔（若資料庫裡還沒有任何資料，回傳 null）─────────
async function loadWorldFromDb(){
  const client = getClient();
  const rows = await client`SELECT world_data FROM game_world WHERE id = 1`;
  if(rows.length === 0) return null;
  return rows[0].world_data; // postgres.js 會自動把 JSONB 轉成 JS 物件
}

// ── 寫入存檔（UPSERT：第一次是新增，之後都是更新同一列）─────────
async function saveWorldToDb(worldObject){
  const client = getClient();
  await client`
    INSERT INTO game_world (id, world_data, updated_at)
    VALUES (1, ${client.json(worldObject)}, now())
    ON CONFLICT (id) DO UPDATE
      SET world_data = EXCLUDED.world_data,
          updated_at = now()
  `;
}

// ── 簡單的事件記錄（除錯用，非必要）────────────────────────────
async function logEvent(eventType, detail){
  try{
    const client = getClient();
    await client`
      INSERT INTO game_world_log (event_type, detail)
      VALUES (${eventType}, ${detail || null})
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
};

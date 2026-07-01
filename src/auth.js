// ══════════════════════════════════════════════════════════════
// Factory Empire v3 — Phase 6A：玩家帳號系統
//
// 設計說明：
//   - 密碼用 bcryptjs hash（純 JS，不需要 native 編譯）
//   - 登入後發 JWT token，有效期 7 天
//   - JWT secret 從環境變數 JWT_SECRET 讀取
//   - 所有 API 需在 Authorization header 帶 Bearer token
//   - WebSocket 連線時在 query string 帶 token
//
// 流程：
//   註冊：POST /api/auth/register { username, password }
//         → 建立 players 記錄 + 在 world 新增玩家公司
//         → 回傳 JWT token + company 資訊
//
//   登入：POST /api/auth/login { username, password }
//         → 驗證密碼，找到對應的 company_id
//         → 回傳 JWT token + company 資訊
//
//   驗證：每個需要身份的 API，從 Authorization header 取 token
//         → 解碼 JWT，取得 playerId + companyId
//         → 用 companyId 在 world.companies 找到玩家公司
// ══════════════════════════════════════════════════════════════

const bcrypt = require("bcryptjs");
const jwt    = require("jsonwebtoken");

const JWT_SECRET  = process.env.JWT_SECRET || "factory-empire-dev-secret-change-in-production";
const JWT_EXPIRES = "7d";
const BCRYPT_ROUNDS = 10;

// ── 從資料庫模組取得連線（避免循環依賴，用 lazy require）────
function getDb(){
  return require("./db");
}

// ══════════════════════════════════════════════════════════════
// 資料庫初始化
// ══════════════════════════════════════════════════════════════
async function ensureAuthSchema(){
  const db = getDb();
  const sql = db.getClient();
  await sql`
    CREATE TABLE IF NOT EXISTS players (
      id            BIGSERIAL PRIMARY KEY,
      username      TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      company_id    TEXT,
      company_name  TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_login_at TIMESTAMPTZ,
      CONSTRAINT username_length CHECK (char_length(username) >= 2 AND char_length(username) <= 20)
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_players_username ON players (username)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_players_company_id ON players (company_id)`;
  await sql`
    CREATE TABLE IF NOT EXISTS player_login_log (
      id          BIGSERIAL PRIMARY KEY,
      player_id   BIGINT REFERENCES players(id),
      event_type  TEXT NOT NULL,
      ip          TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
}

// ══════════════════════════════════════════════════════════════
// JWT 工具
// ══════════════════════════════════════════════════════════════
function signToken(payload){
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

function verifyToken(token){
  try{
    return { ok:true, data: jwt.verify(token, JWT_SECRET) };
  } catch(e){
    return { ok:false, error: e.message };
  }
}

// ── 從 HTTP request 的 Authorization header 取出 token ───────
function extractToken(req){
  var auth = req.headers["authorization"] || "";
  if(auth.startsWith("Bearer ")) return auth.slice(7);
  // 也支援 query string（供 WebSocket 使用）
  var url = new URL(req.url, "http://localhost");
  return url.searchParams.get("token") || null;
}

// ── middleware：驗證 JWT，把 player 資訊附加到 req 上 ────────
function requireAuth(req){
  var token = extractToken(req);
  if(!token) return { ok:false, error:"未提供 token，請先登入" };
  return verifyToken(token);
}

// ══════════════════════════════════════════════════════════════
// 在 world 新增玩家公司（C 方案：每個玩家獨立新增一家公司）
// ══════════════════════════════════════════════════════════════
function createPlayerCompany(sandbox, username){
  // 呼叫 sandbox 裡已定義的 makeCompany 和 assignBuildingDisplayNames
  var company = sandbox.makeCompany(username + "的公司", false, 10000, null);
  // 玩家公司標記（用 userId 而不是 isPlayer:true，因為可能有多個玩家）
  company.isPlayerCompany = true;
  company.ownerUsername   = username;
  sandbox.world.companies.push(company);
  // 存回資料庫（背景非同步）
  if(typeof sandbox.saveWorld === "function") sandbox.saveWorld();
  return company;
}

// ══════════════════════════════════════════════════════════════
// 用 playerId（資料庫 id）找到對應的 world 公司
// ══════════════════════════════════════════════════════════════
function findPlayerCompany(sandbox, companyId){
  return sandbox.world.companies.find(function(c){ return c.id === companyId; }) || null;
}

// ══════════════════════════════════════════════════════════════
// 帳號 API 處理器（由 api.js 呼叫）
// ══════════════════════════════════════════════════════════════

// ── POST /api/auth/register ───────────────────────────────────
async function handleRegister(req, sandbox){
  var body = await readBody(req);
  var username = (body.username || "").trim();
  var password = (body.password || "").trim();

  // 驗證輸入
  if(!username || username.length < 2 || username.length > 20){
    return { ok:false, error:"帳號名稱需為 2~20 個字元" };
  }
  if(!password || password.length < 6){
    return { ok:false, error:"密碼至少需要 6 個字元" };
  }
  // 只允許英數字和底線
  if(!/^[a-zA-Z0-9_\u4e00-\u9fa5]+$/.test(username)){
    return { ok:false, error:"帳號只能包含英文、數字、底線或中文" };
  }

  const db = getDb();
  const sql = db.getClient();

  // 檢查帳號是否已存在
  var existing = await sql`SELECT id FROM players WHERE username = ${username}`;
  if(existing.length > 0){
    return { ok:false, error:"此帳號名稱已被使用" };
  }

  // Hash 密碼
  var hash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  // 在 world 新增玩家公司
  var company = createPlayerCompany(sandbox, username);

  // 存進資料庫
  var rows = await sql`
    INSERT INTO players (username, password_hash, company_id, company_name)
    VALUES (${username}, ${hash}, ${company.id}, ${company.name})
    RETURNING id, username, company_id, company_name, created_at
  `;
  var player = rows[0];

  // 記錄 log
  await sql`INSERT INTO player_login_log (player_id, event_type) VALUES (${player.id}, 'register')`;

  // 發 JWT
  var token = signToken({ playerId: player.id, username: player.username, companyId: player.company_id });

  return {
    ok: true,
    token: token,
    player: { id: player.id, username: player.username, companyId: player.company_id, companyName: player.company_name },
    company: { id: company.id, name: company.name, cash: company.cash },
  };
}

// ── POST /api/auth/login ──────────────────────────────────────
async function handleLogin(req, sandbox){
  var body = await readBody(req);
  var username = (body.username || "").trim();
  var password = (body.password || "").trim();

  if(!username || !password){
    return { ok:false, error:"請填寫帳號和密碼" };
  }

  const db = getDb();
  const sql = db.getClient();

  var rows = await sql`SELECT * FROM players WHERE username = ${username}`;
  if(rows.length === 0){
    return { ok:false, error:"帳號或密碼錯誤" };
  }
  var player = rows[0];

  // 驗證密碼
  var match = await bcrypt.compare(password, player.password_hash);
  if(!match){
    return { ok:false, error:"帳號或密碼錯誤" };
  }

  // 確認 world 裡還有對應的公司（防止 world 被重置後找不到）
  var company = findPlayerCompany(sandbox, player.company_id);
  if(!company){
    // world 被重置了，重新建立公司
    company = createPlayerCompany(sandbox, username);
    await sql`UPDATE players SET company_id = ${company.id}, company_name = ${company.name} WHERE id = ${player.id}`;
  }

  // 更新最後登入時間
  await sql`UPDATE players SET last_login_at = now() WHERE id = ${player.id}`;
  await sql`INSERT INTO player_login_log (player_id, event_type) VALUES (${player.id}, 'login')`;

  // 發 JWT
  var token = signToken({ playerId: player.id, username: player.username, companyId: company.id });

  return {
    ok: true,
    token: token,
    player: { id: player.id, username: player.username, companyId: company.id, companyName: company.name },
    company: { id: company.id, name: company.name, cash: company.cash },
  };
}

// ── GET /api/auth/me（驗證目前 token 是否有效）──────────────
async function handleMe(req, sandbox){
  var auth = requireAuth(req);
  if(!auth.ok) return { ok:false, error: auth.error };

  var company = findPlayerCompany(sandbox, auth.data.companyId);
  if(!company) return { ok:false, error:"找不到對應的公司，請重新登入" };

  return {
    ok: true,
    player: { id: auth.data.playerId, username: auth.data.username, companyId: auth.data.companyId },
    company: { id: company.id, name: company.name, cash: company.cash, buildings: company.buildings.length },
  };
}

// ══════════════════════════════════════════════════════════════
// 工具：讀取 HTTP request body
// ══════════════════════════════════════════════════════════════
function readBody(req){
  return new Promise(function(resolve, reject){
    var body = "";
    req.on("data", function(chunk){ body += chunk; });
    req.on("end", function(){
      try{ resolve(JSON.parse(body || "{}")); }
      catch(e){ resolve({}); }
    });
    req.on("error", reject);
  });
}

module.exports = {
  ensureAuthSchema,
  requireAuth,
  extractToken,
  verifyToken,
  findPlayerCompany,
  handleRegister,
  handleLogin,
  handleMe,
};

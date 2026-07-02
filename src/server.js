// ══════════════════════════════════════════════════════════════
// Factory Empire v3 — Server (Phase 1~6 + Phase 7B WorldManager)
//
// Phase 1：把六個核心邏輯模組搬到 Node.js 伺服器執行。
// Phase 2：部署到 Railway，作為純背景服務 24 小時運行。
// Phase 3：world 狀態改存進 Supabase（PostgreSQL），取代原本只存在
//          記憶體中的做法，讓伺服器重啟後能恢復上一次的進度。
// Phase 7B：把「建立 sandbox / 讀檔 / 跑 tick」這套邏輯搬進獨立的
//           world-manager.js，讓 Server 未來能同時管理多個 World
//           （Main World + Tournament World）。這支檔案現在只負責
//           啟動 Main World（worldId=1）並掛上 HTTP/WebSocket。
// ══════════════════════════════════════════════════════════════

const http = require("http");
const db   = require("./db");
const api  = require("./api");
const ws   = require("./ws-server");
const auth = require("./auth");
const worldManager = require("./world-manager");

// ── 未捕捉例外記錄 ───────────────────────────────────────────
process.on("uncaughtException", function(err){
  console.error("[Server] 未捕捉例外，程序即將結束：", err);
  process.exit(1);
});
process.on("unhandledRejection", function(reason){
  console.error("[Server] 未處理的 Promise rejection：", reason);
});

const MAIN_WORLD_ID = 1;

async function main(){
  console.log("[Server] 連接資料庫、確保資料表存在中…");
  try{
    await db.ensureSchema();
    await auth.ensureAuthSchema();
  } catch(err){
    // 資料庫連線失敗時的退路：不讓整個伺服器掛掉，world-manager 內部
    // loadWorld() 也有自己的 try/catch，會自動退回純記憶體模式。
    console.error("[Server] ensureSchema 失敗（將嘗試繼續以純記憶體模式運行）：", err.message);
  }

  // ── 載入 Main World（Phase 7B：透過 WorldManager，行為與之前完全相同）──
  const sandbox = await worldManager.loadWorld(MAIN_WORLD_ID);

  // ── 啟動 HTTP REST API Server ─────────────────────────────────
  const PORT = process.env.PORT || 3000;
  const httpServer = http.createServer(api.createRequestHandler(sandbox, null)); // wss 在建立後注入

  // ── 建立 WebSocket Server（共用同一個 HTTP server）───────────
  const wss = ws.createWebSocketServer(httpServer, sandbox);

  // 重新建立 request handler，這次帶入 wss
  // （必須在 wss 建立後才能傳入，所以先用 null 建 HTTP server，再重設 handler）
  httpServer.removeAllListeners("request");
  httpServer.on("request", api.createRequestHandler(sandbox, wss));

  httpServer.listen(PORT, function(){
    console.log("[Server] HTTP + WebSocket 已啟動，監聽 port " + PORT);
    console.log("[API] 主要路由：");
    console.log("  GET  /api/health         → 健康檢查");
    console.log("  GET  /api/world/summary  → 精簡世界摘要");
    console.log("  GET  /api/world          → 完整 world 狀態");
    console.log("  POST /api/action         → 執行玩家操作");
    console.log("  WebSocket：ws://同網址 → 即時 world 更新");
  });

  // ── 啟動 Main World 的 tick 迴圈（只會啟動這一次，
  //    修正舊版曾經重複呼叫兩次、變成兩個重疊 tick 迴圈的問題）──
  worldManager.startTick(MAIN_WORLD_ID, function(sb){
    ws.broadcastTick(wss, sb);
    if(sb.world.dayTick === 0) logWorldSummary(sb.world);
  });
}

function logWorldSummary(world){
  const player = world.companies.find(function(c){ return c.isPlayer; });
  const aliveNpc = world.companies.filter(function(c){ return !c.isPlayer && !c.bankrupt; }).length;
  const bankruptNpc = world.companies.filter(function(c){ return !c.isPlayer && c.bankrupt; }).length;

  console.log(
    "[Server] Day " + world.day +
    " | Tick " + world.tick +
    " | 玩家現金（第一家）$" + Math.round(player ? player.cash : 0) +
    " | 存活NPC " + aliveNpc +
    " | 破產NPC " + bankruptNpc +
    " | 景氣 " + (world.economyState && world.economyState.prosperityLabel)
  );
}

main().catch(function(err){
  console.error("[Server] 啟動失敗：", err);
  process.exit(1);
});


// ══════════════════════════════════════════════════════════════
// Factory Empire v3 — Phase 5A：WebSocket Server
//
// 設計原則：
//   - 共用 Phase 4A 建立的 HTTP server（同一個 port），
//     WebSocket 是 HTTP 的協定升級，不需要額外 port。
//   - Server 每個 tick 結束後廣播 world summary 給所有連線的前端。
//   - 前端可以即時看到天數、現金、景氣等狀態自動更新，不需要手動重整。
//   - Phase 5A 不做身份驗證，任何連線都接受（多人化的身份驗證留到之後）。
//   - 單人模式完全不受影響：前端不連 WebSocket 也能正常玩。
//
// 訊息格式（Server → 前端）：
//   { type: "WORLD_UPDATE", data: { ...worldSummary } }
//   { type: "TICK",         data: { day, tick, dayTick } }
//   { type: "PONG",         data: {} }
//
// 訊息格式（前端 → Server）：
//   { type: "PING" }          → Server 回 PONG（保持連線活著）
//   { type: "SUBSCRIBE" }     → 訂閱世界更新（目前預設所有連線都訂閱）
// ══════════════════════════════════════════════════════════════

const WebSocket = require("ws");

// ── 廣播給所有連線中的前端 ────────────────────────────────────
function broadcast(wss, message){
  var payload = JSON.stringify(message);
  wss.clients.forEach(function(client){
    if(client.readyState === WebSocket.OPEN){
      client.send(payload);
    }
  });
}

// ── 建立 world summary（與 api.js 的 buildWorldSummary 相同邏輯，
//    獨立一份避免循環依賴）────────────────────────────────────
function buildSummary(world){
  var player = world.companies.find(function(c){ return c.isPlayer; });
  return {
    day:     world.day,
    tick:    world.tick,
    dayTick: world.dayTick,
    speed:   world.speed || 1,
    prosperityLabel: world.economyState && world.economyState.prosperityLabel,
    economicIndex:   world.economyState && world.economyState.economicIndex,
    moneySupply:     world.economyState && world.economyState.moneySupply,
    player: player ? {
      id:      player.id,
      name:    player.name,
      cash:    player.cash,
      isPlayer:true,
    } : null,
    aliveNpc:    world.companies.filter(function(c){ return !c.isPlayer && !c.bankrupt; }).length,
    bankruptNpc: world.companies.filter(function(c){ return !c.isPlayer && c.bankrupt; }).length,
    notifications: (world.notifications || []).slice(0, 5), // 最新5則通知
  };
}

// ── 建立 WebSocket server，掛在既有的 HTTP server 上 ─────────
function createWebSocketServer(httpServer, sandbox){
  const wss = new WebSocket.Server({ server: httpServer });

  wss.on("connection", function(ws, req){
    var ip = req.socket.remoteAddress || "unknown";
    console.log("[Phase5A WS] 新連線 from " + ip +
                "，目前連線數：" + wss.clients.size);

    // 連線後立即推送一次當前 world 狀態，讓前端馬上有資料可以顯示
    ws.send(JSON.stringify({
      type: "WORLD_UPDATE",
      data: buildSummary(sandbox.world),
    }));

    // 接收前端訊息
    ws.on("message", function(raw){
      var msg;
      try{ msg = JSON.parse(raw); }
      catch(e){ return; }

      if(msg.type === "PING"){
        ws.send(JSON.stringify({ type: "PONG", data: {} }));
      }
      // 未來：SUBSCRIBE、ACTION 等訊息可在這裡擴充
    });

    ws.on("close", function(){
      console.log("[Phase5A WS] 連線關閉，剩餘連線數：" + wss.clients.size);
    });

    ws.on("error", function(err){
      console.error("[Phase5A WS] 連線錯誤：", err.message);
    });
  });

  console.log("[Phase5A WS] WebSocket Server 已建立，共用 HTTP server port");
  return wss;
}

// ── 每次 tick 後呼叫，廣播更新給所有連線的前端 ───────────────
// 這個函式由 server.js 的 tick 迴圈呼叫。
// Phase 5A：每個 tick 廣播一次輕量 TICK 訊息；
//           每個遊戲天（dayTick === 0）廣播一次完整 WORLD_UPDATE。
function broadcastTick(wss, sandbox){
  if(!wss || wss.clients.size === 0) return; // 沒有人連線就不廣播

  var world = sandbox.world;

  // 每 tick 送輕量更新（只有 day/tick/dayTick，保持畫面計時器跳動）
  broadcast(wss, {
    type: "TICK",
    data: { day: world.day, tick: world.tick, dayTick: world.dayTick },
  });

  // 每個遊戲天結束（dayTick 剛重置為 0）送完整 world summary
  if(world.dayTick === 0){
    broadcast(wss, {
      type: "WORLD_UPDATE",
      data: buildSummary(world),
    });
  }
}

module.exports = { createWebSocketServer, broadcastTick, buildSummary };

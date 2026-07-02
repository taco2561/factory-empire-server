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
const auth      = require("./auth");

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
// [Phase 6B] 加入 companyId 參數：回傳「這個連線自己的公司」摘要，
// 而不是全域搜尋一個 isPlayer 公司（多人模式下每個連線的 companyId
// 都不同，這份資料本來就該是各自獨立的）。
function buildSummary(world, companyId){
  var player = companyId
    ? world.companies.find(function(c){ return c.id === companyId; })
    : null;
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
    // [Phase 6B-2] 只回傳這個連線看得到的通知（公開事件 + 自己的私人通知）
    notifications: (world.notifications || []).filter(function(n){
      return !n.companyId || n.companyId === companyId;
    }).slice(0, 5),
  };
}

// ── 傳送給單一連線（帶入該連線自己的 companyId）────────────────
function sendToClient(client, message){
  if(client.readyState === WebSocket.OPEN){
    client.send(JSON.stringify(message));
  }
}

// ══════════════════════════════════════════════════════════════
// [Phase 6B-2] 「共享世界」修正：跟 api.js 的同名函式邏輯完全一致，
// 獨立一份避免循環依賴（api.js 已經 require 了 ws-server.js，
// 這裡不能反過來 require api.js）。
//   - 自己的公司：完整資料
//   - NPC 公司：維持公開（遊戲機制需要）
//   - 其他真人玩家：只留公開欄位，私人資料（現金/建築/倉庫…）拿掉
// ══════════════════════════════════════════════════════════════
function sanitizeWorldForClient(world, companyId){
  var companies = world.companies.map(function(c){
    if(c.id === companyId) return c;
    if(!c.isPlayerCompany) return c;
    return {
      id: c.id,
      name: c.name,
      isPlayer: true,
      isPlayerCompany: true,
      bankrupt: !!c.bankrupt,
      workers: c.workers || 0,
    };
  });
  var out = Object.assign({}, world, { companies: companies });
  out.notifications = (world.notifications || []).filter(function(n){
    return !n.companyId || n.companyId === companyId;
  });
  return out;
}

// ── 建立 WebSocket server，掛在既有的 HTTP server 上 ─────────
function createWebSocketServer(httpServer, sandbox){
  const wss = new WebSocket.Server({ server: httpServer });

  wss.on("connection", function(ws, req){
    var ip = req.socket.remoteAddress || "unknown";

    // [Phase 6A] 驗證 token（從 query string 取得，例如 ?token=xxx）
    var authResult = auth.extractToken(req)
      ? auth.verifyToken(auth.extractToken(req))
      : { ok: false };

    if(authResult.ok){
      ws.playerId  = authResult.data.playerId;
      ws.companyId = authResult.data.companyId;
      ws.username  = authResult.data.username;
      console.log("[Phase5A WS] 玩家 " + ws.username + " 連線，companyId:" + ws.companyId);
    } else {
      // 未登入也可以連線（觀看模式），但 companyId 為 null
      ws.playerId  = null;
      ws.companyId = null;
      ws.username  = "guest";
      console.log("[Phase5A WS] 訪客連線 from " + ip);
    }

    console.log("[Phase5A WS] 目前連線數：" + wss.clients.size);

    // 連線後立即推送一次當前 world 狀態，讓前端馬上有資料可以顯示
    // [Phase 6B] 帶入這個連線自己的 companyId，回傳自己的公司資料
    ws.send(JSON.stringify({
      type: "WORLD_UPDATE",
      data: buildSummary(sandbox.world, ws.companyId),
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
// [Phase 6B] WORLD_UPDATE 內含「自己的公司」資料，每個連線的
// companyId 不同，因此改成逐一連線各自送出個人化內容，
// 不能再用同一份 broadcast() 送給所有人。
function broadcastTick(wss, sandbox){
  if(!wss || wss.clients.size === 0) return; // 沒有人連線就不廣播

  var world = sandbox.world;

  // 每 tick 送輕量更新（只有 day/tick/dayTick，不含玩家資料，全體廣播即可）
  broadcast(wss, {
    type: "TICK",
    data: { day: world.day, tick: world.tick, dayTick: world.dayTick },
  });

  // 每個遊戲天結束（dayTick 剛重置為 0）送完整 world summary（各自個人化）
  if(world.dayTick === 0){
    wss.clients.forEach(function(client){
      sendToClient(client, {
        type: "WORLD_UPDATE",
        data: buildSummary(world, client.companyId),
      });
    });
  }
}

module.exports = { createWebSocketServer, broadcastTick, buildSummary, broadcastWorldUpdate };

// ── [Phase 5B] 廣播完整 world 給所有前端（Action 執行後呼叫）─
// [Phase 6B-2] 原本用 broadcast() 把「完全相同、未過濾」的 world
// 送給所有連線，等於每次任何人操作，所有人都收到所有其他玩家的
// 完整資料（現金/建築/倉庫…）。改成逐一連線各自送出「遮蔽過的」
// world，每個人只看得到自己的完整資料 + NPC 公開資料 + 其他玩家
// 的公開欄位。
function broadcastWorldUpdate(wss, sandbox){
  if(!wss || wss.clients.size === 0) return;
  wss.clients.forEach(function(client){
    sendToClient(client, {
      type: "WORLD_FULL_UPDATE",
      data: sanitizeWorldForClient(sandbox.world, client.companyId),
    });
  });
}

// ══════════════════════════════════════════════════════════════
// Factory Empire v3 — Phase 5A：WebSocket Server
// [Phase 7C] 改成 worldId 感知：每個連線記錄自己屬於哪個 world
// （從 token 解析，訪客預設 Main World），廣播時只送給同一個
// world 的連線，透過 WorldManager 動態找到對應的 sandbox。
//
// 設計原則：
//   - 共用 HTTP server（同一個 port），WebSocket 是 HTTP 的協定升級，
//     不需要額外 port。
//   - Server 每個 tick 結束後廣播 world summary 給對應 world 的前端。
//   - 前端可以即時看到天數、現金、景氣等狀態自動更新，不需要手動重整。
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
const worldManager = require("./world-manager");

const DEFAULT_WORLD_ID = 1; // Main World

// ── 廣播給所有連線中的前端 ────────────────────────────────────
function broadcast(wss, message){
  var payload = JSON.stringify(message);
  wss.clients.forEach(function(client){
    if(client.readyState === WebSocket.OPEN){
      client.send(payload);
    }
  });
}

// ── 只廣播給屬於指定 worldId 的連線 ──────────────────────────
// [Phase 7C] 多個 world 可能同時有連線，不能再對所有連線一視同仁。
function broadcastToWorld(wss, worldId, message){
  var payload = JSON.stringify(message);
  wss.clients.forEach(function(client){
    if(client.readyState === WebSocket.OPEN && client.worldId === worldId){
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
// [Phase 7C] 不再需要固定的 sandbox 參數——每個連線各自解析自己的
// worldId，透過 worldManager 動態找到對應的 sandbox。
function createWebSocketServer(httpServer){
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
      ws.worldId   = authResult.data.worldId || DEFAULT_WORLD_ID;
      console.log("[WS] 玩家 " + ws.username + " 連線，worldId:" + ws.worldId + " companyId:" + ws.companyId);
    } else {
      // 未登入也可以連線（觀看模式），但 companyId 為 null，
      // 預設觀看 Main World（目前唯一公開可觀戰的 world）。
      ws.playerId  = null;
      ws.companyId = null;
      ws.username  = "guest";
      ws.worldId   = DEFAULT_WORLD_ID;
      console.log("[WS] 訪客連線 from " + ip + "，觀看 world " + ws.worldId);
    }

    console.log("[WS] 目前連線數：" + wss.clients.size);

    // [Phase 7C-fix] 標準的 ws 心跳偵測：瀏覽器分頁被直接關掉、電腦睡眠、
    // 網路忽然斷線這幾種情況，TCP 連線可能不會乾淨地觸發 "close" 事件，
    // 導致這個連線變成「殭屍連線」——一直留在 wss.clients 裡，持續收到
    // 廣播，卻沒有真正的使用者在另一端接收，白白浪費流量。
    // 用底層的 WebSocket ping/pong frame（不是我們自己在 JSON 訊息裡定義
    // 的 PING/PONG，那個只是給前端顯示連線狀態用的）偵測連線是否還活著，
    // 沒有在下一輪心跳前回應就直接終止。
    ws.isAlive = true;
    ws.on("pong", function(){ ws.isAlive = true; });

    var sandbox = worldManager.getSandbox(ws.worldId);
    if(!sandbox){
      console.warn("[WS] worldId " + ws.worldId + " 尚未載入，關閉這個連線");
      ws.close();
      return;
    }

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
      console.log("[WS] 連線關閉，剩餘連線數：" + wss.clients.size);
    });

    ws.on("error", function(err){
      console.error("[WS] 連線錯誤：", err.message);
    });
  });

  console.log("[WS] WebSocket Server 已建立，共用 HTTP server port");

  // [Phase 7C-fix] 每 30 秒檢查一次所有連線：上一輪沒有回應 pong 的
  // 就直接終止（代表對面已經斷線但我們還不知道）。
  var heartbeatInterval = setInterval(function(){
    wss.clients.forEach(function(client){
      if(client.isAlive === false){
        console.log("[WS] 偵測到殭屍連線（無回應），終止：" + (client.username || "unknown"));
        return client.terminate();
      }
      client.isAlive = false;
      client.ping();
    });
  }, 30000);
  wss.on("close", function(){ clearInterval(heartbeatInterval); });

  return wss;
}

// ── 每次 tick 後呼叫，廣播更新給對應 world 的連線 ───────────────
// 這個函式由 world-manager 的 tick callback（在 server.js 裡設定）呼叫。
// 每個 tick 廣播一次輕量 TICK 訊息；每個遊戲天（dayTick === 0）
// 廣播一次完整 WORLD_UPDATE。
// [Phase 7C] 加入 worldId 參數：只送給連到「這個 world」的連線
// （TICK 訊息本身不含玩家資料，理論上送給誰都無妨，但還是照 worldId
// 過濾，避免將來 Tournament World 的玩家收到 Main World 的天數/Tick
// 造成困惑）。
function broadcastTick(wss, sandbox, worldId){
  if(!wss || wss.clients.size === 0) return; // 沒有人連線就不廣播
  worldId = worldId || DEFAULT_WORLD_ID;

  var world = sandbox.world;

  broadcastToWorld(wss, worldId, {
    type: "TICK",
    data: { day: world.day, tick: world.tick, dayTick: world.dayTick },
  });

  // 每個遊戲天結束（dayTick 剛重置為 0）送完整 world summary（各自個人化）
  if(world.dayTick === 0){
    wss.clients.forEach(function(client){
      if(client.worldId !== worldId) return;
      sendToClient(client, {
        type: "WORLD_UPDATE",
        data: buildSummary(world, client.companyId),
      });
    });
  }
}

module.exports = { createWebSocketServer, broadcastTick, buildSummary, broadcastWorldUpdate, sanitizeWorldForClient };

// ── [Phase 5B] 廣播完整 world 給對應 world 的前端（Action 執行後呼叫）─
// [Phase 6B-2] 原本用 broadcast() 把「完全相同、未過濾」的 world
// 送給所有連線，等於每次任何人操作，所有人都收到所有其他玩家的
// 完整資料（現金/建築/倉庫…）。改成逐一連線各自送出「遮蔽過的」
// world，每個人只看得到自己的完整資料 + NPC 公開資料 + 其他玩家
// 的公開欄位。
// [Phase 7C] 加入 worldId 參數：只送給連到「這個 world」的連線
// （避免 Tournament World 的操作結果被廣播到 Main World 的連線）。
// [Phase 7C-fix] 加入 actingCompanyId 參數：只送給「操作者自己」
// 開著的分頁（支援多分頁同步），不再廣播給這個 world 裡的所有連線。
// 原因：其他玩家本來就看不到別人操作的私人資料（隱私已遮蔽），沒
// 必要即時收到別人操作後的整包 world（約150~200KB）——這是實測發現
// Railway Egress 流量異常暴增的主因：每次任何操作都把整包資料重複
// 傳給所有連線的分頁，長期累積下來流量非常可觀。其他人該看到的公開
// 資訊（天數/景氣等）仍會透過既有的「每日結算」輕量廣播照常更新。
function broadcastWorldUpdate(wss, sandbox, worldId, actingCompanyId){
  if(!wss || wss.clients.size === 0) return;
  worldId = worldId || DEFAULT_WORLD_ID;
  wss.clients.forEach(function(client){
    if(client.worldId !== worldId) return;
    if(actingCompanyId && client.companyId !== actingCompanyId) return; // 只送給操作者自己（含多分頁）
    sendToClient(client, {
      type: "WORLD_FULL_UPDATE",
      data: sanitizeWorldForClient(sandbox.world, client.companyId),
    });
  });
}

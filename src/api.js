// ══════════════════════════════════════════════════════════════
// Factory Empire v3 — Phase 4A：REST API 路由
//
// 設計原則：
//   - 不加入任何第三方框架（不用 express），只用 Node.js 內建 http 模組
//     讓依賴保持最小，且 package.json 不需要額外套件
//   - 所有遊戲邏輯仍由 sandbox（vm context）執行，API 只是橋接層
//   - 前端完全不改（Phase 4A 規格），API 供 Postman/curl 測試用
//   - Action 格式統一設計好，Phase 4B/4C 前端接上時直接沿用
//
// API 路由：
//   GET  /api/world          → 取得目前完整 world 狀態（供前端渲染用）
//   GET  /api/world/summary  → 取得精簡摘要（供快速輪詢用）
//   POST /api/action         → 執行玩家操作（統一 Action 格式）
//   GET  /api/health         → 健康檢查（確認 Server 正在跑）
// ══════════════════════════════════════════════════════════════

// ── Action 處理器：把 Action type 對應到 sandbox 內的遊戲函式 ──
// sandbox 是 vm context，所有遊戲邏輯函式都在裡面
function handleAction(sandbox, action){
  var type    = action.type;
  var payload = action.payload || {};
  var s       = sandbox;

  // 自動取得玩家 ID（Phase 4A 單人模式，直接找 isPlayer:true 的公司）
  // Phase 5 多人化後這裡會改成從 token/session 取得
  var player  = s.world.companies.find(function(c){ return c.isPlayer; });
  if(!player) return { ok: false, error: "找不到玩家公司" };
  var pid = player.id;

  try{
    switch(type){

      // ── 建築 ─────────────────────────────────────────────────
      case "BUILD":
        // payload: { buildingType: "quarry" }
        var r = s.startBuilding(pid, payload.buildingType);
        return r ? { ok:true } : { ok:false, error:"建造失敗（現金不足或類型無效）" };

      // ── 生產 ─────────────────────────────────────────────────
      case "PRODUCE":
        // payload: { buildingId, productId, qty, repeat?, repeatTotal? }
        var repeatInfo = null;
        if(payload.repeat && payload.repeatTotal){
          repeatInfo = { total: payload.repeatTotal };
        }
        var r2 = s.enqueueProduction(pid, payload.buildingId, payload.productId, payload.qty, repeatInfo);
        return r2 && r2.ok ? { ok:true } : { ok:false, error: r2 ? r2.msg : "生產入隊失敗" };

      case "STOP_REPEAT":
        // payload: { buildingId, jobIndex? }
        s.stopRepeatProduction(payload.buildingId, payload.jobIndex||0);
        return { ok:true };

      // ── 市場交易 ─────────────────────────────────────────────
      case "MARKET_ORDER":
        // payload: { productId, side("buy"|"sell"), qty, price }
        var r3 = s.createOrder(pid, payload.productId, payload.side, payload.qty, payload.price);
        return r3 && r3.ok ? { ok:true, orderId: r3.orderId } : { ok:false, error: r3 ? r3.reason : "掛單失敗" };

      case "CANCEL_ORDER":
        // payload: { orderId }
        var found = s.cancelOrder(payload.orderId);
        return { ok: !!found };

      // ── 銀行 ─────────────────────────────────────────────────
      case "TAKE_LOAN":
        // payload: { amount, term }
        var r4 = s.takeLoan(pid, payload.amount, payload.term);
        return r4 && r4.ok ? { ok:true } : { ok:false, error: r4 ? r4.reason : "貸款失敗" };

      case "MAKE_DEPOSIT":
        // payload: { amount, term }
        var r5 = s.makeDeposit(pid, payload.amount, payload.term);
        return r5 && r5.ok ? { ok:true } : { ok:false, error: r5 ? r5.reason : "存款失敗" };

      case "WITHDRAW_FIXED":
        // payload: { depositId }
        var r6 = s.withdrawFixed(pid, payload.depositId);
        return r6 && r6.ok ? { ok:true } : { ok:false, error: r6 ? r6.reason : "提款失敗" };

      case "WITHDRAW_DEMAND":
        // payload: { amount }
        var r7 = s.withdrawDemand(pid, payload.amount);
        return r7 && r7.ok ? { ok:true } : { ok:false, error: r7 ? r7.reason : "活存提款失敗" };

      // ── 股票 ─────────────────────────────────────────────────
      case "STOCK_BUY":
        // payload: { companyId, qty, price }
        var r8 = s.stockPlaceOrder(payload.companyId, pid, "buy", payload.qty, payload.price);
        return r8 && r8.ok ? { ok:true } : { ok:false, error: r8 ? r8.reason : "買股失敗" };

      case "STOCK_SELL":
        // payload: { companyId, qty, price }
        var r9 = s.stockPlaceOrder(payload.companyId, pid, "sell", payload.qty, payload.price);
        return r9 && r9.ok ? { ok:true } : { ok:false, error: r9 ? r9.reason : "賣股失敗" };

      case "STOCK_SELL_OWN":
        // payload: { qty, price }
        var r10 = s.stockSellOwnShares(pid, payload.qty, payload.price);
        return r10 && r10.ok ? { ok:true } : { ok:false, error: r10 ? r10.reason : "賣出自家股票失敗" };

      case "STOCK_IPO":
        // payload: { ipoPrice }
        var r11 = s.stockExecuteIPO(pid, payload.ipoPrice);
        return r11 && r11.ok ? { ok:true } : { ok:false, error: r11 ? r11.reason : "IPO 失敗" };

      // ── 政府 ─────────────────────────────────────────────────
      case "GOV_FULFILL_ORDER":
        // payload: { orderId, qty }
        var r12 = s.govFulfillOrder(payload.orderId, pid, payload.qty);
        return r12 && r12.ok ? { ok:true } : { ok:false, error: r12 ? r12.reason : "履行訂單失敗" };

      case "GOV_REGISTER":
        // payload: {}
        var r13 = s.govRegisterCandidate(pid);
        return r13 && r13.ok ? { ok:true, deposit: r13.deposit } : { ok:false, error: r13 ? r13.reason : "登記失敗" };

      case "GOV_VOTE":
        // payload: { candidateId }
        var r14 = s.govCastVote(pid, payload.candidateId);
        return r14 && r14.ok ? { ok:true } : { ok:false, error: r14 ? r14.reason : "投票失敗" };

      case "GOV_POLICY":
        // payload: { policyType("labor"|"consume"|"produce") }
        var r15 = s.govIssuePolicy(payload.policyType, pid);
        return r15 && r15.ok ? { ok:true } : { ok:false, error: r15 ? r15.reason : "發布政策失敗" };

      case "BOND_SUBSCRIBE":
        // payload: { bondId, amount }
        var r16 = s.govSubscribeBond(payload.bondId, pid, payload.amount);
        return r16 && r16.ok ? { ok:true, amount: r16.amount } : { ok:false, error: r16 ? r16.reason : "認購失敗" };

      // ── 接待中心 ─────────────────────────────────────────────
      case "RECEPTION_SEARCH":
        // payload: {}
        s.receptionSearchOrders(pid);
        return { ok:true };

      case "RECEPTION_DELIVER":
        // payload: { orderId }
        var r17 = s.receptionDeliverOrder(pid, payload.orderId);
        return r17 && r17.ok ? { ok:true } : { ok:false, error: r17 ? r17.reason : "交付失敗" };

      case "RECEPTION_REJECT":
        // payload: { orderId }
        s.receptionRejectOrder(pid, payload.orderId);
        return { ok:true };

      default:
        return { ok:false, error:"未知的 Action type：" + type };
    }
  } catch(err){
    console.error("[API] Action 執行時發生例外：", type, err);
    return { ok:false, error:"伺服器內部錯誤：" + err.message };
  }
}

// ── 精簡版 world 摘要（給輪詢用，避免每次傳送整個 114KB 的 world）──
function buildWorldSummary(world){
  var player = world.companies.find(function(c){ return c.isPlayer; });
  return {
    day:         world.day,
    tick:        world.tick,
    dayTick:     world.dayTick,
    prosperityLabel: world.economyState && world.economyState.prosperityLabel,
    economicIndex:   world.economyState && world.economyState.economicIndex,
    player: player ? {
      id:    player.id,
      name:  player.name,
      cash:  player.cash,
      assets: player.cash + (player.buildings||[]).reduce(function(s,b){ return s+(b.purchaseCost||0); },0),
    } : null,
    aliveNpc:    world.companies.filter(function(c){ return !c.isPlayer&&!c.bankrupt; }).length,
    bankruptNpc: world.companies.filter(function(c){ return !c.isPlayer&&c.bankrupt; }).length,
  };
}

// ── HTTP 請求路由 ─────────────────────────────────────────────
function createRequestHandler(sandbox, wss){
  // 引入 ws-server 的廣播功能（wss 由 server.js 傳入）
  var wsServer = null;
  try{ wsServer = require("./ws-server"); } catch(e){}

  return function(req, res){
    // CORS header（Phase 4B 前端呼叫 API 時需要）
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Content-Type", "application/json; charset=utf-8");

    // Preflight
    if(req.method === "OPTIONS"){ res.writeHead(204); res.end(); return; }

    var url = req.url.split("?")[0];

    // ── GET /api/health ─────────────────────────────────────
    if(req.method === "GET" && url === "/api/health"){
      res.writeHead(200);
      res.end(JSON.stringify({
        status:  "ok",
        day:     sandbox.world.day,
        tick:    sandbox.world.tick,
        uptime:  Math.floor(process.uptime()) + "s",
      }));
      return;
    }

    // ── GET /api/world/summary ───────────────────────────────
    if(req.method === "GET" && url === "/api/world/summary"){
      res.writeHead(200);
      res.end(JSON.stringify({ ok:true, data: buildWorldSummary(sandbox.world) }));
      return;
    }

    // ── GET /api/world ───────────────────────────────────────
    if(req.method === "GET" && url === "/api/world"){
      // 回傳完整 world（約 114KB JSONB，前端渲染用）
      res.writeHead(200);
      res.end(JSON.stringify({ ok:true, data: sandbox.world }));
      return;
    }

    // ── POST /api/action ─────────────────────────────────────
    if(req.method === "POST" && url === "/api/action"){
      var body = "";
      req.on("data", function(chunk){ body += chunk; });
      req.on("end", function(){
        var action;
        try{
          action = JSON.parse(body);
        } catch(e){
          res.writeHead(400);
          res.end(JSON.stringify({ ok:false, error:"Request body 必須是合法的 JSON" }));
          return;
        }
        if(!action.type){
          res.writeHead(400);
          res.end(JSON.stringify({ ok:false, error:"Action 必須包含 type 欄位" }));
          return;
        }
        var result = handleAction(sandbox, action);
        res.writeHead(result.ok ? 200 : 400);
        res.end(JSON.stringify(result));

        // [Phase 5B] Action 成功後，廣播最新 world 狀態給所有連線的前端
        // 這樣前端不用自己再去 fetch /api/world，Server 主動推過去
        if(result.ok && wss && wsServer){
          wsServer.broadcastWorldUpdate(wss, sandbox);
        }
      });
      return;
    }

    // ── 404 ──────────────────────────────────────────────────
    res.writeHead(404);
    res.end(JSON.stringify({ ok:false, error:"找不到此路由。可用路由：GET /api/health, GET /api/world, GET /api/world/summary, POST /api/action" }));
  };
}

module.exports = { createRequestHandler, buildWorldSummary };

// ══════════════════════════════════════════════════════════════
// Factory Empire v3 — Phase 4A：REST API 路由
// [Phase 7C] 改成透過 WorldManager 依 worldId 動態找到對應的 world，
// 不再假設整個 Server 只有一個固定的 sandbox。
//
// 設計原則：
//   - 不加入任何第三方框架（不用 express），只用 Node.js 內建 http 模組
//     讓依賴保持最小，且 package.json 不需要額外套件
//   - 所有遊戲邏輯仍由 sandbox（vm context）執行，API 只是橋接層
//   - Action 格式統一設計好，前端直接沿用
//
// API 路由：
//   GET  /api/worlds         → 列出目前有哪些 World（Main + Tournament）
//   GET  /api/world          → 取得指定 world 的完整狀態（供前端渲染用）
//   GET  /api/world/summary  → 取得精簡摘要（供快速輪詢用）
//   POST /api/action         → 執行玩家操作（統一 Action 格式）
//   GET  /api/health         → 健康檢查（確認 Server 正在跑）
//
// worldId 怎麼決定：
//   - 已登入：從 JWT payload 的 worldId 取得（登入時就已經綁定）
//   - 未登入（訪客／觀戰）：GET 系列路由可以用 ?worldId= 查詢參數指定，
//     沒指定就預設 Main World（DEFAULT_WORLD_ID = 1）
//   - /api/auth/register、/api/auth/login 目前一律對 Main World 操作
//     （帳號註冊/登入本來就只跟 Main World 有關；Tournament 報名走
//     Phase 7D 才會加入的專屬 join API，不經過這裡）
// ══════════════════════════════════════════════════════════════

const auth = require("./auth");
const db = require("./db");
const worldManager = require("./world-manager");
const wsServer = require("./ws-server");

const DEFAULT_WORLD_ID = 1; // Main World

// ── 從已驗證的 auth 結果取得 worldId，沒有就退回 fallback ────────
function resolveWorldId(authResult, fallbackWorldId){
  if(authResult && authResult.ok && authResult.data && authResult.data.worldId){
    return authResult.data.worldId;
  }
  return fallbackWorldId;
}

// ── 從 URL 的查詢字串取出 ?worldId=，沒有就回傳 null ─────────────
function parseQueryWorldId(req){
  try{
    var url = new URL(req.url, "http://localhost");
    var raw = url.searchParams.get("worldId");
    if(!raw) return null;
    var n = parseInt(raw, 10);
    return isNaN(n) ? null : n;
  } catch(e){
    return null;
  }
}

// ── Action 處理器：把 Action type 對應到 sandbox 內的遊戲函式 ──
// sandbox 是 vm context，所有遊戲邏輯函式都在裡面
// [Phase 6A] companyId 從 JWT token 取得，不再直接找 isPlayer:true
// [Phase 6B] 不再有「沒有 token 就找 isPlayer:true」的向下相容 fallback：
//   多人模式下這個 fallback 完全不安全（會操作到隨機找到的某家公司），
//   且 Phase 6A 移除固定玩家公司後，isPlayer:true 的公司本來就不存在，
//   fallback 只會回傳「找不到玩家公司」，不如直接明確要求登入。
function handleAction(sandbox, action, companyId){
  var type    = action.type;
  var payload = action.payload || {};
  var s       = sandbox;

  if(!companyId) return { ok:false, error:"未登入或 token 已失效，請重新登入" };

  var player = s.world.companies.find(function(c){ return c.id === companyId; });
  if(!player) return { ok:false, error:"找不到玩家公司，請重新登入" };
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
        var found = s.cancelOrder(pid, payload.orderId);
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
        var r17b = s.receptionStartSearch(pid);
        return r17b && r17b.ok ? { ok:true } : { ok:false, error: r17b ? r17b.msg : "開始尋找客戶失敗" };

      case "RECEPTION_DELIVER":
        // payload: { orderId }
        var r17 = s.receptionDeliverOrder(pid, payload.orderId);
        return r17 && r17.ok ? { ok:true } : { ok:false, error: r17 ? r17.msg : "交付失敗" };

      case "RECEPTION_REJECT":
        // payload: {}
        var r18 = s.receptionRejectOrder(pid);
        return r18 && r18.ok ? { ok:true } : { ok:false, error: r18 ? r18.msg : "拒絕失敗" };

      default:
        return { ok:false, error:"未知的 Action type：" + type };
    }
  } catch(err){
    console.error("[API] Action 執行時發生例外：", type, err);
    return { ok:false, error:"伺服器內部錯誤：" + err.message };
  }
}

// ══════════════════════════════════════════════════════════════
// [Phase 6B-2] 「共享世界」修正：大家在同一個 world 裡玩，不代表
// 大家能看到彼此的操作/私人資料。這支函式回傳一份「對這個呼叫者
// 安全」的 world 副本：
//   - 自己的公司：完整資料（前端需要顯示自己的現金/建築/倉庫…）
//   - NPC 公司：維持完整資料（遊戲機制需要：市場競爭觀察、AI 對手
//     資訊、股票交易對象、政府訂單履行對象……這些原本就是公開的
//     模擬經濟資料，不是「玩家隱私」）
//   - 其他真人玩家的公司：只留公開欄位（id/name/isPlayerCompany/
//     破產狀態），現金、建築、倉庫、財務、銀行帳戶、接待中心、
//     決策紀錄、真實帳號名稱……全部拿掉
//   - notifications：只回傳公開事件 + 呼叫者自己的私人通知
// ══════════════════════════════════════════════════════════════
function sanitizeWorldForClient(world, companyId){
  var companies = world.companies.map(function(c){
    if(c.id === companyId) return c;         // 自己的公司：完整資料
    if(!c.isPlayerCompany) return c;         // NPC：維持公開（遊戲機制需要）
    // 其他真人玩家：只留公開欄位
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
  out.notifications = getNotificationsForClient(world, companyId);
  return out;
}

// [Phase 6B-2] 依身份篩選通知（跟 state.js 內的 getNotificationsFor 同邏輯，
// 獨立一份避免跨模組耦合；world.notifications 是原始資料，這裡只做過濾）
function getNotificationsForClient(world, companyId){
  return (world.notifications || []).filter(function(n){
    return !n.companyId || n.companyId === companyId;
  });
}

// ── 精簡版 world 摘要（給輪詢用，避免每次傳送整個 114KB 的 world）──
// [Phase 6B] 加入 companyId 參數：回傳「呼叫者自己的公司」摘要。
// 不帶 companyId（未登入／訪客）時 player 為 null，對應規劃中的
// 觀戰模式（可以看 world 但看不到自己的公司資訊）。
function buildWorldSummary(world, companyId){
  var player = companyId
    ? world.companies.find(function(c){ return c.id === companyId; })
    : null;
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
// [Phase 7C] 不再需要固定的 sandbox 參數——每個路由自己決定要對
// 哪個 world 操作，透過 worldManager.getSandbox(worldId) 動態取得。
function createRequestHandler(wss){
  return function(req, res){
    // CORS header（Phase 4B 前端呼叫 API 時需要）
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Content-Type", "application/json; charset=utf-8");

    // Preflight
    if(req.method === "OPTIONS"){ res.writeHead(204); res.end(); return; }

    var url = req.url.split("?")[0];

    // ── [Phase 6A] 帳號 API（不需要驗證，一律對 Main World 操作）───
    if(req.method === "POST" && url === "/api/auth/register"){
      var registerSandbox = worldManager.getSandbox(DEFAULT_WORLD_ID);
      if(!registerSandbox){
        res.writeHead(503);
        res.end(JSON.stringify({ ok:false, error:"伺服器尚未就緒，請稍後再試" }));
        return;
      }
      auth.handleRegister(req, registerSandbox, DEFAULT_WORLD_ID)
        .then(function(result){
          res.writeHead(result.ok ? 200 : 400);
          res.end(JSON.stringify(result));
        })
        .catch(function(err){
          res.writeHead(500);
          res.end(JSON.stringify({ ok:false, error:"伺服器錯誤：" + err.message }));
        });
      return;
    }

    if(req.method === "POST" && url === "/api/auth/login"){
      var loginSandbox = worldManager.getSandbox(DEFAULT_WORLD_ID);
      if(!loginSandbox){
        res.writeHead(503);
        res.end(JSON.stringify({ ok:false, error:"伺服器尚未就緒，請稍後再試" }));
        return;
      }
      auth.handleLogin(req, loginSandbox, DEFAULT_WORLD_ID)
        .then(function(result){
          res.writeHead(result.ok ? 200 : 401);
          res.end(JSON.stringify(result));
        })
        .catch(function(err){
          res.writeHead(500);
          res.end(JSON.stringify({ ok:false, error:"伺服器錯誤：" + err.message }));
        });
      return;
    }

    if(req.method === "GET" && url === "/api/auth/me"){
      var meAuth = auth.requireAuth(req);
      var meWorldId = resolveWorldId(meAuth, DEFAULT_WORLD_ID);
      var meSandbox = worldManager.getSandbox(meWorldId);
      if(!meSandbox){
        res.writeHead(404);
        res.end(JSON.stringify({ ok:false, error:"找不到對應的 world（worldId:" + meWorldId + "）" }));
        return;
      }
      auth.handleMe(req, meSandbox)
        .then(function(result){
          res.writeHead(result.ok ? 200 : 401);
          res.end(JSON.stringify(result));
        })
        .catch(function(err){
          res.writeHead(500);
          res.end(JSON.stringify({ ok:false, error:"伺服器錯誤：" + err.message }));
        });
      return;
    }

    // ── GET /api/health ─────────────────────────────────────
    if(req.method === "GET" && url === "/api/health"){
      var healthSandbox = worldManager.getSandbox(DEFAULT_WORLD_ID);
      res.writeHead(200);
      res.end(JSON.stringify({
        status:  "ok",
        day:     healthSandbox ? healthSandbox.world.day : null,
        tick:    healthSandbox ? healthSandbox.world.tick : null,
        uptime:  Math.floor(process.uptime()) + "s",
        loadedWorlds: worldManager.listLoadedWorldIds(),
      }));
      return;
    }

    // ── [Phase 7C] GET /api/worlds：列出目前有哪些 World ─────
    // 公開路由，查資料庫的 worlds 表（不是只有記憶體裡目前載入的），
    // 這樣就算 Tournament World 還沒被 WorldManager 載入（例如
    // status='scheduled'，還沒開賽），前端也能看到「即將開始」的資訊。
    if(req.method === "GET" && url === "/api/worlds"){
      db.listWorlds()
        .then(function(rows){
          res.writeHead(200);
          res.end(JSON.stringify({
            ok: true,
            data: rows.map(function(w){
              return {
                id: w.id, type: w.type, name: w.name, status: w.status,
                startsAt: w.starts_at, endsAt: w.ends_at, settings: w.settings,
                loaded: worldManager.isLoaded(w.id),
              };
            }),
          }));
        })
        .catch(function(err){
          res.writeHead(500);
          res.end(JSON.stringify({ ok:false, error:"查詢 world 列表失敗：" + err.message }));
        });
      return;
    }

    // ── GET /api/world/summary ───────────────────────────────
    if(req.method === "GET" && url === "/api/world/summary"){
      // [Phase 6B] 選填身份驗證：有帶 token 就回傳「自己的公司」摘要，
      // 沒帶 token（訪客／觀戰模式）仍可查看世界整體狀態，player 為 null。
      // [Phase 7C] worldId 優先從 token 取得；訪客可用 ?worldId= 指定
      // 要觀看哪個 world，沒指定則預設 Main World。
      var summaryAuth = auth.requireAuth(req);
      var summaryWorldId = resolveWorldId(summaryAuth, parseQueryWorldId(req) || DEFAULT_WORLD_ID);
      var summarySandbox = worldManager.getSandbox(summaryWorldId);
      if(!summarySandbox){
        res.writeHead(404);
        res.end(JSON.stringify({ ok:false, error:"找不到對應的 world（worldId:" + summaryWorldId + "）" }));
        return;
      }
      var summaryCompanyId = summaryAuth.ok ? summaryAuth.data.companyId : null;
      res.writeHead(200);
      res.end(JSON.stringify({ ok:true, data: buildWorldSummary(summarySandbox.world, summaryCompanyId) }));
      return;
    }

    // ── GET /api/world ───────────────────────────────────────
    if(req.method === "GET" && url === "/api/world"){
      // [Phase 6B-2] 選填身份驗證：回傳完整 world，但其他真人玩家的
      // 私人資料（現金/建築/倉庫/財務…）會被遮蔽，只留自己的公司完整可見。
      // 沒帶 token 時等同「訪客」，看不到任何真人玩家的私人資料。
      // [Phase 7C] worldId 解析方式同 /api/world/summary。
      var worldAuth = auth.requireAuth(req);
      var targetWorldId = resolveWorldId(worldAuth, parseQueryWorldId(req) || DEFAULT_WORLD_ID);
      var targetSandbox = worldManager.getSandbox(targetWorldId);
      if(!targetSandbox){
        res.writeHead(404);
        res.end(JSON.stringify({ ok:false, error:"找不到對應的 world（worldId:" + targetWorldId + "）" }));
        return;
      }
      var worldCompanyId = worldAuth.ok ? worldAuth.data.companyId : null;
      res.writeHead(200);
      res.end(JSON.stringify({ ok:true, data: sanitizeWorldForClient(targetSandbox.world, worldCompanyId) }));
      return;
    }

    // ── POST /api/action ─────────────────────────────────────
    if(req.method === "POST" && url === "/api/action"){
      // [Phase 6A] 驗證 JWT，取得 companyId
      var authResult = auth.requireAuth(req);
      var companyId  = authResult.ok ? authResult.data.companyId : null;
      // [Phase 6B] 沒有有效 token 時，companyId 會是 null，
      // handleAction() 內部會直接回覆「請重新登入」，不再做任何 fallback。
      // [Phase 7C] worldId 一律從 token 取得（沒登入就沒有 worldId，
      // 反正 handleAction 也會因為沒有 companyId 而拒絕，這裡用
      // DEFAULT_WORLD_ID 只是給後面找 sandbox 用的安全預設值）。
      var actionWorldId = resolveWorldId(authResult, DEFAULT_WORLD_ID);
      var actionSandbox = worldManager.getSandbox(actionWorldId);

      var body = "";
      req.on("data", function(chunk){ body += chunk; });
      req.on("end", function(){
        if(!actionSandbox){
          res.writeHead(404);
          res.end(JSON.stringify({ ok:false, error:"找不到對應的 world（worldId:" + actionWorldId + "），請重新登入" }));
          return;
        }
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
        var result = handleAction(actionSandbox, action, companyId);
        res.writeHead(result.ok ? 200 : 400);
        res.end(JSON.stringify(result));

        // [Phase 5B] Action 成功後，廣播最新 world 狀態給所有連線的前端
        // [Phase 7C] 只廣播給連到「同一個 world」的連線
        // [Phase 7C-fix] 只送給操作者自己開著的分頁，不再廣播給全部人
        // （降低不必要的流量——見 ws-server.js 的 broadcastWorldUpdate 註解）
        if(result.ok && wss){
          wsServer.broadcastWorldUpdate(wss, actionSandbox, actionWorldId, companyId);
        }
      });
      return;
    }

    // ── 404 ──────────────────────────────────────────────────
    res.writeHead(404);
    res.end(JSON.stringify({ ok:false, error:"找不到此路由。可用路由：GET /api/health, GET /api/worlds, GET /api/world, GET /api/world/summary, POST /api/action" }));
  };
}

module.exports = { createRequestHandler, buildWorldSummary, sanitizeWorldForClient };

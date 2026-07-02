// ══════════════════════════════════════════════════════════════
// Factory Empire v3 — Phase 7B：造市商 NPC（Market Maker）
//
// 專門給 Tournament World 用的「唯一 NPC」，職責跟 npc-ai.js 那套
// 「蓋工廠、做生產/建造決策」的複雜 AI 邏輯完全不同、也單純很多：
// 維持每個商品市場的買賣流動性，不參與生產、不參與建造、不套利。
// 所以獨立成一個模組，不跟 npc-ai.js 混在一起（混了兩邊都難維護）。
//
// 核心規則（跟你確認過的設計）：
//   - 每個商品都維持一組「買單 + 賣單」，價格錨定在目前市場均價，
//     兩者之間留一段價差（spread），玩家沒辦法「買了馬上原地賣掉
//     套利」。例如均價 $20、spread 5%：買單 $19.5、賣單 $20.5。
//   - 每次刷新（建議每個 tick）都先撤掉舊掛單、重新掛新單，價格
//     持續貼著市場均價走，不會被玩家硬買/硬賣操縱到脫節太久。
//   - 現金／庫存視為近乎無限（每次刷新前自動補到高水位），確保
//     流動性不會因為現金或庫存見底而停止報價。
//   - 掛單數量跟著市場成交量的 EMA 走（沿用 economy.js 既有「本
//     tick 平均成交量上限」的防操控概念），避免單一玩家一次全部
//     吃單造成價格劇烈偏移。
//
// 使用方式（Phase 7D 接上 Tournament World 時）：
//   var maker = makeMarketMakerCompany(sandbox.makeCompany);
//   sandbox.world.companies.push(maker);
//   // 每個 tick：
//   tickMarketMaker(sandbox, maker);
//
// 這支檔案目前刻意「不」加進 world-manager.js 的 MODULE_ORDER，也
// 「不」被任何 tick() 呼叫——Phase 7B 階段只確保這裡的邏輯本身是對
// 的（用 /tmp 或獨立測試腳本驗證），實際接上 Tournament World 的
// 建立流程留到 Phase 7D。
// ══════════════════════════════════════════════════════════════

var MARKET_MAKER_DEFAULTS = {
  spread:              0.05,     // 5% 價差：買賣中間留的差距，避免玩家套利
  cashFloor:           1e9,      // 現金低於這個水位就補到這裡
  warehouseFloor:      100000,   // 每個商品庫存低於這個水位就補到這裡
  orderSizeMultiplier: 5,        // 掛單量 = 市場成交量 EMA × 這個倍數
  minOrderSize:        50,       // 掛單量下限（EMA 還沒累積起來時的保底量）
};

// ── 建立造市商公司物件（呼叫端把 sandbox.makeCompany 傳進來，
//    這樣這支模組完全不需要知道 makeCompany 的實作細節）───────
function makeMarketMakerCompany(makeCompanyFn, name){
  var company = makeCompanyFn(name || "造市商", false, MARKET_MAKER_DEFAULTS.cashFloor, null);
  company.isMarketMaker = true; // 標記：跟一般 NPC / 玩家公司區分，UI 或統計要排除時可以用這個判斷
  return company;
}

// ── 補滿現金／庫存到高水位，確保流動性不會枯竭 ─────────────────
function replenish(company, market, cfg){
  if(company.cash < cfg.cashFloor) company.cash = cfg.cashFloor;
  Object.keys(market).forEach(function(pid){
    if((company.warehouse[pid] || 0) < cfg.warehouseFloor){
      company.warehouse[pid] = cfg.warehouseFloor;
    }
  });
}

// ── 撤掉這家造市商目前所有還沒成交的掛單（買+賣，所有商品）───────
// 刻意透過 sandbox.cancelOrder()（economy.js 既有、已經過測試的函式）
// 執行，而不是直接把訂單從 orderBook 陣列裡 splice 掉——直接 splice
// 不會退還被鎖住的現金／庫存，會讓造市商的資產跑掉。
function cancelAllOrders(sandbox, companyId){
  var market = sandbox.world.market;
  Object.keys(market).forEach(function(pid){
    ["buy", "sell"].forEach(function(side){
      var book = market[pid].orderBook[side];
      // 先複製一份要取消的 id 清單，避免邊遍歷陣列邊修改它
      var ids = book
        .filter(function(o){ return o.companyId === companyId; })
        .map(function(o){ return o.id; });
      ids.forEach(function(orderId){ sandbox.cancelOrder(companyId, orderId); });
    });
  });
}

// ── 計算這次要掛的量：市場成交量 EMA × 倍數，設下限 ─────────────
function calcOrderSize(marketEntry, cfg){
  var avgEMA = ((marketEntry.buyEMA || 0) + (marketEntry.sellEMA || 0)) / 2;
  var size = avgEMA > 0 ? avgEMA * cfg.orderSizeMultiplier : cfg.minOrderSize;
  return Math.max(cfg.minOrderSize, Math.round(size));
}

// ── 主函式：每個 tick 呼叫一次，刷新造市商在所有商品市場的掛單 ──
// sandbox：vm sandbox（需要用到裡面既有的 createOrder/cancelOrder）
// company：造市商自己的公司物件（由 makeMarketMakerCompany 建立）
// opts：選填，覆蓋 MARKET_MAKER_DEFAULTS 的任何欄位
function tickMarketMaker(sandbox, company, opts){
  var cfg = Object.create(MARKET_MAKER_DEFAULTS);
  if(opts) for(var k in opts) cfg[k] = opts[k];

  var world = sandbox.world;

  // 1. 先撤掉舊掛單（會退還鎖住的現金／庫存）
  cancelAllOrders(sandbox, company.id);
  // 2. 再補滿現金／庫存到高水位
  replenish(company, world.market, cfg);

  // 3. 對每個商品重新掛買單＋賣單
  Object.keys(world.market).forEach(function(pid){
    var m = world.market[pid];
    var mid = m.price;
    if(!mid || mid <= 0) return; // 沒有有效均價就跳過，避免掛出 $0 的怪單

    var buyPrice  = Math.round((mid * (1 - cfg.spread / 2)) * 100) / 100;
    var sellPrice = Math.round((mid * (1 + cfg.spread / 2)) * 100) / 100;
    var size = calcOrderSize(m, cfg);

    sandbox.createOrder(company.id, pid, "buy",  size, buyPrice);
    sandbox.createOrder(company.id, pid, "sell", size, sellPrice);
  });
}

// 這支模組跟其他 modules/*.js 一樣，不用 module.exports——它是設計
// 來被組合進某個 vm sandbox 的組合原始碼裡（跟 world-manager.js 的
// loadCombinedSource() 用同一套機制），所有 function 宣告會直接變成
// sandbox 全域可呼叫的函式。

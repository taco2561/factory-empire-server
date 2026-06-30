function initWarehouse(){
  var w={}; Object.keys(PRODUCTS).forEach(function(k){ w[k]=0; }); return w;
}
function initWarehouseCost(){
  var w={}; Object.keys(PRODUCTS).forEach(function(k){ w[k]=0; }); return w;
}
function initMarket(){
  var m={};
  Object.values(PRODUCTS).forEach(function(p){
    m[p.id]={
      productId:p.id,
      price: p.basePrice*(0.9+Math.random()*0.2),
      // ── V2 供需 EMA ──────────────────────────────────────
      buyEMA:  0,    // 買入指數移動平均（α=0.1）
      sellEMA: 0,    // 賣出指數移動平均（α=0.1）
      thisTickBuy:  0, // 本 tick 累計買量（每tick清零）
      thisTickSell: 0, // 本 tick 累計賣量（每tick清零）
      marketStock:  0, // 市場流通庫存（每5tick更新）
      // ── 相容舊欄位（部分 UI 仍用到） ───────────────────
      demand: 40, supply: 40,
      trades: 0,
      priceHistory: [],
      orderBook:{buy:[],sell:[]}
    };
  }); return m;
}

function makeCompany(name, isPlayer, cash, npcType){
  return { id:uid(), name:name, isPlayer:!!isPlayer, cash:cash, warehouse:initWarehouse(), warehouseCost:initWarehouseCost(), buildings:[],
    finance:{ revenue:0, expenses:0, netProfitToday:0, wagesPaid:0, periodRevenue:0, periodExpense:0, periodProfit:0 },
    decisionLog:[], workers:0, npcType: npcType||null,
    activityLog: {}
  };
}

var EMPLOYEE_WALLET = 0;
var EMPLOYEE_SUBSIDY = 0;

function assignNpcTypes(count){
  // V7：所有公司不預設類型，由市場數據動態決定投入行業
  var result=[];
  for(var i=0;i<count;i++) result.push(null);
  return result;
}

function makeWorld(){
  var player = makeCompany("你的公司", true, 10000, null);
  var npcCount = 80;
  var npcTypes = assignNpcTypes(npcCount);
  var npcs = NPC_NAMES.slice(0, npcCount).map(function(n,i){ return makeCompany(n, false, 10000, npcTypes[i]); });
  var world = {
    companies: [player].concat(npcs),
    market: initMarket(),
    venues: [],
    currentNews: [],
    notifications: [],
    lastUpdateTime: Date.now(),
    lastNewsRealTime: Date.now(),
    bank: {
      totalInjected:0, injections:[],
      lastGdp:0,
      // ── 銀行自有帳本 ──
      wallet:         0,
      totalDeposits:  0,
      totalLoansOut:  0,
      totalInterestEarned: 0,
      totalInterestPaid:   0,
    },
    economyState: {
      moneySupply:0, gdp:0, lastGdp:0, gdpGrowth:0,
      prosperityIndex:0, prosperityLabel:"🟡 平穩（EI 50）",
      prosperityTier:0,
      economicIndex:50, eiTodayRaw:50,
      eiComponents:{ demand:50, business:50, finance:50, vol:50, price:50, profit:50, bankrupt:100, stock:50 },
      eiDiagnosis:{ demand:{score:50,diags:[]}, business:{score:50,diags:[],lossRate:0}, finance:{score:50,diags:[]} },
      totalMarketVolume:0, totalMarketCount:0, totalVenueSales:0,
      totalWorkers:0, employeeWallet:0, totalMarketVolume:0,
    },
    tick: 0,
    dayTick: 0,
    day: 1,
    consumerPrefs: {},
    consumerState: { lastFoodDay: 0, walletHigh: 0, walletMid: 0, walletLow: 0 },
    // ── 全市場庫存快取（即時更新，供 AI / UI / 新聞使用）──
    marketInventory: {},
    // ── 股票交易系統 ──────────────────────────────────────────
    stock: {
      companies:{}, shares:{}, orderBook:{},
      ipoQueue:[], dailyStats:{totalVolume:0,totalValue:0},
    },
    government: {
      treasury:       0,
      totalCollected: 0,
      totalSpent:     0,
      orders:         [],
      orderHistory:   [],
      dailyStats:     { collected:0, spent:0, ordersIssued:0 },
    },
    monitor: {
      lastReportDay: 0,
      reports: [],
    },
    speed: 1,
    // ── v0.3：接待中心狀態 ──
    reception: makeDefaultReceptionState(),
  };

  Object.keys(PRODUCTS).forEach(function(pid){ world.consumerPrefs[pid]=0; });

  npcs.forEach(function(npc){
    seedNpcByType(npc);
    assignBuildingDisplayNames(npc);
  });

  world.economyState.moneySupply = world.companies.reduce(function(s,c){ return s+c.cash; },0);
  return world;
}

function seedNpcByType(npc){
  // V2.0：所有 NPC 類型都從空白起步，由生存策略自動建造蓄水池→農場→超市
  // 僅給予初始現金，不預設任何建築，確保決策系統正確執行
  // （原有預設建築邏輯已移除）
}

// ══════════════════════════════════════════════════════════════
// [Phase 1 Server] localStorage 不存在於 Node.js 環境。
// 規格要求「不修改 localStorage 邏輯」，因此這裡提供一個最小的
// 同名介面（getItem/setItem）讓 loadWorld()/saveWorld() 程式碼本身
// 完全不需要更動，只是底層儲存從瀏覽器改為伺服器記憶體（不落地存檔）。
// 這代表 Phase 1 的伺服器世界狀態只存在於程式執行期間，重啟 server 即重置。
// ══════════════════════════════════════════════════════════════
var localStorage = (function(){
  var store = {};
  return {
    getItem: function(key){ return Object.prototype.hasOwnProperty.call(store,key) ? store[key] : null; },
    setItem: function(key, value){ store[key]=String(value); },
    removeItem: function(key){ delete store[key]; },
  };
})();

var world = loadWorld();
function loadWorld(){
  try{
    var s=localStorage.getItem("pe3_world_v3");
    if(s){
      var w=JSON.parse(s);
      w.companies.forEach(function(c){
        assignBuildingDisplayNames(c);
        if(!c.activityLog) c.activityLog={};
        // 相容：補齊新商品倉庫欄位
        Object.keys(PRODUCTS).forEach(function(pid){
          if(c.warehouse[pid]===undefined) c.warehouse[pid]=0;
        });
        // 相容：補齊倉庫成本欄位
        if(!c.warehouseCost) c.warehouseCost=initWarehouseCost();
        Object.keys(PRODUCTS).forEach(function(pid){
          if(c.warehouseCost[pid]===undefined) c.warehouseCost[pid]=0;
        });
        // 相容：補齊銀行帳戶（bankAccount 由 ensureBankAccount 懶初始化，無需預建）
        // 相容：補齊期間財務欄位（股利系統 V2）
        if(c.finance){
          if(c.finance.periodRevenue===undefined) c.finance.periodRevenue=0;
          if(c.finance.periodExpense===undefined) c.finance.periodExpense=0;
          if(c.finance.periodProfit===undefined)  c.finance.periodProfit=0;
        }
      });
      if(!w.monitor) w.monitor={ lastReportDay:0, reports:[] };
      if(!w.lastNewsRealTime) w.lastNewsRealTime = Date.now();
      if(!w.speed) w.speed=1;
      // 相容：補齊新商品市場欄位 + V2 供需欄位
      Object.values(PRODUCTS).forEach(function(p){
        if(!w.market[p.id]){
          w.market[p.id]={ productId:p.id, price:p.basePrice*(0.9+Math.random()*0.2),
            buyEMA:0, sellEMA:0, thisTickBuy:0, thisTickSell:0, marketStock:0,
            demand:40, supply:40, trades:0, priceHistory:[], orderBook:{buy:[],sell:[]} };
        }
        // 補齊舊存檔缺少的 V2 欄位
        var m=w.market[p.id];
        if(m.buyEMA===undefined)       m.buyEMA=0;
        if(m.sellEMA===undefined)      m.sellEMA=0;
        if(m.thisTickBuy===undefined)  m.thisTickBuy=0;
        if(m.thisTickSell===undefined) m.thisTickSell=0;
        if(m.marketStock===undefined)  m.marketStock=0;
      });
      // 相容：補齊 consumerPrefs 新商品
      Object.keys(PRODUCTS).forEach(function(pid){
        if(w.consumerPrefs[pid]===undefined) w.consumerPrefs[pid]=0;
      });
      // 相容：補齊接待中心狀態
      if(!w.reception) w.reception = makeDefaultReceptionState();
      // 相容：補齊銀行新欄位
      if(w.bank.wallet          === undefined) w.bank.wallet          = 0;
      if(w.bank.totalDeposits   === undefined) w.bank.totalDeposits   = 0;
      if(w.bank.totalLoansOut   === undefined) w.bank.totalLoansOut   = 0;
      if(w.bank.totalInterestEarned === undefined) w.bank.totalInterestEarned = 0;
      if(w.bank.totalInterestPaid   === undefined) w.bank.totalInterestPaid   = 0;
      if(!w.bank.subsidyLog)            w.bank.subsidyLog=[];  // 政府補助日誌（移至 government）
      // 相容：補齊消費習慣狀態
      if(!w.consumerState) w.consumerState = { lastFoodDay: 0, walletHigh: 0, walletMid: 0, walletLow: 0 };
      if(w.consumerState.walletHigh===undefined) w.consumerState.walletHigh=0;
      if(w.consumerState.walletMid ===undefined) w.consumerState.walletMid =0;
      if(w.consumerState.walletLow ===undefined) w.consumerState.walletLow =0;
      // 相容：補齊市場庫存快取
      if(!w.marketInventory) w.marketInventory={};
      // 相容：補齊股票系統
      if(!w.stock) w.stock={ companies:{}, shares:{}, orderBook:{}, ipoQueue:[], dailyStats:{totalVolume:0,totalValue:0} };
      if(!w.government) w.government={ treasury:0, totalCollected:0, totalSpent:0, orders:[], orderHistory:[], dailyStats:{collected:0,spent:0,ordersIssued:0} };

      // ── 修復：讀檔時校準遊戲時鐘，避免重新整理後 endTime 與 gameNow() 不連續 ──
      // 問題根因：gameNow() 的時間軸從「頁面載入瞬間」重新歸零累積，
      // 但存檔內所有 productionQueue/building 的 endTime 是用「上次執行階段」的
      // gameNow() 刻度算出的絕對時間戳。重新整理頁面後兩者刻度不同步，
      // 導致 countdown = endTime - gameNow() 算出離譜的剩餘時間（例如 210秒 變 2100秒）。
      // 解法：把當下的 gameNow() 時鐘，校準到存檔當下記錄的 _savedGameNow，
      // 讓讀檔後的時間軸與存檔前完全連續，不會出現跳變。
      if(typeof w._savedGameNow==="number" && typeof setGameSpeed==="function"){
        // 計算讀檔期間經過了多少「真實時間」（玩家離線/重整這段時間）
        var offlineMs = Math.max(0, Date.now() - (w.lastUpdateTime||Date.now()));
        // 校準：讓新的 gameNow() 從「存檔時的遊戲時鐘」+ 離線期間（以1倍速計）繼續往前走
        _gameTimeBase = w._savedGameNow + offlineMs;
        _realTimeBase = Date.now();
        _gameSpeed = w.speed||1;
      }

      return w;
    }
  }catch(e){}
  return makeWorld();
}
function saveWorld(){
  try{
    world.lastUpdateTime = Date.now();
    world._savedGameNow  = gameNow(); // 記錄存檔當下的遊戲時鐘刻度，供下次讀檔銜接
    localStorage.setItem("pe3_world_v3",JSON.stringify(world));
  }catch(e){}
}
function getPlayer(){ return world.companies.find(function(c){ return c.isPlayer; }); }

function notify(msg){
  world.notifications.unshift({ time:Date.now(), message:msg });
  if(world.notifications.length>80) world.notifications.pop();
}

function assignBuildingDisplayNames(company){
  var counters={};
  company.buildings.forEach(function(b){
    counters[b.type]=(counters[b.type]||0)+1;
    b.displayName=BUILDINGS[b.type].name+" "+counters[b.type];
  });
}

// ── 倉庫成本工具函式 ─────────────────────────────────────────

// 取得平均單位成本（安全，qty=0 時回傳 0）
function getUnitCost(company, pid){
  var qty = company.warehouse[pid] || 0;
  if(qty <= 0) return 0;
  return (company.warehouseCost[pid] || 0) / qty;
}

// 商品進倉：更新加權平均總成本
function warehouseIn(company, pid, qty, unitCost){
  if(qty <= 0) return;
  company.warehouse[pid] = (company.warehouse[pid] || 0) + qty;
  company.warehouseCost[pid] = (company.warehouseCost[pid] || 0) + qty * unitCost;
}

// 商品出倉：按平均成本比例扣除總成本
function warehouseOut(company, pid, qty){
  if(qty <= 0) return;
  var have = company.warehouse[pid] || 0;
  var totalCost = company.warehouseCost[pid] || 0;
  var avgCost = have > 0 ? totalCost / have : 0;
  company.warehouse[pid] = Math.max(0, have - qty);
  company.warehouseCost[pid] = Math.max(0, totalCost - qty * avgCost);
}

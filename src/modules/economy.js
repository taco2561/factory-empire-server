// ══════════════════════════════════════════════════════════════
// 期間財務記帳輔助函式（股利系統 V2 用）
// finance.revenue/expenses：歷史累計（永不清零，僅供統計顯示）
// finance.periodRevenue/periodExpense/periodProfit：本期（8天）累計，股利結算後歸零
// ══════════════════════════════════════════════════════════════
function ensureFinancePeriod(company){
  if(!company.finance) company.finance={revenue:0,expenses:0,wagesPaid:0};
  var f=company.finance;
  if(f.periodRevenue===undefined) f.periodRevenue=0;
  if(f.periodExpense===undefined) f.periodExpense=0;
  if(f.periodProfit===undefined)  f.periodProfit=0;
  return f;
}
function recordRevenue(company, amount){
  if(!company||!amount) return;
  var f=ensureFinancePeriod(company);
  f.revenue=(f.revenue||0)+amount;
  f.periodRevenue+=amount;
}
function recordExpense(company, amount){
  if(!company||!amount) return;
  var f=ensureFinancePeriod(company);
  f.expenses=(f.expenses||0)+amount;
  f.periodExpense+=amount;
}

// 取得某「建築實例」實際可生產的商品清單
// 一般建築：回傳 BUILDINGS[type].products（固定清單）
// 礦洞：回傳該礦洞建造時隨機抽取的 3 種礦物（building.mineOres）
function getBuildingProducts(building){
  var bDef=BUILDINGS[building.type];
  if(!bDef) return [];
  if(bDef.isMine) return building.mineOres||[];
  return bDef.products||[];
}

function startBuilding(companyId, buildingType){
  var company=world.companies.find(function(c){ return c.id===companyId; });
  var b=BUILDINGS[buildingType];
  if(!b||company.cash<b.cost) return null;
  company.cash-=b.cost;
  recordExpense(company, b.cost);
  // 建築費用流入政府財政
  if(typeof govCollectBuildingFee==="function") govCollectBuildingFee(b.cost);
  var building={ id:uid(), type:buildingType, workers:b.workers, isCompleted:false, endTime:gameEndTime(b.buildTime), productionQueue:[], purchaseCost:b.cost };
  // 礦洞：建造時隨機抽取 3 種礦物作為此礦洞固定產出（每座礦洞獨立隨機，不同礦洞組合不同）
  if(b.isMine){
    var pool=MINE_POSSIBLE_ORES.slice();
    var picked=[];
    for(var i=0;i<3&&pool.length>0;i++){
      var idx=Math.floor(Math.random()*pool.length);
      picked.push(pool.splice(idx,1)[0]);
    }
    building.mineOres=picked; // 此礦洞實際可開採的 3 種礦物（固定，不會再變）
  }
  company.buildings.push(building);
  assignBuildingDisplayNames(company);
  return building;
}

function calcProductionWage(building, qty){
  return BUILDINGS[building.type].workers * 1.5 * qty;
}

// ══════════════════════════════════════════════════════════════
// 循環生產（Auto Repeat Production）
// ══════════════════════════════════════════════════════════════
var AUTO_PRODUCTION_COST_MULTIPLIER = 1.10; // 循環生產管理費倍率（可調整）
var AUTO_PRODUCTION_OPTIONS = [3, 5, 8];    // 可選循環次數（未來可擴充無限循環）

// 核心：執行單輪生產（一般生產與循環生產的共用邏輯）
// repeatInfo: null（一般生產）或 {repeatTotal, repeatLeft, isAutoRepeat}
function _enqueueProductionCore(companyId, buildingId, productId, qty, repeatInfo){
  var company=world.companies.find(function(c){ return c.id===companyId; });
  if(!company) return {ok:false,msg:"公司不存在"};
  var building=company.buildings.find(function(b){ return b.id===buildingId; });
  if(!building||!building.isCompleted) return {ok:false,msg:"建築未完工"};
  var bDef=BUILDINGS[building.type];
  if(!getBuildingProducts(building).includes(productId)) return {ok:false,msg:"此建築無法生產該商品"};
  var product=PRODUCTS[productId];

  // 原料檢查
  for(var inp in product.inputs){
    if((company.warehouse[inp]||0)<product.inputs[inp]*qty) return {ok:false,msg:"原料不足："+PRODUCTS[inp].name};
  }

  var wage=calcProductionWage(building, qty);
  var wageMulti=typeof govPolicyEffect==="function"?govPolicyEffect("wageReduction"):1.0;
  var actualWage=Math.floor(wage*wageMulti);
  var govSubsidy=wage-actualWage;

  // 循環生產管理費（只在啟動循環時，每輪都收取）
  var manageFee=0;
  if(repeatInfo&&repeatInfo.isAutoRepeat){
    manageFee=Math.floor(actualWage*(AUTO_PRODUCTION_COST_MULTIPLIER-1));
  }
  var totalWageCost=actualWage+manageFee;

  if(company.cash<totalWageCost) return {ok:false,msg:"現金不足以支付員工薪資"+(manageFee>0?"＋管理費":"")+"（需 "+money(totalWageCost)+"）"};

  // 原材料成本
  var materialCost=0;
  for(var inp in product.inputs){
    var inputQty=product.inputs[inp]*qty;
    materialCost+=getUnitCost(company,inp)*inputQty;
    warehouseOut(company,inp,inputQty);
  }

  company.cash-=totalWageCost;
  company.finance.wagesPaid=(company.finance.wagesPaid||0)+actualWage;
  recordExpense(company, totalWageCost);
  recordExpense(company, materialCost); // 原料成本也計入本期支出
  EMPLOYEE_WALLET+=wage; // 員工收到完整薪資（補貼/管理費不影響員工所得）

  if(govSubsidy>0 && typeof ensureGovernment==="function"){
    var govG=ensureGovernment();
    govG.treasury=Math.max(0,govG.treasury-govSubsidy);
    govG.totalSpent+=govSubsidy;
  }

  var jobTotalCost=materialCost+totalWageCost;
  var speedMulti=typeof govPolicyEffect==="function"?govPolicyEffect("produceSpeed"):1.0;
  var duration=Math.floor((20+qty*4)*1000*speedMulti);
  var lastEnd=building.productionQueue.length>0
    ? building.productionQueue[building.productionQueue.length-1].endTime
    : gameNow();

  var job={ product:productId, amount:qty, endTime:lastEnd+duration, totalCost:jobTotalCost };
  // 循環資訊（不影響既有 job 結構的消費端，多出來的欄位不影響原邏輯）
  if(repeatInfo){
    job.isAutoRepeat = repeatInfo.isAutoRepeat;
    job.repeatTotal  = repeatInfo.repeatTotal;
    job.repeatLeft   = repeatInfo.repeatLeft;
    job.repeatBuildingId = buildingId; // 供下一輪續轉時找回建築
    job.repeatStopped = false;          // 玩家按下「停止循環」時設為 true
  }

  building.productionQueue.push(job);
  var msg=manageFee>0
    ? "已加入生產 Queue（薪資 "+money(actualWage)+"＋管理費 "+money(manageFee)+"）"
    : "已加入生產 Queue（薪資 "+money(actualWage)+"）";
  return {ok:true,msg:msg};
}

// 一般生產（向後相容，外部呼叫介面不變）
function enqueueProduction(companyId, buildingId, productId, qty){
  return _enqueueProductionCore(companyId, buildingId, productId, qty, null);
}

// 啟動循環生產：建立第一輪，repeatLeft = repeatTotal
function enqueueAutoRepeatProduction(companyId, buildingId, productId, qty, repeatTotal){
  if(!AUTO_PRODUCTION_OPTIONS.includes(repeatTotal)){
    return {ok:false,msg:"無效的循環次數"};
  }
  var repeatInfo={ isAutoRepeat:true, repeatTotal:repeatTotal, repeatLeft:repeatTotal };
  return _enqueueProductionCore(companyId, buildingId, productId, qty, repeatInfo);
}

// 嘗試啟動下一輪循環（由 game-loop 在上一輪完工後呼叫）
// 若原料/薪資/現金不足，回傳 false，但不刪除任何狀態（等待重試）
function tryStartNextRepeatRound(companyId, buildingId, productId, qty, repeatLeft, repeatTotal){
  var res=_enqueueProductionCore(companyId, buildingId, productId, qty, {
    isAutoRepeat:true, repeatTotal:repeatTotal, repeatLeft:repeatLeft
  });
  return res;
}

// 玩家按下「停止循環」：標記佇列中該筆 job 不再續轉
// （目前這輪仍會完成，完成後不會再開新一輪）
function stopAutoRepeat(companyId, buildingId, queuePos){
  var company=world.companies.find(function(c){ return c.id===companyId; });
  if(!company) return {ok:false,msg:"公司不存在"};
  var building=company.buildings.find(function(b){ return b.id===buildingId; });
  if(!building) return {ok:false,msg:"建築不存在"};
  var job=building.productionQueue[queuePos];
  if(!job||!job.isAutoRepeat) return {ok:false,msg:"此項目不是循環生產"};
  job.repeatStopped=true;
  return {ok:true,msg:"循環將在本輪完成後停止"};
}



function createOrder(companyId, productId, side, qty, price){
  var company=world.companies.find(function(c){ return c.id===companyId; });
  if(!company||qty<=0||price<=0) return null;
  if(side==="sell"&&(company.warehouse[productId]||0)<qty) return null;
  if(side==="buy"&&company.cash<qty*price) return null;
  if(side==="sell") warehouseOut(company,productId,qty);
  if(side==="buy")  company.cash-=qty*price;
  var order={id:uid(),companyId:companyId,productId:productId,side:side,qty:qty,remaining:qty,price:price,time:Date.now()};
  world.market[productId].orderBook[side].push(order);
  world.market[productId].orderBook[side].sort(function(a,b){ return side==="buy"?b.price-a.price:a.price-b.price; });
  matchOrders(productId);
  return order;
}
function cancelOrder(orderId){
  var player=getPlayer(); var found=false;
  Object.values(world.market).forEach(function(m){
    ["buy","sell"].forEach(function(side){
      var idx=m.orderBook[side].findIndex(function(o){ return o.id===orderId&&o.companyId===player.id; });
      if(idx===-1) return;
      var order=m.orderBook[side][idx];
      if(side==="sell"){
        // 退回商品，成本沿用取消當下的市場均價估算（保守處理）
        var retCost=world.market[order.productId]?world.market[order.productId].price:PRODUCTS[order.productId].basePrice;
        warehouseIn(player,order.productId,order.remaining,retCost);
      } else {
        player.cash+=order.remaining*order.price;
      }
      m.orderBook[side].splice(idx,1);
      notify("🚫 取消訂單："+PRODUCTS[order.productId].name+(side==="sell"?" 賣":" 買")+"單");
      found=true;
    });
  }); return found;
}
function matchOrders(productId){
  var m=world.market[productId];
  var book=m.orderBook; var changed=true;
  // 防操控：計算本 tick 平均成交量上限（buyEMA+sellEMA 的均值 × 5 倍）
  var avgEMA = ((m.buyEMA||0)+(m.sellEMA||0))/2;
  var tickCap = avgEMA > 0 ? avgEMA * 5 : 9999;
  var tickFilled = 0;

  while(changed){
    changed=false;
    if(!book.buy.length||!book.sell.length) break;
    var bb=book.buy[0],bs=book.sell[0];
    if(bb.price>=bs.price){
      var filled=Math.min(bb.remaining,bs.remaining);
      // 防操控：若本 tick 已成交量超過上限，超出部分只算 20%（降低衝擊）
      var effectiveFilled = filled;
      if(avgEMA > 0 && tickFilled + filled > tickCap){
        var overQty = (tickFilled + filled) - tickCap;
        effectiveFilled = filled - overQty * 0.8; // 超出部分只計 20%
        effectiveFilled = Math.max(1, Math.round(effectiveFilled));
      }
      var tp=(bb.price+bs.price)/2;
      var buyer=world.companies.find(function(c){ return c.id===bb.companyId; });
      var seller=world.companies.find(function(c){ return c.id===bs.companyId; });
      if(buyer){ warehouseIn(buyer,productId,filled,tp); trackActivity(buyer,productId,"buy",filled); }
      if(seller){ seller.cash+=filled*tp; recordRevenue(seller, filled*tp); trackActivity(seller,productId,"sell",filled); }
      if(buyer) buyer.cash+=(bb.price-tp)*filled;
      bb.remaining-=filled; bs.remaining-=filled;
      m.price=tp;
      m.trades=(m.trades||0)+filled;
      world.economyState.totalMarketVolume+=filled*tp;
      world.economyState.totalMarketCount=(world.economyState.totalMarketCount||0)+filled; // 成交件數
      world.economyState.totalVenueSales=(world.economyState.totalVenueSales||0); // 門市銷售額（由 tickConsumers 累計）
      // 累計本 tick 成交量（用於 EMA 更新）
      m.thisTickBuy  = (m.thisTickBuy||0)  + effectiveFilled;
      m.thisTickSell = (m.thisTickSell||0) + effectiveFilled;
      tickFilled += filled;
      if(bb.remaining<=0) book.buy.shift();
      if(bs.remaining<=0) book.sell.shift();
      changed=true;
    }
  }
}

function trackActivity(company, productId, action, qty){
  if(!company.activityLog) company.activityLog={};
  var key = productId+"_"+action;
  company.activityLog[key] = (company.activityLog[key]||0)+qty;
}

var CONSUMER_PRODUCTS_SM = Object.values(PRODUCTS).filter(function(p){ return p.consumer&&p.venue==="supermarket"; });
var CONSUMER_PRODUCTS_RT = Object.values(PRODUCTS).filter(function(p){ return p.consumer&&p.venue==="restaurant"; });
var CONSUMER_PRODUCTS_CL = Object.values(PRODUCTS).filter(function(p){ return p.consumer&&p.venue==="clothing"; });
var CONSUMER_PRODUCTS_EL = Object.values(PRODUCTS).filter(function(p){ return p.consumer&&p.venue==="electronics"; });

function isVenueBuilding(bDef){
  return bDef.isSupermarket||bDef.isRestaurant||bDef.isClothingStore||bDef.isElectronicsStore;
}

function ensureVenues(){
  world.companies.forEach(function(company){
    company.buildings.forEach(function(b){
      if(!b.isCompleted) return;
      var bDef=BUILDINGS[b.type];
      if(!isVenueBuilding(bDef)) return;
      if(world.venues.find(function(v){ return v.buildingId===b.id; })) return;
      var venueProducts=bDef.venueProducts||[];
      var shelves={};
      venueProducts.forEach(function(pid){
        shelves[pid]={ price:PRODUCTS[pid].basePrice*1.4, stock:0, listed:false };
      });
      world.venues.push({ id:uid(), type:bDef.venueType, companyId:company.id, buildingId:b.id, shelves:shelves, revenue:0, salesLog:[] });
    });
  });
}

function shelfRestock(venueId, productId, qty, price){
  var v=world.venues.find(function(s){ return s.id===venueId; });
  var company=world.companies.find(function(c){ return c.id===v.companyId; });
  if(!v||!company) return {ok:false,msg:"場地不存在"};
  if((company.warehouse[productId]||0)<qty) return {ok:false,msg:"倉庫庫存不足"};
  var vBuilding=company.buildings.find(function(b){ return b.id===v.buildingId; });
  var wagePerUnit=vBuilding?BUILDINGS[vBuilding.type].workers*1.5:0;
  var wage=wagePerUnit*qty;
  if(company.cash<wage) return {ok:false,msg:"現金不足以支付上架薪資（需 "+money(wage)+"）"};
  warehouseOut(company,productId,qty);
  v.shelves[productId].stock+=qty;
  v.shelves[productId].price=price;
  v.shelves[productId].listed=true;
  if(wage>0){
    company.cash-=wage;
    company.finance.wagesPaid=(company.finance.wagesPaid||0)+wage;
    company.finance.expenses=(company.finance.expenses||0)+wage;
    EMPLOYEE_WALLET+=wage;
  }
  return {ok:true,msg:"補貨成功（薪資 "+money(wage)+"）"};
}
function shelfWithdraw(venueId, productId){
  var v=world.venues.find(function(s){ return s.id===venueId; });
  var company=world.companies.find(function(c){ return c.id===v.companyId; });
  if(!v||!company) return false;
  var stock=v.shelves[productId].stock;
  if(stock>0){
    var retCost=world.market[productId]?world.market[productId].price:PRODUCTS[productId].basePrice;
    warehouseIn(company,productId,stock,retCost);
  }
  v.shelves[productId].stock=0; v.shelves[productId].listed=false;
  return true;
}

// ── 三層收入錢包比例 ─────────────────────────────────────────
// 高收入：前 8% 人數，薪資權重約 3×  → 佔總錢包 ~30%
// 中收入：中 72% 人數，薪資權重 1×   → 佔總錢包 ~55%
// 低收入：後 20% 人數，薪資權重 0.5× → 佔總錢包 ~15%
var WALLET_RATIO_HIGH = 0.30;
var WALLET_RATIO_MID  = 0.55;
var WALLET_RATIO_LOW  = 0.15;

function tickConsumers(){
  var totalWorkers=world.economyState.totalWorkers;
  if(totalWorkers===0||world.venues.length===0) return;
  world.companies.forEach(function(company){
    company.workers=company.buildings.filter(function(b){ return b.isCompleted; }).reduce(function(s,b){ return s+BUILDINGS[b.type].workers; },0);
  });
  if(EMPLOYEE_WALLET<=0) return;

  // ── 食物優先：每兩天至少吃一次 ──────────────────────────
  if(!world.consumerState) world.consumerState={ lastFoodDay:0 };
  var daysSinceFood = world.day - world.consumerState.lastFoodDay;
  var foodSatisfied = daysSinceFood < 2;

  // ── 三層錢包（從全局錢包按比例切出，消費後回寫） ────────
  var walletHigh = EMPLOYEE_WALLET * WALLET_RATIO_HIGH;
  var walletMid  = EMPLOYEE_WALLET * WALLET_RATIO_MID;
  var walletLow  = EMPLOYEE_WALLET * WALLET_RATIO_LOW;

  // ── 核心購買函式 ─────────────────────────────────────────
  // productList: 商品陣列（已依優先順序排好）
  // wallet:      該層可用錢包金額（傳參考物件 {v} 方便回寫）
  // workerRatio: 該層人數比例（決定 demand 份額）
  // priceFilter: function(price, productId) → bool，篩選可接受售價
  function doConsumeGroup(productList, walletObj, workerRatio, priceFilter){
    productList.forEach(function(p){
      var demandBoost=typeof govPolicyEffect==="function"?govPolicyEffect("demandBoost"):1.0;
      var demand = Math.ceil(p.demandPerWorker * totalWorkers * workerRatio * demandBoost);
      // 依商品優先順序：先嘗試第一個找到的符合條件的場館
      var sellers = world.venues
        .filter(function(v){
          return v.shelves[p.id] && v.shelves[p.id].listed && v.shelves[p.id].stock > 0 &&
                 (!priceFilter || priceFilter(v.shelves[p.id].price, p.id));
        })
        .sort(function(a,b){ return a.shelves[p.id].price - b.shelves[p.id].price; });
      sellers.forEach(function(v){
        if(demand<=0 || walletObj.v<=0) return;
        var shelf   = v.shelves[p.id];
        var canBuy  = Math.min(demand, Math.floor(shelf.stock), Math.floor(walletObj.v / shelf.price));
        if(canBuy<=0) return;
        var revenue = canBuy * shelf.price;
        shelf.stock -= canBuy; demand -= canBuy; walletObj.v -= revenue;
        world.economyState.totalVenueSales=(world.economyState.totalVenueSales||0)+revenue;
        var owner = world.companies.find(function(c){ return c.id===v.companyId; });
        if(owner){ owner.cash+=revenue; recordRevenue(owner, revenue); trackActivity(owner,p.id,"sell",canBuy); }
        v.revenue += revenue;
        v.salesLog.unshift({ time:Date.now(), product:p.id, qty:canBuy, price:shelf.price, total:revenue });
        if(v.salesLog.length>40) v.salesLog.pop();
        world.consumerPrefs[p.id]=(world.consumerPrefs[p.id]||0)+canBuy;
        if(owner&&owner.isPlayer){
          var venueLabel=v.type==="supermarket"?"超市":v.type==="restaurant"?"餐廳":"服飾店";
          notify("🛍️ "+venueLabel+" 售出 "+canBuy+" 件 "+p.name+"，收入 "+money(revenue));
        }
      });
    });
  }

  var wH = { v: walletHigh };
  var wM = { v: walletMid  };
  var wL = { v: walletLow  };

  var foodBefore = wH.v + wM.v + wL.v;

  // ════════════════════════════════════════════════════════════
  // 高收入（前 8%）：肉類優先 → 超市次之 → 服飾全類型
  // ════════════════════════════════════════════════════════════
  // 食物：餐廳（按價格由低至高：雞排→豬排→牛排）→ 超市
  var highFoodList = CONSUMER_PRODUCTS_RT.slice().sort(function(a,b){ return a.basePrice-b.basePrice; })
    .concat(CONSUMER_PRODUCTS_SM);
  doConsumeGroup(highFoodList, wH, 0.08, null);

  // ════════════════════════════════════════════════════════════
  // 中收入（中 72%）：超市優先（划算）→ 餐廳次之 → 中價服飾
  // ════════════════════════════════════════════════════════════
  // 食物：超市先，再餐廳（只買最便宜的）
  var midFoodList = CONSUMER_PRODUCTS_SM.slice()
    .concat(CONSUMER_PRODUCTS_RT.slice().sort(function(a,b){ return a.basePrice-b.basePrice; }).slice(0,1));
  doConsumeGroup(midFoodList, wM, 0.72, null);

  // ════════════════════════════════════════════════════════════
  // 低收入（後 20%）：超市最便宜商品 → 無餐廳
  // ════════════════════════════════════════════════════════════
  // 食物：超市（只選當下市場價最低的）
  var lowFoodList = CONSUMER_PRODUCTS_SM.slice().sort(function(a,b){
    var pa = world.market[a.id] ? world.market[a.id].price : a.basePrice;
    var pb = world.market[b.id] ? world.market[b.id].price : b.basePrice;
    return pa - pb;
  }).slice(0,1); // 只買最便宜那一種
  doConsumeGroup(lowFoodList, wL, 0.20, null);

  // 食物消費狀態更新
  var foodAfter = wH.v + wM.v + wL.v;
  if(foodAfter < foodBefore){
    world.consumerState.lastFoodDay = world.day;
    foodSatisfied = true;
  }

  // ════════════════════════════════════════════════════════════
  // 服飾消費（僅在食物需求已滿足時開放）
  // ════════════════════════════════════════════════════════════
  if(foodSatisfied){
    // 高收入：買所有類型服飾（價格不限）
    doConsumeGroup(CONSUMER_PRODUCTS_CL, wH, 0.08, null);

    // 中收入：只買 shirt / pants（不買 shoes / leather）
    var midClothList = CONSUMER_PRODUCTS_CL.filter(function(p){ return p.id==="shirt"||p.id==="pants"; });
    doConsumeGroup(midClothList, wM, 0.72, null);

    // 低收入：只買 leather（最低價服飾）
    var lowClothList = CONSUMER_PRODUCTS_CL.filter(function(p){ return p.id==="leather"; });
    doConsumeGroup(lowClothList, wL, 0.20, null);
  }

  // ── 回寫全局錢包 ─────────────────────────────────────────
  EMPLOYEE_WALLET = wH.v + wM.v + wL.v;
  world.economyState.employeeWallet = EMPLOYEE_WALLET;

  // ── 更新分層錢包狀態（供 UI 顯示） ──────────────────────
  world.consumerState.walletHigh = wH.v;
  world.consumerState.walletMid  = wM.v;
  world.consumerState.walletLow  = wL.v;
}

// ══════════════════════════════════════════════════════════════
// 景氣指數（Economic Index）系統 V2.0
// 三大指數加權：需求指數 40% + 企業健康度 35% + 金融健康度 25%
// 加入慣性（昨日 EI×0.8 + 今日計算×0.2）
// ══════════════════════════════════════════════════════════════

// ── 可調整的權重設定區 ─────────────────────────────────────
var EI_CONFIG = {
  DEMAND_WEIGHT:   0.40,
  BUSINESS_WEIGHT: 0.35,
  FINANCE_WEIGHT:  0.25,
  INERTIA_YESTERDAY: 0.80,
  INERTIA_TODAY:     0.20,
  DEMAND_VOL_BASELINE:   8000,
  DEMAND_COUNT_BASELINE: 200,
  DEMAND_VENUE_BASELINE: 3000,
  BIZ_LOSS_RATE_MAX:    0.50,
  BIZ_LOSS_RATE_CRISIS: 0.70,
  BIZ_CRISIS_CAP:       20,
  FIN_DEFAULT_RATE_MAX: 0.15,
  FIN_BANKRUPT_RATE_MAX:0.10,
};
function eiClamp(v,lo,hi){ return Math.max(lo,Math.min(hi,v)); }

// ── 一、需求指數 ───────────────────────────────────────────
function calcDemandScore(econ){
  var cfg=EI_CONFIG;
  var vol    = econ.totalMarketVolume||0;
  var volS   = eiClamp(vol/cfg.DEMAND_VOL_BASELINE*100,0,100);
  var count  = econ.totalMarketCount||0;
  var countS = eiClamp(count/cfg.DEMAND_COUNT_BASELINE*100,0,100);
  var venue  = econ.totalVenueSales||0;
  var venueS = eiClamp(venue/cfg.DEMAND_VENUE_BASELINE*100,0,100);
  // 商品售出率（market.trades 當日已售 / 理想庫存*0.1）
  var soldRatio=0,soldCount=0;
  Object.values(world.market).forEach(function(m){
    var p=PRODUCTS[m.productId]; if(!p||!p.consumer) return;
    var ideal=getIdealStock(m.productId);
    soldRatio+=eiClamp((m.trades||0)/Math.max(ideal*0.1,1)*100,0,100);
    soldCount++;
  });
  var soldS=soldCount>0?soldRatio/soldCount:50;
  var demand=Math.round(volS*0.35+countS*0.25+venueS*0.25+soldS*0.15);
  var diags=[];
  if(volS<40)   diags.push({key:"mktVol",  label:"市場成交金額不足",detail:"成交額 "+money(vol)+"，正常值 "+money(cfg.DEMAND_VOL_BASELINE),penalty:Math.round(40-volS)});
  if(countS<40) diags.push({key:"mktCount",label:"成交件數過低",   detail:"成交 "+count+" 件，正常 "+cfg.DEMAND_COUNT_BASELINE+" 件",   penalty:Math.round(40-countS)});
  if(venueS<40) diags.push({key:"venue",   label:"門市消費疲弱",   detail:"門市銷售 "+money(venue)+"，正常值 "+money(cfg.DEMAND_VENUE_BASELINE),penalty:Math.round(40-venueS)});
  if(soldS<40)  diags.push({key:"sold",    label:"商品大量滯銷",   detail:"商品售出率僅 "+Math.round(soldS)+"%",                        penalty:Math.round(40-soldS)});
  diags.sort(function(a,b){return b.penalty-a.penalty;});
  return {score:eiClamp(demand,0,100),sub:{vol:Math.round(volS),count:Math.round(countS),venue:Math.round(venueS),sold:Math.round(soldS)},diags:diags.slice(0,3)};
}

// ── 二、企業健康度 ─────────────────────────────────────────
function calcBusinessScore(){
  var cfg=EI_CONFIG;
  var npcs=world.companies.filter(function(c){return !c.bankrupt;});
  var total=npcs.length||1;
  var profitCount=0,lossCount=0;
  npcs.forEach(function(c){
    var rev=(c.finance&&c.finance.revenue)||0,exp=(c.finance&&c.finance.expenses)||0;
    if(rev>exp) profitCount++; else lossCount++;
  });
  var lossRate=lossCount/total;
  var profitS=eiClamp((profitCount/total)*100,0,100);
  // 平均現金可維持天數
  var cashDaysTotal=0;
  npcs.forEach(function(c){
    var dw=c.buildings.filter(function(b){return b.isCompleted;}).reduce(function(s,b){return s+(BUILDINGS[b.type]||{workers:0}).workers*1.5;},0)||1;
    cashDaysTotal+=Math.min(30,c.cash/dw);
  });
  var avgCashDays=cashDaysTotal/total;
  var cashS=eiClamp(avgCashDays/30*100,0,100);
  // 平均負債率
  var debtTotal=0;
  npcs.forEach(function(c){
    var debt=(c.bankAccount&&c.bankAccount.loans.reduce(function(s,l){return s+l.remaining;},0))||0;
    var assets=(companyBookValue?companyBookValue(c):c.cash)||100;
    debtTotal+=debt/Math.max(assets,1);
  });
  var debtS=eiClamp((1-debtTotal/total)*100,0,100);
  // 平均產能利用率
  var utilTotal=0;
  npcs.forEach(function(c){
    var cp=c.buildings.filter(function(b){
      if(!b.isCompleted) return false;
      var bd=BUILDINGS[b.type];
      return bd&&!bd.isSupermarket&&!bd.isRestaurant&&!bd.isClothingStore&&!bd.isElectronicsStore&&!bd.isReceptionCenter;
    });
    utilTotal+=cp.length>0?cp.filter(function(b){return b.productionQueue.length>0;}).length/cp.length:0.5;
  });
  var utilS=eiClamp(utilTotal/total*100,0,100);
  var biz=Math.round(profitS*0.40+cashS*0.25+debtS*0.20+utilS*0.15);
  // 危機修正
  if(lossRate>=cfg.BIZ_LOSS_RATE_CRISIS) biz=Math.min(biz,cfg.BIZ_CRISIS_CAP);
  else if(lossRate>=cfg.BIZ_LOSS_RATE_MAX){
    var pen=(lossRate-cfg.BIZ_LOSS_RATE_MAX)/(cfg.BIZ_LOSS_RATE_CRISIS-cfg.BIZ_LOSS_RATE_MAX);
    biz=Math.round(biz*(1-pen*0.5));
  }
  var diags=[];
  if(lossRate>=0.30) diags.push({key:"lossRate",label:"企業虧損率偏高",detail:Math.round(lossRate*100)+"% 公司虧損",penalty:Math.round(lossRate*60)});
  if(cashS<40)       diags.push({key:"cashFlow",label:"現金流緊張",   detail:"平均可維持 "+Math.round(avgCashDays)+" 天",             penalty:Math.round(40-cashS)});
  if(debtS<50)       diags.push({key:"debt",    label:"負債率偏高",   detail:"平均負債率 "+Math.round((debtTotal/total)*100)+"%",     penalty:Math.round(50-debtS)});
  if(utilS<40)       diags.push({key:"util",    label:"產能利用率低", detail:"平均利用率 "+Math.round(utilTotal/total*100)+"%",       penalty:Math.round(40-utilS)});
  diags.sort(function(a,b){return b.penalty-a.penalty;});
  return {score:eiClamp(biz,0,100),lossRate:lossRate,sub:{profit:Math.round(profitS),cash:Math.round(cashS),debt:Math.round(debtS),util:Math.round(utilS)},diags:diags.slice(0,3)};
}

// ── 三、金融健康度 ─────────────────────────────────────────
function calcFinancialScore(){
  var cfg=EI_CONFIG;
  var npcs=world.companies.filter(function(c){return !c.bankrupt;});
  var all=world.companies; var total=npcs.length||1;
  var loanTotal=0,defaultCount=0;
  npcs.forEach(function(c){
    if(!c.bankAccount) return;
    c.bankAccount.loans.forEach(function(l){
      loanTotal++;
      if((l.lateDays||0)>3) defaultCount++;
    });
  });
  var defaultRate=loanTotal>0?defaultCount/loanTotal:0;
  var defaultS=eiClamp((1-defaultRate/cfg.FIN_DEFAULT_RATE_MAX)*100,0,100);
  var bankruptCount=all.filter(function(c){return c.bankrupt;}).length;
  var bankruptRate=bankruptCount/Math.max(all.length,1);
  var bankruptS=eiClamp((1-bankruptRate/cfg.FIN_BANKRUPT_RATE_MAX)*100,0,100);
  var bankH=(world.bank&&(world.bank.wallet||0)>=0)?80:30;
  var stockS=50;
  if(world.stock&&world.stock.dailyStats) stockS=Math.min(100,50+(world.stock.dailyStats.totalVolume||0)/100);
  var fin=Math.round(defaultS*0.40+bankruptS*0.35+bankH*0.15+stockS*0.10);
  var diags=[];
  if(defaultRate>0.05)  diags.push({key:"default", label:"貸款違約率上升",detail:"違約率 "+Math.round(defaultRate*100)+"%",                   penalty:Math.round((defaultRate/cfg.FIN_DEFAULT_RATE_MAX)*40)});
  if(bankruptRate>0.02) diags.push({key:"bankrupt",label:"公司破產率偏高",detail:"已破產 "+bankruptCount+" 家（"+Math.round(bankruptRate*100)+"%）",penalty:Math.round((bankruptRate/cfg.FIN_BANKRUPT_RATE_MAX)*35)});
  if(bankH<50)          diags.push({key:"bankWallet",label:"銀行資產不健康",detail:"銀行錢包 "+money(world.bank&&world.bank.wallet||0),          penalty:30});
  diags.sort(function(a,b){return b.penalty-a.penalty;});
  return {score:eiClamp(fin,0,100),sub:{default:Math.round(defaultS),bankrupt:Math.round(bankruptS),bank:Math.round(bankH),stock:Math.round(stockS)},diags:diags.slice(0,3)};
}

// ── 主函式 ─────────────────────────────────────────────────
function tickBank(){
  var econ=world.economyState, cfg=EI_CONFIG;
  var dR=calcDemandScore(econ), bR=calcBusinessScore(), fR=calcFinancialScore();
  var todayEI=eiClamp(Math.round(dR.score*cfg.DEMAND_WEIGHT+bR.score*cfg.BUSINESS_WEIGHT+fR.score*cfg.FINANCE_WEIGHT),0,100);
  var yesterdayEI=econ.economicIndex!=null?econ.economicIndex:50;
  var finalEI=eiClamp(Math.round(yesterdayEI*cfg.INERTIA_YESTERDAY+todayEI*cfg.INERTIA_TODAY),0,100);
  econ.economicIndex=finalEI; econ.eiTodayRaw=todayEI;
  econ.eiComponents={demand:dR.score,business:bR.score,finance:fR.score,
    vol:dR.sub.vol,price:dR.sub.sold,profit:bR.sub.profit,bankrupt:fR.sub.bankrupt,stock:fR.sub.stock};
  econ.eiDiagnosis={demand:{score:dR.score,diags:dR.diags},
    business:{score:bR.score,diags:bR.diags,lossRate:bR.lossRate},
    finance:{score:fR.score,diags:fR.diags}};
  var pi,label;
  if(finalEI>=80){pi=2;label="🟢 繁榮（EI "+finalEI+"）";}
  else if(finalEI>=60){pi=1;label="🔵 景氣（EI "+finalEI+"）";}
  else if(finalEI>=40){pi=0;label="🟡 平穩（EI "+finalEI+"）";}
  else if(finalEI>=20){pi=-1;label="🟠 衰退（EI "+finalEI+"）";}
  else{pi=-2;label="🔴 蕭條（EI "+finalEI+"）";}
  econ.prosperityIndex=pi>=1?1:pi<=-1?-1:0;
  econ.prosperityLabel=label;
  econ.prosperityTier=pi;
  // 重置每日累計
  econ.totalMarketVolume=0; econ.totalMarketCount=0; econ.totalVenueSales=0;
  Object.values(world.market).forEach(function(m){m.trades=0;});
}

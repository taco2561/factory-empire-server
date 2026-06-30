// ══════════════════════════════════════════════════════════════
// 監測系統 V2.0
// 每個遊戲日結束時執行，依類型分組，取各類型前3名
// ══════════════════════════════════════════════════════════════

function generateMonitorReport(){
  var typeOrder = ["producer","seller","arbitrage","integrated"];

  // ── 建立各公司完整快照 ──────────────────────────────────
  var allNpcs = world.companies.filter(function(c){ return !c.isPlayer && !c.bankrupt; }).map(function(npc){
    // 建築統計：{ type -> count }
    var bldgMap = {};
    npc.buildings.filter(function(b){ return b.isCompleted; }).forEach(function(b){
      bldgMap[b.type] = (bldgMap[b.type]||0) + 1;
    });
    // 建築建造中
    var underConstruction = npc.buildings.filter(function(b){ return !b.isCompleted; }).map(function(b){
      return BUILDINGS[b.type].name;
    });

    // 主要生產商品（從 activityLog produce 欄位）
    var producingPids = [];
    var log = npc.activityLog || {};
    Object.entries(log).forEach(function(e){
      var parts = e[0].split("_");
      var action = parts[parts.length-1];
      var pid = parts.slice(0,-1).join("_");
      if(action === "produce" && PRODUCTS[pid] && e[1] > 0) producingPids.push({ pid:pid, qty:e[1] });
    });
    producingPids.sort(function(a,b){ return b.qty-a.qty; });

    // 若 activityLog 無生產記錄，從建築可產商品推斷
    if(!producingPids.length){
      npc.buildings.filter(function(b){ return b.isCompleted; }).forEach(function(b){
        var bDef = BUILDINGS[b.type];
        if(!isVenueBuilding(bDef) && !bDef.isReceptionCenter){
          bDef.products.forEach(function(pid){ producingPids.push({ pid:pid, qty:0 }); });
        }
      });
    }

    // 銀行存款
    var depositTotal = totalDepositValue(npc);
    var loanTotal    = totalLoanOutstanding(npc);

    // 總資產
    var assets = companyBookValue(npc);

    // 下一步計畫
    var nextAction = (npc.npcState && npc.npcState.nextAction) || "—";

    // 當前策略描述（使用新 v5 的 aiState 和 targetPid）
    var strategy = "—";
    if(npc.npcState){
      var state = npc.npcState;
      var industries = npcGetIndustries ? npcGetIndustries(npc) : [];
      var taskLen = (state.taskQueue&&state.taskQueue.length)||0;
      var cashSt  = state.cashStatus||"OK";

      if(!npcHasBuilding(npc,"reservoir")||!npcHasBuilding(npc,"farm")||!npcHasVenueType(npc,"supermarket")){
        strategy = "🌱 S1：補建核心設施";
      } else if(cashSt==="LOW"){
        strategy = "⚠️ S5：資金危機，緊急清倉/借款";
      } else {
        var indLabel = industries.length>0 ? industries.slice(0,2).map(function(bk){ return BUILDINGS[bk]?BUILDINGS[bk].name:bk; }).join("、") : "農業";
        strategy = "⚙️ S2~S6 運營（"+indLabel+"等 "+industries.length+" 行業）";
      }
    }

    return {
      id:         npc.id,
      name:       npc.name,
      npcType:    npc.npcType,
      assets:     assets,
      cash:       npc.cash,
      depositTotal: depositTotal,
      loanTotal:  loanTotal,
      bldgMap:    bldgMap,
      underConstruction: underConstruction,
      producingPids: producingPids.slice(0,4),
      strategy:   strategy,
      nextAction: nextAction,
      creditRating: npc.bankAccount ? npc.bankAccount.creditRating : "—",
    };
  });

  // ── 依類型分組，各取前 3 名 ──────────────────────────────
  var byType = {};
  typeOrder.forEach(function(t){ byType[t] = []; });
  allNpcs.forEach(function(snap){
    if(byType[snap.npcType]) byType[snap.npcType].push(snap);
  });
  typeOrder.forEach(function(t){
    byType[t].sort(function(a,b){ return b.assets-a.assets; });
  });

  // ── 市場快照 ─────────────────────────────────────────────
  var marketSnap = {};
  Object.values(world.market).forEach(function(m){
    marketSnap[m.productId] = { price: m.price, demand: m.demand, supply: m.supply, trades: m.trades };
  });

  var report = {
    day:       world.day,
    time:      Date.now(),
    byType:    byType,
    allNpcs:   allNpcs.sort(function(a,b){ return b.assets-a.assets; }),
    marketSnap: marketSnap,
    bankInfo: {
      wallet:             world.bank.wallet,
      lastSubsidyDay:     world.bank.lastSubsidyDay,
      lastSubsidyAmount:  world.bank.lastSubsidyAmount,
      lastSubsidyRecipients: world.bank.lastSubsidyRecipients,
      nextSubsidyIn:      8 - (world.day % 8),
    },
    // ── 股票市場快照 ──────────────────────────────────────────
    stockInfo: (function(){
      var s=ensureStock();
      var listed=Object.values(s.companies);
      var sorted=listed.slice().sort(function(a,b){ return stockMarketCap(b.companyId)-stockMarketCap(a.companyId); });
      var byChange=listed.slice().sort(function(a,b){ return stockChangeRate(b)-stockChangeRate(a); });
      return {
        count:     listed.length,
        totalVol:  s.dailyStats.totalVolume||0,
        totalVal:  s.dailyStats.totalValue||0,
        topMktCap: sorted.slice(0,3).map(function(sc){ return { symbol:sc.symbol, price:sc.price, mktCap:stockMarketCap(sc.companyId) }; }),
        topGain:   byChange.slice(0,3).map(function(sc){ return { symbol:sc.symbol, change:stockChangeRate(sc) }; }),
        topLoss:   byChange.slice(-3).reverse().map(function(sc){ return { symbol:sc.symbol, change:stockChangeRate(sc) }; }),
      };
    })(),
  };

  world.monitor.reports.unshift(report);
  if(world.monitor.reports.length > 5) world.monitor.reports.pop();
  world.monitor.lastReportDay = world.day;

  notify("📊 監測系統 V2.0：第 "+world.day+" 天產業報告已發布");
}

// ══════════════════════════════════════════════════════════════
// NPC AI v5 — Data-Driven Architecture
// 核心設計：Recipe System + Supply Chain Planner + Task Queue + State Machine
// 擴充方式：只需在 PRODUCTS/BUILDINGS 新增資料，無需修改決策邏輯
// ══════════════════════════════════════════════════════════════

// ── 常數 ────────────────────────────────────────────────────
var NPC_MAX_DEBUG_LOGS    = 20;
var NPC_RESTOCK_MARKUP    = 1.10;
var NPC_SELL_MARKUP       = 1.05;
// NPC_FREE_CASH_MIN 改為動態（見 npcFreeCashMin 函式），此常數僅作備用
var NPC_FREE_CASH_MIN     = 2000;
var NPC_BUILD_CASH_MULT   = 1.3;
var NPC_MARKET_SCARCE     = 20;
var NPC_MARKET_SURPLUS    = 200;
var NPC_INCOME_STREAK_MAX = 5;
var NPC_SHORTAGE_BUILD_DAYS = 3;
var NPC_MIN_OPERATION_CASH  = 2000; // 低於此現金停止非必要生產

// ── 動態自由決策門檻（依公司規模調整）──────────────────────

// ── 目標庫存（生產量控制上限）────────────────────────────────
var TARGET_INVENTORY = {
  water:80, seeds:40, apple:60, grape:60,
  feed:30, pig:10, cow:10, chicken:10,
  porkchop:20, beefsteak:15, chicken_steak:20,
  cloth:20, leather:15, shirt:20, pants:20, shoes:15,
  power:30, limestone:30, clay:30, cement:20,
  brick:20, reinforced_concrete:15,
  // ── v0.4 新增：礦業、材料、電子產業 ──
  iron_ore:30, copper_ore:25, aluminum_ore:20, lithium_ore:15, silica_sand:25, crude_oil:20,
  silicon_wafer:10, plastic:20, chemicals:18, steel:18,
  battery:12, pcb:12, cpu:8, memory:8, display:10, power_supply:10,
  smartphone:8, computer:6, television:6,
};
function getTargetInventory(pid){ return TARGET_INVENTORY[pid]||30; }
function npcNeedsProduction(npc, pid){
  return (npc.warehouse[pid]||0) < getTargetInventory(pid);
}
function npcVenueNeedsPid(npc, pid){
  return world.venues.some(function(v){
    return v.companyId===npc.id && v.shelves[pid] && v.shelves[pid].stock < 5;
  });
}

// ── 門市通路對應 ─────────────────────────────────────────────
var _terminalVenueMap = null;
function getTerminalVenueMap(){
  if(_terminalVenueMap) return _terminalVenueMap;
  _terminalVenueMap = {};
  Object.values(PRODUCTS).forEach(function(p){
    if(p.consumer && p.venue) _terminalVenueMap[p.id] = p.venue;
  });
  return _terminalVenueMap;
}

// ── Recipe System ────────────────────────────────────────────
function recipeBuildingFor(pid){
  // 礦洞產出的礦物特例：BUILDINGS.mine.products 固定為空陣列
  // （實際產出由每座礦洞的 building.mineOres 決定），礦物一律反查到 mine
  if(typeof MINE_POSSIBLE_ORES!=="undefined" && MINE_POSSIBLE_ORES.indexOf(pid)>=0) return "mine";
  return Object.keys(BUILDINGS).find(function(bk){
    var bDef = BUILDINGS[bk];
    return bDef && bDef.products && bDef.products.indexOf(pid) >= 0;
  }) || null;
}
function recipeExpandDeps(pid, memo, depth){
  memo=memo||{}; depth=depth||0;
  if(depth>8||memo[pid]) return {};
  memo[pid]=true;
  var product=PRODUCTS[pid]; if(!product||!product.inputs) return {};
  var result={};
  Object.keys(product.inputs).forEach(function(inp){
    var bk=recipeBuildingFor(inp); if(bk) result[inp]=bk;
    var sub=recipeExpandDeps(inp,memo,depth+1);
    Object.keys(sub).forEach(function(k){ if(!result[k]) result[k]=sub[k]; });
  });
  return result;
}
function recipeGetBuildingChain(targetPid){
  var deps=recipeExpandDeps(targetPid);
  var selfBk=recipeBuildingFor(targetPid); if(selfBk) deps[targetPid]=selfBk;
  var items=Object.keys(deps).map(function(pid){
    var p=PRODUCTS[pid]; return { pid:pid, bk:deps[pid], depth:p?Object.keys(p.inputs||{}).length:0 };
  });
  items.sort(function(a,b){ return a.depth-b.depth; });
  return items;
}
function recipeEstimateCost(npc, pid, qty){
  qty=qty||4;
  var product=PRODUCTS[pid]; if(!product) return Infinity;
  var bk=recipeBuildingFor(pid); if(!bk) return Infinity;
  var bDef=BUILDINGS[bk]; if(!bDef) return Infinity;
  var wage=bDef.workers*1.5*qty; var matCost=0;
  for(var inp in product.inputs){
    var need=product.inputs[inp]*qty;
    var have=npc.warehouse[inp]||0;
    var ownCost=getUnitCost(npc,inp)*Math.min(have,need);
    var buyPrice=world.market[inp]?world.market[inp].price:(PRODUCTS[inp]||{}).basePrice||0;
    matCost+=ownCost+buyPrice*Math.max(0,need-have);
  }
  return (matCost+wage)/qty;
}

// ── 工具函式 ─────────────────────────────────────────────────
function npcHasBuilding(npc, bType){
  return npc.buildings.some(function(b){ return b.type===bType&&b.isCompleted; });
}
function npcHasVenueType(npc, venueType){
  return npc.buildings.some(function(b){ return BUILDINGS[b.type]&&BUILDINGS[b.type].venueType===venueType; });
}
function npcBuildingTotal(npc, bType){
  return npc.buildings.filter(function(b){ return b.type===bType; }).length;
}
function npcBuildingCount(npc, bType){
  return npc.buildings.filter(function(b){ return b.type===bType&&b.isCompleted; }).length;
}
function getMarketInventory(pid){
  return (world.marketInventory&&world.marketInventory[pid])||
         (world.market[pid]&&world.market[pid].marketStock)||0;
}
function npcMarketHasBuyer(pid){
  var mkt=world.market[pid];
  return mkt&&mkt.orderBook.buy.some(function(o){ return o.remaining>0; });
}
function npcMarketIsOversupplied(pid){
  var stock=getMarketInventory(pid);
  var ideal=(typeof getIdealStock!=="undefined")?getIdealStock(pid):NPC_MARKET_SURPLUS;
  return stock>ideal*2.0;
}
function npcMarketIsScarce(pid){
  var stock=getMarketInventory(pid);
  var ideal=(typeof getIdealStock!=="undefined")?getIdealStock(pid):NPC_MARKET_SCARCE;
  return stock<ideal*0.2;
}
function npcBuild(npc, bType, reason){
  var b=BUILDINGS[bType]; if(!b) return false;
  if(npc.buildings.some(function(x){ return x.type===bType; })) return false;
  if(npc.cash<b.cost*NPC_BUILD_CASH_MULT) return false;
  startBuilding(npc.id,bType);
  npcLog(npc,"BUILD","建造 "+b.name+"（"+reason+"）");
  return true;
}
function npcBuildNew(npc, bType, reason){
  var b=BUILDINGS[bType]; if(!b||npc.cash<b.cost*NPC_BUILD_CASH_MULT) return false;
  startBuilding(npc.id,bType);
  npcLog(npc,"BUILD","擴建 "+b.name+"（"+reason+"）");
  return true;
}
function npcRestockVenue(npc, v, pid){
  var shelf=v.shelves[pid]; if(!shelf) return;
  var stock=npc.warehouse[pid]||0; if(stock<2) return;
  var vBldg=npc.buildings.find(function(b){ return b.id===v.buildingId; });
  var wageUnit=vBldg?BUILDINGS[vBldg.type].workers*1.5:0;
  var qty=Math.min(stock,15); var wage=wageUnit*qty;
  if(npc.cash<wage) return;
  var uc=getUnitCost(npc,pid);
  var mktPrice=world.market[pid]?world.market[pid].price:PRODUCTS[pid].basePrice;
  var sellPrice=Math.max((uc>0?uc:mktPrice)*NPC_RESTOCK_MARKUP,mktPrice*1.02);
  warehouseOut(npc,pid,qty);
  shelf.stock+=qty; shelf.listed=true; shelf.price=sellPrice;
  npc.cash-=wage;
  npc.finance.wagesPaid=(npc.finance.wagesPaid||0)+wage;
  npc.finance.expenses=(npc.finance.expenses||0)+wage;
  EMPLOYEE_WALLET+=wage;
  trackActivity(npc,pid,"sell",qty);
}
function npcCanSelfProduce(npc, pid){
  return npc.buildings.some(function(b){
    if(!b.isCompleted) return false;
    var bd=BUILDINGS[b.type];
    if(!bd||isVenueBuilding(bd)||bd.isReceptionCenter) return false;
    return getBuildingProducts(b).indexOf(pid)>=0;
  });
}
function npcSpecBonus(npc, bType){
  var count=npcBuildingCount(npc,bType);
  return Math.min(1.30, 1.0+(count-1)*0.05);
}

// ══════════════════════════════════════════════════════════════
// 專精度系統（Specialization）
// 同類型建築越多，生產效率越高，鼓勵 AI 專精而非全能
// ══════════════════════════════════════════════════════════════

// 計算某建築類型的專精加成（同類完工棟數 → 產量倍率）
// ══════════════════════════════════════════════════════════════
// AI 決策系統 V7 — 純資料驅動，無固定類型，6步驟
// ══════════════════════════════════════════════════════════════

// ── 明日最低運營資金計算 ─────────────────────────────────────
function npcDailyMinCash(npc){
  // 所有完工建築員工的一天薪資
  var wage = npc.buildings.filter(function(b){ return b.isCompleted; }).reduce(function(s,b){
    return s + (BUILDINGS[b.type]||{workers:0}).workers * 1.5;
  }, 0);
  return Math.max(wage * 1.5, 200); // 薪資1.5倍安全緩衝，最低200
}

// ── 計算公司可動用資金（扣除明日運營後）────────────────────
function npcFreeCash(npc){
  return Math.max(0, npc.cash - npcDailyMinCash(npc));
}

// ── 取得公司所有已建置的行業（不含生存三棟）────────────────
function npcGetIndustries(npc){
  var survival = { reservoir:true, farm:true, supermarket:true };
  var seen = {};
  npc.buildings.forEach(function(b){
    if(!survival[b.type]) seen[b.type] = true;
  });
  return Object.keys(seen);
}

// ══════════════════════════════════════════════════════════════
// STEP 1：生存確認
// 蓄水池+農場+生鮮超市各1，不足時補建，並啟動核心生產鏈
// ══════════════════════════════════════════════════════════════
function npcS1_Survival(npc, state){
  var hasR = npcBuildingTotal(npc,'reservoir')>0;
  var hasF = npcBuildingTotal(npc,'farm')>0;
  var hasS = npcBuildingTotal(npc,'supermarket')>0;
  var built = false;

  if(!hasR && npc.cash >= BUILDINGS.reservoir.cost){
    startBuilding(npc.id,'reservoir');
    npcLog(npc,'BUILD','S1：補建蓄水池');
    built = true;
  }
  if(!hasF && npc.cash >= BUILDINGS.farm.cost){
    startBuilding(npc.id,'farm');
    npcLog(npc,'BUILD','S1：補建農場');
    built = true;
  }
  if(!hasS && npcBuildingTotal(npc,'supermarket')===0 && npc.cash >= BUILDINGS.supermarket.cost){
    startBuilding(npc.id,'supermarket');
    npcLog(npc,'BUILD','S1：補建生鮮超市');
    built = true;
  }

  // 核心生產鏈：水→種子→蘋果/葡萄（只在庫存低於目標時）
  npc.buildings.forEach(function(b){
    if(!b.isCompleted || b.productionQueue.length >= 2) return;
    if(b.type==='reservoir' && npcNeedsProduction(npc,'water') && npc.cash>200){
      enqueueProductionNPC(npc,b,'water',6);
    }
    if(b.type==='farm'){
      var w=npc.warehouse.water||0, s=npc.warehouse.seeds||0;
      if(npcNeedsProduction(npc,'seeds') && w>=2 && npc.cash>200){
        enqueueProductionNPC(npc,b,'seeds',4); return;
      }
      if((npcNeedsProduction(npc,'grape')||npcVenueNeedsPid(npc,'grape')) && s>=1 && w>=1 && npc.cash>200){
        enqueueProductionNPC(npc,b,'grape',4); return;
      }
      if((npcNeedsProduction(npc,'apple')||npcVenueNeedsPid(npc,'apple')) && s>=1 && w>=1 && npc.cash>200){
        enqueueProductionNPC(npc,b,'apple',4);
      }
    }
  });

  // 超市補貨
  world.venues.filter(function(v){ return v.companyId===npc.id; }).forEach(function(v){
    Object.keys(v.shelves).forEach(function(pid){ npcRestockVenue(npc,v,pid); });
  });

  return hasR && hasF && hasS; // coreReady
}

// ══════════════════════════════════════════════════════════════
// STEP 2：確保所有建築運行（庫存過剩則跳過）
// ══════════════════════════════════════════════════════════════
function npcS2_ActivateBuildings(npc){
  npc.buildings.forEach(function(b){
    if(!b.isCompleted) return;
    var bDef = BUILDINGS[b.type]; if(!bDef) return;

    // 門市：補貨
    if(isVenueBuilding(bDef)){
      var v=world.venues.find(function(vn){ return vn.buildingId===b.id; });
      if(v) Object.keys(v.shelves).forEach(function(pid){ npcRestockVenue(npc,v,pid); });
      return;
    }
    if(bDef.isReceptionCenter) return;
    if(b.productionQueue.length >= 2) return;

    // 選最適合生產的商品（庫存最低於目標，且原料最充足）
    var best=null, bestScore=-Infinity;
    getBuildingProducts(b).forEach(function(pid){
      var p=PRODUCTS[pid]; if(!p) return;
      // 庫存過剩 → 跳過
      if(!npcNeedsProduction(npc,pid) && !npcVenueNeedsPid(npc,pid)) return;
      var score = (getTargetInventory(pid)-(npc.warehouse[pid]||0)) / getTargetInventory(pid) * 20;
      for(var inp in p.inputs){
        var have=npc.warehouse[inp]||0, need=p.inputs[inp]*4;
        score += have>=need?5:have>0?1:-8;
      }
      if(score>bestScore){ bestScore=score; best=pid; }
    });
    if(!best) return;

    if(enqueueProductionNPC(npc,b,best,4)) return;

    // 缺料 → 補買
    var p=PRODUCTS[best]; if(!p) return;
    for(var inp in p.inputs){
      var need=p.inputs[inp]*4, have=npc.warehouse[inp]||0;
      if(have>=need) continue;
      var deficit=need-have;
      if(npcCanSelfProduce(npc,inp)){
        npc.buildings.forEach(function(sb){
          if(!sb.isCompleted||sb.productionQueue.length>=2) return;
          var sd=BUILDINGS[sb.type];
          if(!sd||isVenueBuilding(sd)) return;
          if(getBuildingProducts(sb).indexOf(inp)<0) return;
          enqueueProductionNPC(npc,sb,inp,Math.max(4,Math.ceil(deficit/2)*2));
        });
      } else {
        var mkt=world.market[inp]; if(!mkt) continue;
        var baseP=(PRODUCTS[inp]||{}).basePrice||1;
        var bid=mkt.orderBook.sell.length>0?mkt.orderBook.sell[0].price*1.05:baseP*1.4;
        if(npc.cash>=bid*deficit*1.1 && npc.cash-bid*deficit>npcDailyMinCash(npc)){
          createOrder(npc.id,inp,'buy',Math.ceil(deficit),bid);
        }
      }
    }
  });
}

// ══════════════════════════════════════════════════════════════
// STEP 3：擴大產能 or 參與其他行業
// ══════════════════════════════════════════════════════════════
// 取得公司尚未擁有的「上游」建築清單（按建造成本排序）
function npcGetNewBuildingCandidates(npc){
  var owned={};
  npc.buildings.forEach(function(b){ owned[b.type]=true; });
  // 所有可建的建築（排除門市，門市在有商品時才建）
  var candidates=[];
  Object.keys(BUILDINGS).forEach(function(bk){
    var bd=BUILDINGS[bk];
    if(!bd||bd.isSupermarket||bd.isRestaurant||bd.isClothingStore||bd.isElectronicsStore||bd.isReceptionCenter) return;
    if(owned[bk]) return;
    // 計算若蓋此建築，它的產品在市場的需求
    // 礦洞特例：products 為空陣列（實際產出隨機決定），改用所有礦物市場缺口的平均值估算
    var productList = bd.isMine ? MINE_POSSIBLE_ORES : (bd.products||[]);
    var mktNeed=0;
    productList.forEach(function(pid){
      var inv=getMarketInventory(pid)||0;
      var ideal=getIdealStock?getIdealStock(pid):60;
      mktNeed += Math.max(0, ideal-inv); // 市場缺口
    });
    if(bd.isMine) mktNeed = mktNeed / MINE_POSSIBLE_ORES.length * 3; // 礦洞只產3種，估算其期望缺口
    candidates.push({ bType:bk, cost:bd.cost, mktNeed:mktNeed });
  });
  // 市場需求越高、成本越低 → 排越前
  candidates.sort(function(a,b){
    return (b.mktNeed/Math.max(b.cost,1)) - (a.mktNeed/Math.max(a.cost,1));
  });
  return candidates;
}

function npcS3_ExpandOrDiversify(npc, state){
  var free = npcFreeCash(npc);
  if(free < 100) return; // 資金不夠，不動

  var farms = npcBuildingTotal(npc,'farm');
  var res   = npcBuildingTotal(npc,'reservoir');

  // 擴產門檻：農場<6且蓄水池跟農場平衡
  var canExpand = free >= BUILDINGS.farm.cost && free >= BUILDINGS.reservoir.cost && farms < 6;
  // 多元化門檻：有足夠資金建新行業上游建築
  var newBldgList = npcGetNewBuildingCandidates(npc);
  var canDiversify = newBldgList.length>0 && free >= newBldgList[0].cost * 1.3;

  if(!canExpand && !canDiversify) return;

  var choice;
  if(canExpand && canDiversify){
    choice = Math.random() < 0.5 ? 'expand' : 'diversify'; // 各50%隨機
  } else if(canExpand){
    choice = 'expand';
  } else {
    choice = 'diversify';
  }

  if(choice==='expand'){
    // 蓄水池和農場各蓋一個（如有資金）
    if(res <= farms && npc.cash-BUILDINGS.reservoir.cost > npcDailyMinCash(npc)){
      startBuilding(npc.id,'reservoir');
      npcLog(npc,'BUILD','S3 擴產：蓄水池×'+(res+1));
      state.nextAction='擴建蓄水池（農場'+farms+'棟）';
    }
    if(farms < 6 && npc.cash-BUILDINGS.farm.cost > npcDailyMinCash(npc)){
      startBuilding(npc.id,'farm');
      npcLog(npc,'BUILD','S3 擴產：農場×'+(farms+1));
      state.nextAction='擴建農場×'+(farms+1);
    }
  } else {
    // 多元化：從評分最高的建築開始蓋，優先上游
    for(var i=0;i<newBldgList.length;i++){
      var c=newBldgList[i];
      if(npc.cash - c.cost > npcDailyMinCash(npc) && npc.cash >= c.cost * 1.3){
        startBuilding(npc.id, c.bType);
        npcLog(npc,'BUILD','S3 多元化：建'+BUILDINGS[c.bType].name+'（市場缺口'+Math.round(c.mktNeed)+'）');
        state.nextAction='投入新行業：'+BUILDINGS[c.bType].name;
        // 同時建對應的通路（若有）
        _npcBuildVenueIfNeeded(npc, c.bType);
        break; // 每次只建一棟
      }
    }
  }
}

// 若新行業的產品有對應門市且未建，一併建造
function _npcBuildVenueIfNeeded(npc, bType){
  var bd=BUILDINGS[bType]; if(!bd) return;
  var venueMap=getTerminalVenueMap();
  (bd.products||[]).forEach(function(pid){
    var vt=venueMap[pid]; if(!vt) return;
    var vk=vt==='supermarket'?'supermarket':vt==='restaurant'?'restaurant':'clothing_store';
    if(!npcHasVenueType(npc,vt) && npcBuildingTotal(npc,vk)===0){
      if(npc.cash - BUILDINGS[vk].cost > npcDailyMinCash(npc)){
        startBuilding(npc.id,vk);
        npcLog(npc,'BUILD','S3 配套通路：'+BUILDINGS[vk].name);
      }
    }
  });
}

// ══════════════════════════════════════════════════════════════
// STEP 4：新建築立刻投產
// ══════════════════════════════════════════════════════════════
function npcS4_StartNewProduction(npc){
  // 找剛完工（今天或昨天）且佇列空的建築
  npc.buildings.forEach(function(b){
    if(!b.isCompleted) return;
    var bDef=BUILDINGS[b.type]; if(!bDef||isVenueBuilding(bDef)||bDef.isReceptionCenter) return;
    if(b.productionQueue.length>0) return; // 已有排程

    // 找可生產且庫存未過剩的最佳商品
    var best=null, bestScore=-Infinity;
    getBuildingProducts(b).forEach(function(pid){
      var p=PRODUCTS[pid]; if(!p) return;
      var score=(getTargetInventory(pid)-(npc.warehouse[pid]||0))/getTargetInventory(pid)*10;
      for(var inp in p.inputs){
        score += (npc.warehouse[inp]||0)>=(p.inputs[inp]*4)?3:-5;
      }
      if(score>bestScore){ bestScore=score; best=pid; }
    });
    if(best && bestScore>-10 && npc.cash>npcDailyMinCash(npc)){
      if(enqueueProductionNPC(npc,b,best,4)){
        npcLog(npc,'PROD','S4 新建築投產：'+bDef.name+'→'+best);
      }
    }
  });
}

// ══════════════════════════════════════════════════════════════
// STEP 5：套利分析（市場低於政府採購價 → 買入轉賣）
// ══════════════════════════════════════════════════════════════
function npcS5_ArbitrageGov(npc){
  var gov=ensureGovernment();
  if(!gov.orders||!gov.orders.length) return;

  gov.orders.forEach(function(order){
    if(order.status==='filled'||order.status==='expired') return;
    var remaining=order.qty-order.filled;
    if(remaining<=0) return;

    var pid=order.pid;
    var govPrice=order.pricePerUnit;
    var mkt=world.market[pid]; if(!mkt) return;

    // 套利條件：市場最低賣價 < 政府採購價（有利差）
    if(mkt.orderBook.sell.length>0){
      var mktAsk=mkt.orderBook.sell[0].price;
      var spread=govPrice-mktAsk;
      if(spread > mktAsk * 0.05){ // 利差>5%才值得
        // 計算可買量（不超過剩餘需求，也不超過可動用資金）
        var freeCash=npcFreeCash(npc);
        var maxBuy=Math.floor(freeCash/mktAsk);
        var buyQty=Math.min(maxBuy, remaining, 20); // 每次最多20件
        if(buyQty>=1){
          createOrder(npc.id,pid,'buy',buyQty,mktAsk*1.02);
          npcLog(npc,'ARB','S5 套利：買 '+pid+' ×'+buyQty+' @'+money(mktAsk)+' 轉賣政府 @'+money(govPrice)+' 利差'+money(spread*buyQty));
        }
      }
    }

    // 如果自己倉庫有存貨且政府有訂單，直接履單
    var haveQty=npc.warehouse[pid]||0;
    if(haveQty>0){
      var sellQty=Math.min(haveQty,remaining);
      if(sellQty>=1){
        govFulfillOrder(order.id, npc.id, sellQty);
      }
    }
  });
}

// ══════════════════════════════════════════════════════════════
// STEP 6：清倉（過剩 → 市場賣單 or 政府訂單）
// ══════════════════════════════════════════════════════════════
function npcS6_ClearExcess(npc){
  var venueMap=getTerminalVenueMap();
  var gov=ensureGovernment();

  Object.keys(PRODUCTS).forEach(function(pid){
    var qty=npc.warehouse[pid]||0;
    var tgt=getTargetInventory(pid);
    if(qty<=tgt) return; // 未過剩
    var excess=qty-tgt;
    if(excess<2) return;

    // 優先政府訂單（通常價格更好）
    if(gov.orders){
      gov.orders.forEach(function(order){
        if(order.pid!==pid||order.status==='filled'||order.status==='expired') return;
        var rem=order.qty-order.filled;
        if(rem<=0) return;
        govFulfillOrder(order.id,npc.id,Math.min(excess,rem));
      });
    }

    // 剩餘掛市場
    qty=npc.warehouse[pid]||0;
    excess=qty-tgt;
    if(excess<2) return;
    // 有自產能力且有下游 → 保留
    if(npcCanSelfProduce(npc,pid)){
      var hasDs=npc.buildings.some(function(b){
        if(!b.isCompleted) return false;
        var bd=BUILDINGS[b.type]; if(!bd||isVenueBuilding(bd)) return false;
        return bd.products&&bd.products.some(function(op){
          var pp=PRODUCTS[op]; return pp&&pp.inputs&&pp.inputs.hasOwnProperty(pid);
        });
      });
      if(hasDs) return;
    }
    // 有門市 → 走門市
    if(venueMap[pid]&&npcHasVenueType(npc,venueMap[pid])) return;
    // 掛賣單
    var mkt=world.market[pid]; if(!mkt) return;
    var uc=getUnitCost(npc,pid)||0;
    var baseP=(PRODUCTS[pid]||{}).basePrice||1;
    var askPrice=uc>0?Math.max(uc*1.05,baseP*0.8):baseP*0.9;
    if(mkt.orderBook.buy.length>0){
      var bb=mkt.orderBook.buy[0].price;
      if(bb>askPrice) askPrice=bb*0.99;
    }
    var sellQty=Math.ceil(excess*0.6);
    if(sellQty>=1){
      createOrder(npc.id,pid,'sell',sellQty,askPrice);
      trackActivity(npc,pid,'sell',sellQty);
    }
  });
}

// ══════════════════════════════════════════════════════════════
// 主決策 Pipeline（6步驟）
// ══════════════════════════════════════════════════════════════
function npcDailyDecision(npc){
  var state=ensureNpcState(npc);
  state.lastDecisionDay=world.day;
  state.nextAction='—';

  // S1：生存確認
  var coreReady=npcS1_Survival(npc,state);
  if(!coreReady){
    state.nextAction='S1：補建核心設施（蓄水池/農場/超市）';
    return;
  }

  // S2：啟動所有建築（庫存過剩跳過）
  npcS2_ActivateBuildings(npc);

  // S3：擴產 or 多元化（保留明日運營資金）
  npcS3_ExpandOrDiversify(npc,state);

  // S4：新建築立刻投產
  npcS4_StartNewProduction(npc);

  // S5：套利分析（市場 vs 政府訂單）
  npcS5_ArbitrageGov(npc);

  // S6：清倉（過剩 → 市場賣單 or 政府訂單）
  npcS6_ClearExcess(npc);

  if(state.nextAction==='—'){
    var industries=npcGetIndustries(npc);
    state.nextAction='運營中（'+industries.length+'個行業，現金'+money(npc.cash)+'）';
  }
  state.lastHealth=Math.round(Math.min(100,npc.cash/npcDailyMinCash(npc)*30+
    (npc.buildings.filter(function(b){return b.isCompleted;}).length)*5));
}


// ══════════════════════════════════════════════════════════════
// 供應鏈規劃
// ══════════════════════════════════════════════════════════════
function planSupplyChain(npc, targetPid){
  var chain=recipeGetBuildingChain(targetPid);
  var state=npc.npcState||{}; var shortage=state.marketShortage||{};
  var tasks=[]; var seen={};
  chain.forEach(function(item){
    var bk=item.bk, pid=item.pid; if(!bk||!BUILDINGS[bk]) return;
    var hasBldg=npc.buildings.some(function(b){ return b.type===bk; });
    if(!hasBldg&&!seen["build:"+bk]){
      tasks.push({type:"build",bType:bk,forPid:pid,reason:"建造 "+BUILDINGS[bk].name});
      seen["build:"+bk]=true;
    }
    var product=PRODUCTS[pid];
    if(product&&product.inputs){
      Object.keys(product.inputs).forEach(function(inp){
        var need=product.inputs[inp]*4,have=npc.warehouse[inp]||0;
        if(have>=need||seen["source:"+inp]) return;
        var canSelf=npcCanSelfProduce(npc,inp);
        if(canSelf){seen["source:"+inp]=true;return;}
        var mktInp=world.market[inp];
        var mktHas=mktInp&&mktInp.orderBook.sell.length>0;
        var shortDays=shortage[inp]||0;
        if(mktHas&&shortDays<3){
          tasks.push({type:"buy",pid:inp,qty:Math.ceil(need-have),reason:"買 "+inp});
          shortage[inp]=0;
        } else {
          shortage[inp]=shortDays+1;
          if(shortage[inp]>=3){
            var supBk=recipeBuildingFor(inp);
            if(supBk&&!npc.buildings.some(function(b){return b.type===supBk;})&&!seen["build:"+supBk]){
              tasks.push({type:"build",bType:supBk,forPid:inp,reason:"自建"+BUILDINGS[supBk].name});
              seen["build:"+supBk]=true;
            }
          }
        }
        seen["source:"+inp]=true;
      });
    }
  });
  if(state) state.marketShortage=shortage;
  var venueMapSC=getTerminalVenueMap(), venueTypeSC=venueMapSC[targetPid];
  if(venueTypeSC&&!npcHasVenueType(npc,venueTypeSC)){
    var vk=VENUE_TYPE_TO_BUILDING[venueTypeSC]||"clothing_store";
    tasks.unshift({type:"sell_setup",pid:targetPid,reason:"先建 "+BUILDINGS[vk].name});
  }
  var prodBk=recipeBuildingFor(targetPid);
  if(prodBk) tasks.push({type:"produce",pid:targetPid,bType:prodBk,reason:"生產 "+targetPid});
  return tasks;
}

function npcActivateBuilding(npc, b){
  var bDef=BUILDINGS[b.type]; if(!bDef||isVenueBuilding(bDef)||bDef.isReceptionCenter) return false;
  if(b.productionQueue.length>=2||npc.cash<=200) return false;
  var best=null, bestScore=-Infinity;
  getBuildingProducts(b).forEach(function(pid){
    var p=PRODUCTS[pid]; if(!p) return;
    if(!npcNeedsProduction(npc,pid)&&!npcVenueNeedsPid(npc,pid)) return;
    var score=(getTargetInventory(pid)-(npc.warehouse[pid]||0))/getTargetInventory(pid)*20;
    for(var inp in p.inputs){ score+=(npc.warehouse[inp]||0)>=(p.inputs[inp]*4)?5:((npc.warehouse[inp]||0)>0?1:-8); }
    if(score>bestScore){bestScore=score;best=pid;}
  });
  if(!best) return false;
  if(enqueueProductionNPC(npc,b,best,4)) return true;
  var p=PRODUCTS[best]; if(!p) return false;
  for(var inp in p.inputs){
    var need=p.inputs[inp]*4,have=npc.warehouse[inp]||0; if(have>=need) continue;
    var deficit=need-have;
    if(npcCanSelfProduce(npc,inp)){
      npc.buildings.forEach(function(sb){
        if(!sb.isCompleted||sb.productionQueue.length>=2) return;
        var sd=BUILDINGS[sb.type]; if(!sd||isVenueBuilding(sd)) return;
        if(getBuildingProducts(sb).indexOf(inp)<0) return;
        enqueueProductionNPC(npc,sb,inp,Math.max(4,Math.ceil(deficit/2)*2));
      });
    } else {
      var mkt=world.market[inp]; if(!mkt) continue;
      var baseP=(PRODUCTS[inp]||{}).basePrice||1;
      var bid=mkt.orderBook.sell.length>0?mkt.orderBook.sell[0].price*1.05:baseP*1.4;
      if(npc.cash>=bid*deficit*1.1) createOrder(npc.id,inp,"buy",Math.ceil(deficit),bid);
    }
  }
  return false;
}

function npcActivateAllBuildings(npc){
  npc.buildings.forEach(function(b){
    if(!b.isCompleted) return;
    var bDef=BUILDINGS[b.type]; if(!bDef) return;
    if(isVenueBuilding(bDef)){
      var v=world.venues.find(function(vn){return vn.buildingId===b.id;});
      if(v) Object.keys(v.shelves).forEach(function(pid){npcRestockVenue(npc,v,pid);});
      return;
    }
    npcActivateBuilding(npc,b);
  });
}


function enqueueProductionNPC(npc, building, productId, qty){
  var product=PRODUCTS[productId];
  if(!product) return false;
  for(var inp in product.inputs){
    if((npc.warehouse[inp]||0)<product.inputs[inp]*qty) return false;
  }
  var wage=BUILDINGS[building.type].workers*1.5*qty;
  // 政策：勞工補助（薪資降20%）
  var wageM=typeof govPolicyEffect==="function"?govPolicyEffect("wageReduction"):1.0;
  var actualWage=Math.floor(wage*wageM);
  var govSub=wage-actualWage;
  if(npc.cash<actualWage) return false;
  var matCost=0;
  for(var inp in product.inputs){
    var iqty=product.inputs[inp]*qty;
    matCost+=getUnitCost(npc,inp)*iqty;
    warehouseOut(npc,inp,iqty);
  }
  npc.cash-=actualWage;
  npc.finance.wagesPaid=(npc.finance.wagesPaid||0)+actualWage;
  if(typeof recordExpense==="function"){
    recordExpense(npc, actualWage);
    recordExpense(npc, matCost);
  } else {
    npc.finance.expenses=(npc.finance.expenses||0)+actualWage;
  }
  EMPLOYEE_WALLET+=wage; // 員工收完整薪資
  if(govSub>0 && typeof ensureGovernment==="function"){
    var govG2=ensureGovernment(); govG2.treasury=Math.max(0,govG2.treasury-govSub); govG2.totalSpent+=govSub;
  }
  var lastEnd=building.productionQueue.length>0
    ? building.productionQueue[building.productionQueue.length-1].endTime
    : gameNow();
  var bonus = npcSpecBonus(npc, building.type);
  var actualAmount = Math.round(qty * bonus);
  // 政策：生產加速（時間縮短20%）
  var spd=typeof govPolicyEffect==="function"?govPolicyEffect("produceSpeed"):1.0;
  // 修復：生產時間用「實際產出數量」計算，確保畫面顯示的「每輪數量」與生產時間始終成比例
  // （原本用原始 qty 計算時間，但 amount 已套專精度加成放大，導致時間與數量不成比例）
  building.productionQueue.push({
    product:productId, amount:actualAmount,
    endTime:lastEnd+Math.floor((20+actualAmount*4)*1000*spd),
    totalCost:matCost+actualWage
  });
  trackActivity(npc,productId,"produce",actualAmount);
  return true;
}

// ══════════════════════════════════════════════════════════════
// 狀態管理
// ══════════════════════════════════════════════════════════════
function ensureNpcState(npc){
  if(!npc.npcState) npc.npcState={
    aiState:"idle", taskQueue:[], currentTask:null, targetPid:null,
    nextAction:"—", lastRevenueSnapshot:0, dailyRevenue:[], noIncomeStreak:0,
    canExpand:true, shortageCount:{}, lastDecisionDay:-1, marketShortage:{},
    cashStatus:"OK", lastHealth:50,
  };
  if(!npc.decisionLog) npc.decisionLog=[];
  var s=npc.npcState;
  if(!s.taskQueue)      s.taskQueue=[];
  if(!s.marketShortage) s.marketShortage={};
  if(!s.cashStatus)     s.cashStatus="OK";
  if(s.lastHealth===undefined) s.lastHealth=50;
  return s;
}
function npcLog(npc, tag, msg){
  if(!npc.decisionLog) npc.decisionLog=[];
  npc.decisionLog.unshift({ day:world.day, tag:tag, msg:msg });
  if(npc.decisionLog.length>20) npc.decisionLog.pop();
}


// ══════════════════════════════════════════════════════════════
// 相容性保留函式（供 monitor.js 等外部模組呼叫）
// ══════════════════════════════════════════════════════════════
function npcCanProduceTerminal(npc){
  var map=getTerminalVenueMap();
  var r=[];
  npc.buildings.forEach(function(b){
    if(!b.isCompleted) return;
    var bd=BUILDINGS[b.type];
    if(!bd||isVenueBuilding(bd)||bd.isReceptionCenter) return;
    bd.products&&bd.products.forEach(function(pid){ if(map[pid]) r.push(pid); });
  });
  return r;
}
// npcIsIntermediateGood 保留給其他模組（economy 等）使用
function npcIsIntermediateGood(npc, pid){
  var hasDownstream=npc.buildings.some(function(b){
    if(!b.isCompleted) return false;
    var bd=BUILDINGS[b.type];
    if(!bd||isVenueBuilding(bd)||bd.isReceptionCenter) return false;
    return bd.products&&bd.products.some(function(outPid){
      var p=PRODUCTS[outPid]; return p&&p.inputs&&p.inputs.hasOwnProperty(pid);
    });
  });
  if(!hasDownstream) return false;
  return npcCanSelfProduce(npc, pid);
}

// ══════════════════════════════════════════════════════════════
// 每 tick 執行（round-robin 分批處理所有 NPC）
// ══════════════════════════════════════════════════════════════
var _npcBatchOffset = 0;
var NPC_BATCH_SIZE  = 12;

function tickNPCAI(){
  var allNpcs=world.companies.filter(function(c){ return !c.isPlayer&&!c.bankrupt; });
  var total=allNpcs.length; if(!total) return;

  var start=_npcBatchOffset % total;
  var end=Math.min(start+NPC_BATCH_SIZE, total);
  var batch=allNpcs.slice(start, end);
  if(end-start < NPC_BATCH_SIZE && start > 0){
    batch=batch.concat(allNpcs.slice(0, Math.min(NPC_BATCH_SIZE-(end-start), start)));
  }
  _npcBatchOffset=(start+NPC_BATCH_SIZE) % total;

  batch.forEach(function(npc){
    var state=ensureNpcState(npc);
    // 每天只執行一次日決策
    if(state.lastDecisionDay < world.day){
      npcDailyDecision(npc);
      return;
    }
    // 已執行過：輕量維護（蓄水池補水，門市補貨）
    if(npc.cash > 200){
      npc.buildings.forEach(function(b){
        if(!b.isCompleted||b.productionQueue.length>=2) return;
        if(b.type==="reservoir" && npcNeedsProduction(npc,"water")){
          enqueueProductionNPC(npc,b,"water",6);
        }
      });
    }
    if(world.tick % 6 === 0){
      world.venues.filter(function(v){ return v.companyId===npc.id; }).forEach(function(v){
        Object.keys(v.shelves).forEach(function(pid){ npcRestockVenue(npc,v,pid); });
      });
    }
  });
}

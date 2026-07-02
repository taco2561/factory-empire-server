function tick(){
  world.tick++;
  world.dayTick++;
  world.lastUpdateTime=Date.now();

  // ── Layer 1：建築完工檢查（每 tick）────────────────────────
  world.companies.forEach(function(company){
    company.buildings.forEach(function(b){
      if(!b.isCompleted&&b.endTime<=gameNow()){
        b.isCompleted=true;
        if(company.isPlayer) notify("🏗️ "+BUILDINGS[b.type].emoji+" "+(b.displayName||BUILDINGS[b.type].name)+" 建造完成！", company.id);
      }
    });
  });
  ensureVenues();

  // ── Layer 1：生產完工（每 tick）────────────────────────────
  world.companies.forEach(function(company){
    company.buildings.forEach(function(b){
      if(!b.isCompleted) return;
      var q=b.productionQueue;
      if(q.length>0&&q[0].endTime<=gameNow()){
        var job=q.shift();
        var unitCost=job.amount>0?(job.totalCost||0)/job.amount:0;
        warehouseIn(company,job.product,job.amount,unitCost);
        if(company.isPlayer) notify("📦 "+job.amount+" 件 "+PRODUCTS[job.product].name+" 生產完成！（"+(b.displayName||BUILDINGS[b.type].name)+"）", company.id);

        // ── 循環生產：本輪完成後自動續轉下一輪 ──────────────
        if(job.isAutoRepeat && !job.repeatStopped){
          var nextLeft = job.repeatLeft - 1;
          if(nextLeft > 0){
            var res = tryStartNextRepeatRound(company.id, b.id, job.product, job.amount, nextLeft, job.repeatTotal);
            if(!res.ok){
              // 原料/現金不足 → 不刪除狀態，放入「等待中」標記，下個 tick 再嘗試
              b._pendingRepeat = {
                product: job.product, amount: job.amount,
                repeatLeft: nextLeft, repeatTotal: job.repeatTotal,
              };
              if(company.isPlayer) notify("⏸️ 循環生產暫停等待中（"+PRODUCTS[job.product].name+"）："+res.msg, company.id);
            }
          } else if(company.isPlayer){
            notify("✅ 循環生產完成！"+PRODUCTS[job.product].name+" 共 "+job.repeatTotal+" 輪", company.id);
          }
        } else if(job.isAutoRepeat && job.repeatStopped && company.isPlayer){
          notify("⏹️ 循環生產已停止（"+PRODUCTS[job.product].name+"）", company.id);
        }
      }

      // ── 等待中的循環生產：每 tick 重試一次 ──────────────────
      if(b._pendingRepeat && q.length===0){
        var p=b._pendingRepeat;
        var res2 = tryStartNextRepeatRound(company.id, b.id, p.product, p.amount, p.repeatLeft, p.repeatTotal);
        if(res2.ok){
          b._pendingRepeat = null;
          if(company.isPlayer) notify("▶️ 循環生產恢復："+PRODUCTS[p.product].name, company.id);
        }
      }
    });
  });

  // ── Layer 2：AI（分批 round-robin，每 tick 最多 12 家）────
  tickNPCAI();

  // ── Layer 2：銀行系統（每天執行一次）──────────────────────
  tickBankSystem();
  if(world.dayTick===1){
    world.companies.filter(function(c){ return !c.isPlayer&&!c.bankrupt; }).forEach(function(npc){
      npcEvaluateLoan(npc);
    });
  }

  // ── Layer 2：經濟統計（每 5 tick，開銷最大的彙算）──────────
  if(world.tick % 5 === 0){
    var totalWorkers=world.companies.reduce(function(s,c){
      return s+c.buildings.filter(function(b){ return b.isCompleted; }).reduce(function(s2,b){ return s2+BUILDINGS[b.type].workers; },0);
    },0);
    world.economyState.totalWorkers=totalWorkers;
    world.economyState.gdp=Object.values(world.market).reduce(function(s,m){ return s+m.trades*m.price; },0);
    world.economyState.moneySupply=world.companies.reduce(function(s,c){ return s+c.cash; },0);
    world.economyState.employeeWallet=EMPLOYEE_WALLET;
    if(world.economyState.lastGdp===undefined) world.economyState.lastGdp=world.economyState.gdp;
  }

  // ── Layer 2：消費者 + 央行（每 tick）──────────────────────
  tickConsumers();
  tickBank();   // 新景氣指數計算（每 tick 更新 totalMarketVolume，tickBank 每天末結算）

  // ── v0.3：接待中心 tick ──────────────────────────────────
  tickReception();

  // ── 市場庫存快取 + 市場價格 V2（每 5 tick）────────────────
  if(world.tick % 5 === 0){
    updateMarketInventory(); // 先更新庫存
    tickMarketPrices();      // 再用庫存計算價格
  }

  if(world.dayTick>=20){
    world.dayTick=0; world.day++;
    generateMonitorReport();
    tickStockSystem();
    tickGovernmentSystem();
    tickProsperitySubsidy();   // 每天依景氣發放員工補助
    if(world.day % 8 === 0){
      generateDailyNews();
    }
  }

  saveWorld();
}

// ── 理想庫存表（V2 供需系統基準）────────────────────────────
var IDEAL_STOCK = {
  water:200, power:150, seeds:100,
  apple:120, grape:100,
  feed:80, pig:40, cow:30, chicken:50,
  porkchop:60, beefsteak:40, chicken_steak:50,
  cloth:60, leather:40, shirt:50, pants:50, shoes:40,
  limestone:80, clay:80, cement:50, brick:50, reinforced_concrete:30,
  // ── v0.4 新增：礦業、材料、電子產業 ──
  iron_ore:80, copper_ore:70, aluminum_ore:60, lithium_ore:40, silica_sand:70, crude_oil:60,
  silicon_wafer:30, plastic:60, chemicals:50, steel:50,
  battery:35, pcb:35, cpu:20, memory:20, display:25, power_supply:30,
  smartphone:20, computer:15, television:15,
};
function getIdealStock(pid){ return IDEAL_STOCK[pid]||60; }

// ── 市場價格 V2：EMA 供需 + 庫存修正 + 平滑趨近 ────────────
function tickMarketPrices(){
  var EMA_ALPHA   = 0.12;  // EMA 平滑因子（越大反應越快）
  var SMOOTH      = 0.05;  // 目標價格趨近速度
  var MEAN_REVERT = 0.02;  // 無交易時向基礎價格回歸速度

  Object.values(world.market).forEach(function(m){
    var pid       = m.productId;
    var base      = PRODUCTS[pid].basePrice;
    var tickBuy   = m.thisTickBuy  || 0;
    var tickSell  = m.thisTickSell || 0;

    // Step 1：更新 EMA（每次呼叫都更新，即使成交量為 0）
    m.buyEMA  = (m.buyEMA  || 0) * (1-EMA_ALPHA) + tickBuy  * EMA_ALPHA;
    m.sellEMA = (m.sellEMA || 0) * (1-EMA_ALPHA) + tickSell * EMA_ALPHA;

    // 清零本 tick 計數（下一輪重新累計）
    m.thisTickBuy  = 0;
    m.thisTickSell = 0;

    var hasActivity = (m.buyEMA > 0.01 || m.sellEMA > 0.01);

    if(!hasActivity){
      // 無交易：緩慢回歸基礎價格
      m.price += (base - m.price) * MEAN_REVERT;
    } else {
      // Step 2：需求因子（買/賣 EMA 比值，clamp 避免極端值）
      var rawDemand   = m.buyEMA / Math.max(m.sellEMA, 0.01);
      var demandFactor = Math.min(1.3, Math.max(0.7, rawDemand));

      // Step 3：庫存因子（市場庫存 vs 理想庫存，clamp 避免暴漲）
      var stock       = m.marketStock || 0;
      var idealStock  = getIdealStock(pid);
      var rawStock    = idealStock / Math.max(stock, 1);
      var stockFactor = Math.min(1.2, Math.max(0.8, rawStock));

      // Step 4：計算目標價格
      var targetPrice = base * demandFactor * stockFactor;

      // Step 5：平滑移動（每次只接近目標的 SMOOTH 比例）
      m.price += (targetPrice - m.price) * SMOOTH;
    }

    // Step 6：硬性上下限（最重要的防暴漲機制）
    m.price = Math.min(base * 2.0, Math.max(base * 0.5, m.price));

    // Step 7：更新 priceHistory 與相容欄位
    m.priceHistory.push(m.price);
    if(m.priceHistory.length > 60) m.priceHistory.shift();

    // 更新相容欄位（部分 UI 仍使用 demand/supply 顯示）
    m.demand = m.buyEMA  * 10 + 20;
    m.supply = m.sellEMA * 10 + 20;

    // Step 8：NPC 平衡訊號（更新市場庫存快取）
    m.marketStock = world.marketInventory ? (world.marketInventory[pid]||0) : stock;
  });
}
function updateMarketInventory(){
  var inv = {};
  Object.keys(PRODUCTS).forEach(function(pid){ inv[pid] = 0; });
  world.companies.forEach(function(c){
    Object.keys(PRODUCTS).forEach(function(pid){
      inv[pid] += (c.warehouse[pid]||0);
    });
  });
  world.marketInventory = inv;
}

// ── 量化寬鬆政策（QE）────────────────────────────────────────
// 蕭條：注入量 = 流通貨幣×2% + 政府餘額×8%
// 平穩：注入量 = 流通貨幣×8% + 政府餘額×2%
// 資金來源：優先從政府財政扣，不足則發行國債（印鈔）
function tickProsperitySubsidy(){
  var econ = world.economyState;
  var pi   = econ.prosperityIndex;
  if(pi === 1) return; // 繁榮期不干預

  var gov = ensureGovernment();

  // 流通貨幣總量（所有公司現金 + 員工錢包）
  var moneySupply = world.companies.reduce(function(s,c){ return s+c.cash; },0) + EMPLOYEE_WALLET;

  // 依景氣狀態計算兩部分注入量
  var moneyRatio, govRatio, label, typeLabel;
  if(pi === -1){
    // 蕭條：流通貨幣×2% + 政府餘額×8%
    moneyRatio = 0.02;
    govRatio   = 0.08;
    label      = "🔴 蕭條";
    typeLabel  = "QE 蕭條（流通×2%＋財政×8%）";
  } else {
    // 平穩：流通貨幣×8% + 政府餘額×2%（注：原需求較低時也刺激）
    moneyRatio = 0.008;
    govRatio   = 0.02;
    label      = "🟡 平穩";
    typeLabel  = "QE 平穩（流通×0.8%＋財政×2%）";
  }

  var poolFromMoney = Math.floor(moneySupply * moneyRatio); // 流通貨幣部分
  var poolFromGov   = Math.floor((gov.treasury||0) * govRatio); // 政府財政部分
  var pool = poolFromMoney + poolFromGov;
  if(pool < 1) return;

  // 政府財政部分直接從財政扣除
  var actualFromGov = Math.min(poolFromGov, Math.max(0, gov.treasury));
  var shortfall     = poolFromGov - actualFromGov; // 財政不足的缺口
  // 流通貨幣部分 + 財政不足部分 → 發行國債（印鈔）
  var printed = poolFromMoney + shortfall;

  if(actualFromGov > 0){
    gov.treasury  -= actualFromGov;
    gov.totalSpent+= actualFromGov;
  }

  // 注入員工錢包
  EMPLOYEE_WALLET += pool;

  // 記錄日誌
  if(!gov.subsidyLog) gov.subsidyLog=[];
  gov.subsidyLog.unshift({
    day:          world.day,
    amount:       pool,
    fromMoney:    poolFromMoney,
    fromGov:      actualFromGov,
    printed:      printed,
    type:         typeLabel,
    treasuryAfter:gov.treasury,
  });
  if(gov.subsidyLog.length>30) gov.subsidyLog.pop();

  var srcLabel = "流通貨幣部分 "+money(poolFromMoney)+
    "＋財政 "+money(actualFromGov)+
    (printed>poolFromMoney?"＋國債(印鈔) "+money(shortfall):"");
  notify("🏛️ QE（"+label+"）：注入 "+money(pool)+" → 員工錢包（"+srcLabel+"）");
}

function warehouseValue(company){
  return Object.entries(company.warehouse).reduce(function(s,e){ return s+e[1]*(world.market[e[0]]?world.market[e[0]].price:0); },0);
}

// 庫存成本總額（加權平均成本，不使用市場價格）
function warehouseCostTotal(company){
  return Object.values(company.warehouseCost||{}).reduce(function(s,v){ return s+v; },0);
}

// 建築帳面價值（實際建造成本，無折舊）
function companyBuildingValue(company){
  return company.buildings.reduce(function(s,b){ return s+(b.purchaseCost||0); },0);
}

// 排行榜專用：現金 + 建築價值 + 庫存成本 + 存款 - 未償還貸款（不使用市場價格）
function companyBookValue(company){
  return company.cash
    + companyBuildingValue(company)
    + warehouseCostTotal(company)
    + totalDepositValue(company)
    - totalLoanOutstanding(company);
}

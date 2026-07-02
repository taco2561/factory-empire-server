// ══════════════════════════════════════════════════════════════
// 政府系統 V1.0
// 財政收入：所有建築費用流入政府財政
// 政府訂單：根據景氣狀況每天在遊戲 0 點產生採購訂單
// ══════════════════════════════════════════════════════════════

var GOV_ORDER_EXPIRY_DAYS  = 3;   // 訂單若 N 天未成交自動失效
var GOV_BUDGET_RECESSION   = 0.08; // 蕭條：財政 8% 用於採購
var GOV_BUDGET_NORMAL      = 0.02; // 平穩：財政 2% 用於採購
var GOV_ORDERS_RECESSION   = 8;    // 蕭條：每天 8 張訂單
var GOV_ORDERS_NORMAL      = 2;    // 平穩：每天 2 張訂單
var GOV_PRICE_PREMIUM      = 1.15; // 政府採購溢價（比基礎價高 15%）

// ── 確保 world.government 存在 ─────────────────────────────
function ensureGovernment(){
  if(!world.government) world.government={
    treasury:    0,
    totalCollected: 0,
    totalSpent:  0,
    orders:      [],
    orderHistory:[],
    dailyStats:  { collected:0, spent:0, ordersIssued:0 },
    subsidyLog:  [],
    // ── 選舉系統 ──────────────────────────────────────────
    election:{
      phase:       "none",   // "register"|"vote"|"result"|"none"
      cycleStart:  -1,       // 本選舉週期的第一天（登記第一天）
      candidates:  [],       // [{companyId,name,isPlayer,deposit}]
      votes:       {},       // {voterCompanyId: candidateCompanyId}
      results:     [],       // [{companyId,name,votes}]（開票後填入）
    },
    // ── 部長 ──────────────────────────────────────────────
    minister:{
      companyId:   null,
      name:        "（尚未選出）",
      isPlayer:    false,
      termStart:   0,
      termEnd:     0,
      lastPolicyDay: -1,
    },
    // ── 現行政策 ──────────────────────────────────────────
    activePolicy:{
      type:    null,    // "labor"|"consume"|"produce"|null
      label:   "無",
      startDay:0,
      endDay:  0,
      lastType:null,    // 上一次政策（不可連發同類）
    },
    // ── 國債系統 ──────────────────────────────────────────
    bonds:        [],   // 進行中（含募集期）的國債 [{id,issueDay,subscribeEndDay,totalAmount,remainingAmount,interestRate,duration,status,holders}]
    bondHistory:  [],   // 已結束（還清利息）的國債
    lowCashStreak: 0,   // 財政餘額低於門檻的連續天數計數
  };
  var g=world.government;
  if(!g.subsidyLog)   g.subsidyLog=[];
  if(!g.election)     g.election={phase:"none",cycleStart:-1,candidates:[],votes:{},results:[]};
  if(!g.minister)     g.minister={companyId:null,name:"（尚未選出）",isPlayer:false,termStart:0,termEnd:0,lastPolicyDay:-1};
  if(!g.activePolicy) g.activePolicy={type:null,label:"無",startDay:0,endDay:0,lastType:null};
  if(!g.bonds)         g.bonds=[];
  if(!g.bondHistory)   g.bondHistory=[];
  if(g.lowCashStreak===undefined) g.lowCashStreak=0;
  return world.government;
}

// ══════════════════════════════════════════════════════════════
// 一、財政收入：建築費用流入政府
// 在 startBuilding 呼叫後由 economy.js 透過此函式通知
// ══════════════════════════════════════════════════════════════
function govCollectBuildingFee(amount){
  var gov=ensureGovernment();
  gov.treasury         += amount;
  gov.totalCollected   += amount;
  gov.dailyStats.collected += amount;
}

// ══════════════════════════════════════════════════════════════
// 二、政府訂單生成（每天 0 點）
// ══════════════════════════════════════════════════════════════
function govGenerateOrders(){
  var gov=ensureGovernment();
  var econ=world.economyState;
  var prosperity=econ.prosperityIndex; // -1:蕭條, 0:平穩, 1:繁榮

  // 繁榮期不生成訂單
  if(prosperity===1) return;

  var orderCount = prosperity===-1 ? GOV_ORDERS_RECESSION : GOV_ORDERS_NORMAL;
  var budgetRatio = prosperity===-1 ? GOV_BUDGET_RECESSION : GOV_BUDGET_NORMAL;
  var totalBudget = Math.floor(gov.treasury * budgetRatio);

  if(totalBudget<10||gov.treasury<10) return; // 財政不足不採購

  var budgetPerOrder = Math.floor(totalBudget / orderCount);
  if(budgetPerOrder<5) return;

  // 清除過期訂單
  gov.orders = gov.orders.filter(function(o){
    return o.expiresDay > world.day;
  });

  // 選擇採購商品：庫存低的優先，供過於求的排除
  var candidates = Object.values(PRODUCTS).filter(function(p){
    var pid=p.id;
    var stock=world.marketInventory?world.marketInventory[pid]||0:0;
    var ideal=getIdealStock(pid);
    // 供過於求（超過理想庫存 150%）的不採購
    if(stock>ideal*1.5) return false;
    // 沒有基礎價格的跳過
    if(!p.basePrice||p.basePrice<=0) return false;
    return true;
  }).map(function(p){
    var pid=p.id;
    var stock=world.marketInventory?world.marketInventory[pid]||0:0;
    var ideal=getIdealStock(pid);
    // 庫存越低，優先度越高
    var scarcityScore = ideal/(Math.max(stock,1));
    return { pid:pid, basePrice:p.basePrice, scarcityScore:scarcityScore };
  }).sort(function(a,b){ return b.scarcityScore-a.scarcityScore; });

  if(!candidates.length) return;

  var issued=0;
  for(var i=0;i<orderCount;i++){
    var c=candidates[i%candidates.length];
    var pricePerUnit=Math.round(c.basePrice * GOV_PRICE_PREMIUM);
    var qty=Math.max(1, Math.floor(budgetPerOrder/pricePerUnit));
    if(qty<1||pricePerUnit<1) continue;

    var order={
      id:         uid(),
      pid:        c.pid,
      qty:        qty,
      pricePerUnit:pricePerUnit,
      budget:     qty*pricePerUnit,
      day:        world.day,
      expiresDay: world.day+GOV_ORDER_EXPIRY_DAYS,
      filled:     0,        // 已成交數量
      filledBy:   [],       // [{companyId, qty, revenue}]
      status:     "open",   // open / partial / filled / expired
    };
    gov.orders.push(order);
    issued++;
  }

  gov.dailyStats.ordersIssued=issued;
  var label = prosperity===-1?"蕭條":"平穩";
  notify("🏛️ 政府（"+label+"期）發布 "+issued+" 張採購訂單，總預算 "+money(totalBudget));
}

// ══════════════════════════════════════════════════════════════
// 三、履行政府訂單（公司送交商品，政府付款）
// ══════════════════════════════════════════════════════════════
function govFulfillOrder(orderId, companyId, qty){
  var gov=ensureGovernment();
  var order=gov.orders.find(function(o){ return o.id===orderId; });
  if(!order||order.status==="filled"||order.status==="expired")
    return { ok:false, reason:"訂單不存在或已結束" };

  var company=world.companies.find(function(c){ return c.id===companyId; });
  if(!company) return { ok:false, reason:"公司不存在" };

  var available=order.qty-order.filled;
  if(available<=0) return { ok:false, reason:"訂單已滿" };

  var actualQty=Math.min(qty, available);
  // 確認公司有足夠庫存
  if((company.warehouse[order.pid]||0)<actualQty)
    return { ok:false, reason:"庫存不足（需 "+actualQty+" 件 "+order.pid+"）" };

  var revenue=actualQty*order.pricePerUnit;
  if(gov.treasury<revenue) return { ok:false, reason:"政府財政不足" };

  // 執行交易
  warehouseOut(company, order.pid, actualQty);
  company.cash+=revenue;
  if(typeof recordRevenue==="function") recordRevenue(company, revenue);
  else if(company.finance) company.finance.revenue=(company.finance.revenue||0)+revenue;
  trackActivity(company, order.pid, "sell", actualQty);

  gov.treasury-=revenue;
  gov.totalSpent+=revenue;
  gov.dailyStats.spent=(gov.dailyStats.spent||0)+revenue;

  order.filled+=actualQty;
  order.filledBy.push({ companyId:companyId, name:company.name, qty:actualQty, revenue:revenue });
  if(order.filled>=order.qty) order.status="filled";
  else order.status="partial";

  if(company.isPlayer)
    notify("🏛️ 政府訂單成交！交付 "+PRODUCTS[order.pid].emoji+" "+order.pid+" ×"+actualQty+"，獲得 "+money(revenue));

  return { ok:true, revenue:revenue, qty:actualQty };
}

// ══════════════════════════════════════════════════════════════
// 四、AI 自動參與政府訂單
// ══════════════════════════════════════════════════════════════
function govNpcFulfillOrders(){
  var gov=ensureGovernment();
  if(!gov.orders.length) return;

  world.companies.filter(function(c){ return !c.isPlayer&&!c.bankrupt; }).forEach(function(npc){
    gov.orders.forEach(function(order){
      if(order.status==="filled"||order.status==="expired") return;
      var have=npc.warehouse[order.pid]||0;
      if(have<1) return;
      var tgt=getTargetInventory?getTargetInventory(order.pid):30;
      // 只賣超過目標庫存的部分（保留自用）
      var sellable=Math.max(0, have-Math.floor(tgt*0.5));
      if(sellable<1) return;
      var qty=Math.min(sellable, order.qty-order.filled);
      if(qty<1) return;
      govFulfillOrder(order.id, npc.id, qty);
    });
  });
}

// ══════════════════════════════════════════════════════════════
// 五、每天結束時執行（由 game-loop 呼叫）
// ══════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════
// 部長選舉系統
// ══════════════════════════════════════════════════════════════

var GOV_ELECTION_CYCLE   = 14;  // 選舉週期（天）
var GOV_REGISTER_DAYS    = 2;   // 競選登記持續天數（第14~15天）
var GOV_VOTE_DAY_OFFSET  = 2;   // 投票在週期第幾天（0=第一天）
var GOV_RESULT_DAY_OFFSET= 3;   // 開票在週期第幾天
var GOV_POLICY_INTERVAL  = 7;   // 部長每幾天可發一次政策
var GOV_POLICY_DURATION  = 7;   // 政策持續天數
var GOV_DEPOSIT_RATIO    = 0.20; // 競選保證金 = 公司平均現金 × 20%

// 政策定義（集中管理）
var GOV_POLICIES = {
  labor:   { type:"labor",   label:"勞工補助",  desc:"企業薪資降低20%，差額由財政補貼",   icon:"👷" },
  consume: { type:"consume", label:"消費刺激",  desc:"員工需求提高20%，NPC購買力增加",    icon:"🛍️" },
  produce: { type:"produce", label:"生產加速",  desc:"所有商品生產速度提高20%（縮短時間）", icon:"⚙️" },
};

// ── 計算競選保證金 ──────────────────────────────────────────
function govCalcDeposit(){
  var alive=world.companies.filter(function(c){ return !c.bankrupt; });
  if(!alive.length) return 500;
  var avgCash=alive.reduce(function(s,c){ return s+c.cash; },0)/alive.length;
  return Math.max(100, Math.floor(avgCash * GOV_DEPOSIT_RATIO));
}

// ── 競選登記（玩家呼叫或 AI 自動）─────────────────────────
function govRegisterCandidate(companyId){
  var gov=ensureGovernment();
  var el=gov.election;
  if(el.phase!=="register") return {ok:false,reason:"現在不是登記期"};
  if(el.candidates.some(function(c){ return c.companyId===companyId; }))
    return {ok:false,reason:"已登記"};
  var company=world.companies.find(function(c){ return c.id===companyId; });
  if(!company||company.bankrupt) return {ok:false,reason:"公司不存在或已破產"};
  var deposit=govCalcDeposit();
  if(company.cash<deposit) return {ok:false,reason:"現金不足（需 "+money(deposit)+"）"};
  company.cash    -= deposit;
  gov.treasury    += deposit; // 保證金進財政
  gov.totalCollected+=deposit;
  el.candidates.push({ companyId:companyId, name:company.name, isPlayer:company.isPlayer, deposit:deposit });
  notify("🗳️ "+company.name+" 登記參選部長！保證金 "+money(deposit));
  return {ok:true,deposit:deposit};
}

// ── 投票（玩家呼叫或 AI 自動）──────────────────────────────
function govCastVote(voterCompanyId, candidateCompanyId){
  var gov=ensureGovernment();
  var el=gov.election;
  if(el.phase!=="vote") return {ok:false,reason:"現在不是投票期"};
  var isCandidate=el.candidates.some(function(c){ return c.companyId===candidateCompanyId; });
  if(!isCandidate) return {ok:false,reason:"該公司不是候選人"};
  el.votes[voterCompanyId]=candidateCompanyId;
  return {ok:true};
}

// ── AI 自動參選決策 ─────────────────────────────────────────
function govNpcAutoRegister(){
  var gov=ensureGovernment(); var el=gov.election;
  var deposit=govCalcDeposit();
  world.companies.filter(function(c){ return !c.isPlayer&&!c.bankrupt; }).forEach(function(npc){
    if(el.candidates.some(function(x){ return x.companyId===npc.id; })) return;
    // AI 只有在現金充裕時才參選（保證金不能影響運營）
    var dailyWage=npc.buildings.filter(function(b){return b.isCompleted;}).reduce(function(s,b){
      return s+(BUILDINGS[b.type]||{workers:0}).workers*1.5;},0);
    var safeReserve=Math.max(dailyWage*7,500);
    if(npc.cash >= deposit + safeReserve){
      // ~30% 機率參選（避免所有 AI 都搶著參選）
      if(Math.random()<0.30) govRegisterCandidate(npc.id);
    }
  });
}

// ── AI 自動投票邏輯（依自身利益選最有利候選人）──────────────
function govNpcAutoVote(){
  var gov=ensureGovernment(); var el=gov.election;
  if(!el.candidates.length) return;
  // 修復：只讓 AI 自動投票，玩家保留自主選擇
  world.companies.filter(function(c){ return !c.isPlayer&&!c.bankrupt; }).forEach(function(npc){
    if(el.votes[npc.id]) return;
    var needScore={ labor:0, consume:0, produce:0 };
    var dailyWage=npc.buildings.filter(function(b){return b.isCompleted;}).reduce(function(s,b){
      return s+(BUILDINGS[b.type]||{workers:0}).workers*1.5;},0);
    needScore.labor += dailyWage>0?dailyWage/Math.max(npc.cash,1)*50:0;
    var overstock=Object.keys(npc.warehouse||{}).reduce(function(s,pid){
      var qty=npc.warehouse[pid]||0; return s+(qty>40?qty-40:0);},0);
    needScore.consume += Math.min(50,overstock*0.5);
    var idleBldgs=npc.buildings.filter(function(b){
      var bd=BUILDINGS[b.type];
      return b.isCompleted&&bd&&!bd.isSupermarket&&!bd.isRestaurant&&!bd.isClothingStore&&b.productionQueue.length<1;
    }).length;
    needScore.produce += idleBldgs*10;
    var scoredCandidates=el.candidates.map(function(cand){
      var score=Math.random()*10; if(!cand.isPlayer) score+=5;
      return {companyId:cand.companyId,score:score};
    }).sort(function(a,b){return b.score-a.score;});
    if(scoredCandidates.length) govCastVote(npc.id,scoredCandidates[0].companyId);
  });
}

// ── 開票 ───────────────────────────────────────────────────
function govCountVotes(){
  var gov=ensureGovernment(); var el=gov.election;
  var tally={};
  el.candidates.forEach(function(c){ tally[c.companyId]=0; });
  Object.values(el.votes).forEach(function(cid){ if(tally.hasOwnProperty(cid)) tally[cid]++; });
  var sorted=el.candidates.map(function(c){
    return {companyId:c.companyId,name:c.name,isPlayer:c.isPlayer,votes:tally[c.companyId]||0};
  }).sort(function(a,b){ return b.votes-a.votes; });
  el.results=sorted;
  if(!sorted.length){
    // 無候選人 → 上任連任
    if(gov.minister.companyId){
      gov.minister.termEnd=world.day+GOV_ELECTION_CYCLE;
      notify("🏛️ 無候選人報名，"+gov.minister.name+" 自動連任");
    }
    return;
  }
  // 找最高票（可能同票）
  var maxVotes=sorted[0].votes;
  var winners=sorted.filter(function(c){ return c.votes===maxVotes; });
  var winner=winners[Math.floor(Math.random()*winners.length)]; // 同票隨機抽
  // 就任部長
  gov.minister={
    companyId:   winner.companyId,
    name:        winner.name,
    isPlayer:    winner.isPlayer,
    termStart:   world.day,
    termEnd:     world.day+GOV_ELECTION_CYCLE,
    lastPolicyDay:-1,
  };
  notify("🎉 選舉結果："+winner.name+" 當選部長！（得票 "+winner.votes+" 票）任期至第 "+gov.minister.termEnd+" 天");
}

// ── 發布政策（部長呼叫）────────────────────────────────────
function govIssuePolicy(policyType, companyId){
  var gov=ensureGovernment();
  if(gov.minister.companyId!==companyId) return {ok:false,reason:"你不是部長"};
  if(!GOV_POLICIES[policyType]) return {ok:false,reason:"無效政策類型"};
  if(gov.minister.lastPolicyDay>=0 && world.day-gov.minister.lastPolicyDay<GOV_POLICY_INTERVAL)
    return {ok:false,reason:"政策發布冷卻中（還需 "+(GOV_POLICY_INTERVAL-(world.day-gov.minister.lastPolicyDay))+" 天）"};
  if(gov.activePolicy.lastType===policyType)
    return {ok:false,reason:"不可連續發布同一政策"};
  var pol=GOV_POLICIES[policyType];
  gov.activePolicy={type:policyType,label:pol.label,icon:pol.icon,desc:pol.desc,startDay:world.day,endDay:world.day+GOV_POLICY_DURATION,lastType:policyType};
  gov.minister.lastPolicyDay=world.day;
  notify("📜 部長 "+gov.minister.name+" 發布政策："+pol.icon+" "+pol.label+"（持續 "+GOV_POLICY_DURATION+" 天）");
  return {ok:true};
}

// ── AI 部長自動決策 ─────────────────────────────────────────
function govAiMinisterPolicy(){
  var gov=ensureGovernment();
  var m=gov.minister;
  if(!m.companyId||m.isPlayer) return; // 玩家部長自己決定
  if(m.lastPolicyDay>=0 && world.day-m.lastPolicyDay<GOV_POLICY_INTERVAL) return; // 冷卻中
  var econ=world.economyState;
  var eic=econ.eiComponents||{};
  var diag=econ.eiDiagnosis||{};
  // 決策邏輯：依經濟狀況選最適政策
  var scores={ labor:0, consume:0, produce:0 };
  // 需求不足 → 消費刺激
  var demandScore=eic.demand||50;
  if(demandScore<40) scores.consume+=40-demandScore;
  if(diag.demand&&diag.demand.diags) diag.demand.diags.forEach(function(d){ if(d.key==="sold"||d.key==="venue") scores.consume+=d.penalty||10; });
  // 企業虧損/薪資重 → 勞工補助
  var bizScore=eic.business||50;
  if(bizScore<40) scores.labor+=40-bizScore;
  var lossRate=(diag.business&&diag.business.lossRate)||0;
  if(lossRate>0.3) scores.labor+=lossRate*60;
  // 供給不足/生產停滯 → 生產加速
  var alive=world.companies.filter(function(c){return !c.bankrupt;});
  var idleRatio=alive.reduce(function(s,c){
    var cp=c.buildings.filter(function(b){var bd=BUILDINGS[b.type];return b.isCompleted&&bd&&!bd.isSupermarket&&!bd.isRestaurant&&!bd.isClothingStore;});
    return s+(cp.length>0?cp.filter(function(b){return b.productionQueue.length<1;}).length/cp.length:0);
  },0)/(alive.length||1);
  if(idleRatio>0.4) scores.produce+=idleRatio*50;
  // 排除上一次政策
  if(gov.activePolicy.lastType) scores[gov.activePolicy.lastType]=-9999;
  var best=Object.keys(scores).sort(function(a,b){return scores[b]-scores[a];})[0];
  govIssuePolicy(best, m.companyId);
}

// ── 每日選舉週期判斷 ────────────────────────────────────────
function govTickElection(){
  var gov=ensureGovernment();
  var el=gov.election;
  var day=world.day;

  // 判斷本天在14天週期中的位置
  // 第一次選舉從第 14 天開始（遊戲足夠穩定）
  if(day<14) return;
  var cycleDay=(day-14)%GOV_ELECTION_CYCLE;

  // ── 登記期開始（cycleDay 0）─────────────────────────────
  if(cycleDay===0){
    el.phase="register";
    el.cycleStart=day;
    el.candidates=[];
    el.votes={};
    el.results=[];
    var dep=govCalcDeposit();
    notify("🗳️ 部長選舉登記開始！今明兩天可報名參選（保證金 "+money(dep)+"）");
    govNpcAutoRegister(); // AI 自動評估是否參選
    return;
  }
  // ── 登記第2天（cycleDay 1）──────────────────────────────
  if(cycleDay===1 && el.phase==="register"){
    govNpcAutoRegister(); // 第2天再讓 AI 補報
    return;
  }
  // ── 投票日（cycleDay 2）─────────────────────────────────
  if(cycleDay===2){
    if(!el.candidates.length){
      // 無候選人 → 連任
      if(gov.minister.companyId){
        gov.minister.termEnd=day+GOV_ELECTION_CYCLE;
        notify("🏛️ 無候選人，"+gov.minister.name+" 自動連任至第 "+gov.minister.termEnd+" 天");
      }
      el.phase="none";
      return;
    }
    el.phase="vote";
    notify("🗳️ 投票開始！候選人："+el.candidates.map(function(c){return c.name;}).join("、"));
    govNpcAutoVote(); // AI 自動投票
    return;
  }
  // ── 開票日（cycleDay 3）─────────────────────────────────
  if(cycleDay===3 && el.phase==="vote"){
    el.phase="result";
    govCountVotes();
    return;
  }
  // ── 任期結束後重置為 none ────────────────────────────────
  if(cycleDay===4) el.phase="none";

  // ── 部長任內政策發布（每7天）────────────────────────────
  var m=gov.minister;
  if(m.companyId && day<=m.termEnd){
    if(m.lastPolicyDay<0 || day-m.lastPolicyDay>=GOV_POLICY_INTERVAL){
      govAiMinisterPolicy();
    }
  }
}

// ── 政策到期處理 ────────────────────────────────────────────
function govTickPolicy(){
  var gov=ensureGovernment();
  var ap=gov.activePolicy;
  if(ap.type && world.day>ap.endDay){
    notify("📜 政策「"+ap.label+"」已到期失效");
    ap.type=null; ap.label="無"; ap.startDay=0; ap.endDay=0;
  }
}

// ── 取得當前政策效果倍率（供其他模組呼叫）──────────────────
function govPolicyEffect(type){
  // type: "wageReduction"|"demandBoost"|"produceSpeed"
  var gov=ensureGovernment();
  var ap=gov.activePolicy;
  if(!ap.type||world.day>ap.endDay) return 1.0;
  if(type==="wageReduction" && ap.type==="labor")   return 0.80; // 薪資降20%
  if(type==="demandBoost"   && ap.type==="consume") return 1.20; // 需求+20%
  if(type==="produceSpeed"  && ap.type==="produce") return 0.80; // 生產時間×0.8
  return 1.0;
}

// ══════════════════════════════════════════════════════════════
// 國債發行與償還系統（Government Bond）
// ══════════════════════════════════════════════════════════════

var BOND_TRIGGER_THRESHOLD = 200000; // 財政餘額低於此值觸發發行
var BOND_TRIGGER_DAYS      = 2;      // 連續低於門檻天數
var BOND_TOTAL_CAP         = 500000; // 第四項限制：財政+流通貨幣 需低於此值才允許發行
var BOND_SUPPLY_MULTIPLIER = 8;      // 發行金額 = 流通貨幣 × 8（規格固定值，不得修改）
var BOND_SUBSCRIBE_DAYS    = 1;      // 募集期間（天）
var BOND_INTEREST_RATE     = 0.03;   // 總利息率（整筆，非日利率）
var BOND_DURATION_DAYS     = 30;     // 利息發放天數
var BOND_GOV_SHARE         = 0.20;   // 利息：政府財政負擔比例
var BOND_CB_SHARE          = 0.80;   // 利息：央行印鈔負擔比例

// ── 計算目前流通貨幣總額（所有公司現金 + 員工錢包）─────────
function govCalcMoneySupply(){
  return world.companies.reduce(function(s,c){ return s+(c.cash||0); },0) + (EMPLOYEE_WALLET||0);
}

// ── 一、判斷是否該發行新國債 ─────────────────────────────────
// 四項條件需同時成立（AND）：
//   1. government.cash < 200,000
//   2. 連續低於門檻 2 個遊戲天
//   3. 沒有進行中的國債（募集中或計息中）
//   4. government.cash + totalMoneySupply < 500,000（流動性限制，避免市場資金仍充足時過早發債）
function govCheckBondTrigger(){
  var gov=ensureGovernment();
  // 條件3：已有進行中的國債（募集中或計息中）→ 不再發行新的
  var hasActive=gov.bonds.some(function(b){ return b.status==="subscribing"||b.status==="active"; });
  if(hasActive){ gov.lowCashStreak=0; return; }

  // 條件1：財政餘額是否低於門檻
  if(gov.treasury < BOND_TRIGGER_THRESHOLD){
    gov.lowCashStreak=(gov.lowCashStreak||0)+1;
  } else {
    gov.lowCashStreak=0;
  }

  // 條件2：連續天數是否達標
  if(gov.lowCashStreak < BOND_TRIGGER_DAYS) return;

  // 條件4：財政＋流通貨幣總額是否低於上限（流動性限制，最後一道把關，優先級最高）
  var totalMoneySupply=govCalcMoneySupply();
  if(gov.treasury + totalMoneySupply >= BOND_TOTAL_CAP){
    // 市場流動性仍充足，即使前三項都成立也不得發行；不重置 streak，等下次再檢查
    return;
  }

  // 四項條件全數成立 → 發行國債
  govIssueBond();
  gov.lowCashStreak=0;
}

// ── 二、發行新國債（金額 = 流通貨幣 × 8）────────────────────
function govIssueBond(){
  var gov=ensureGovernment();
  var moneySupply=govCalcMoneySupply();
  var bondAmount=Math.floor(moneySupply*BOND_SUPPLY_MULTIPLIER);
  if(bondAmount<=0) return;

  var bond={
    id:              uid(),
    issueDay:        world.day,
    subscribeEndDay: world.day+BOND_SUBSCRIBE_DAYS,
    totalAmount:     bondAmount,
    remainingAmount: bondAmount,
    interestRate:    BOND_INTEREST_RATE,
    duration:        BOND_DURATION_DAYS,
    status:          "subscribing", // subscribing|active|closed
    holders:         [],            // [{ownerId,ownerType,principal,totalInterest,remainingInterest,dailyInterest,paidDays}]
  };
  gov.bonds.push(bond);
  notify("🏛️ 政府發行國債！募集總額 "+money(bondAmount)+"（流通貨幣×8），募集期 1 天，利率 3%／30天");

  // AI 立即評估認購（玩家可在募集期內自行認購）
  govNpcSubscribeBond(bond);
}

// ── 三、認購國債（玩家/AI 共用）──────────────────────────────
function govSubscribeBond(bondId, buyerCompanyId, amount){
  var gov=ensureGovernment();
  var bond=gov.bonds.find(function(b){ return b.id===bondId; });
  if(!bond||bond.status!=="subscribing") return {ok:false,reason:"此國債不在募集期"};
  if(amount<=0) return {ok:false,reason:"認購金額需大於0"};
  var buyer=world.companies.find(function(c){ return c.id===buyerCompanyId; });
  if(!buyer||buyer.bankrupt) return {ok:false,reason:"公司不存在或已破產"};
  if(buyer.cash<amount) return {ok:false,reason:"現金不足"};

  var actualAmount=Math.min(amount, bond.remainingAmount);
  if(actualAmount<=0) return {ok:false,reason:"國債已售罄"};

  buyer.cash -= actualAmount;
  bond.remainingAmount -= actualAmount;

  var totalInterest=actualAmount*bond.interestRate;
  var existing=bond.holders.find(function(h){ return h.ownerId===buyerCompanyId; });
  if(existing){
    existing.principal += actualAmount;
    existing.totalInterest += totalInterest;
    existing.remainingInterest += totalInterest;
    existing.dailyInterest = existing.totalInterest/bond.duration;
  } else {
    bond.holders.push({
      ownerId:  buyerCompanyId,
      ownerType:buyer.isPlayer?"player":"company",
      name:     buyer.name,
      principal:actualAmount,
      totalInterest:    totalInterest,
      remainingInterest:totalInterest,
      dailyInterest:    totalInterest/bond.duration,
      paidDays: 0,
    });
  }

  if(buyer.isPlayer) notify("💰 你認購了國債 "+money(actualAmount)+"，預計總利息 "+money(totalInterest), buyer.id);
  return {ok:true, amount:actualAmount};
}

// ── AI 自動認購邏輯 ──────────────────────────────────────────
function govNpcSubscribeBond(bond){
  world.companies.filter(function(c){ return !c.isPlayer&&!c.bankrupt; }).forEach(function(npc){
    if(bond.remainingAmount<=0) return;
    var dailyWage=npc.buildings.filter(function(b){return b.isCompleted;}).reduce(function(s,b){
      return s+(BUILDINGS[b.type]||{workers:0}).workers*1.5;},0);
    var safeReserve=Math.max(dailyWage*7,500);
    if(npc.cash<=safeReserve) return; // 現金不足安全水位 → 不認購
    var freeCash=npc.cash-safeReserve;
    var ratio=0.05+Math.random()*0.15; // 5%~20%
    var amount=Math.floor(freeCash*ratio);
    if(amount<10) return;
    govSubscribeBond(bond.id, npc.id, amount);
  });
}

// ── 四、募集結束處理：剩餘由央行全額承購 ─────────────────────
function govCloseBondSubscription(bond){
  var gov=ensureGovernment();
  if(bond.remainingAmount>0){
    // 央行（Buyer of Last Resort）承購剩餘全部，即使 bank.wallet 不足也照樣完成（印鈔）
    var cbAmount=bond.remainingAmount;
    var bank=world.bank;
    bank.wallet -= cbAmount; // 可能變負數，代表央行印鈔購入（貨幣創造）
    var totalInterest=cbAmount*bond.interestRate;
    bond.holders.push({
      ownerId:  "central_bank",
      ownerType:"central_bank",
      name:     "中央銀行",
      principal:cbAmount,
      totalInterest:    totalInterest,
      remainingInterest:totalInterest,
      dailyInterest:    totalInterest/bond.duration,
      paidDays: 0,
    });
    bond.remainingAmount=0;
    notify("🏦 央行承購剩餘國債 "+money(cbAmount)+"（買方最後防線，印鈔完成募集）");
  }

  // 募集資金全數轉入政府財政
  gov.treasury += bond.totalAmount;
  gov.totalCollected += bond.totalAmount;
  bond.status="active";
  notify("🏛️ 國債募集完成！政府取得資金 "+money(bond.totalAmount));
}

// ── 五、每日利息支付（政府20% + 央行印鈔80%）─────────────────
function govTickBondInterest(){
  var gov=ensureGovernment();
  gov.bonds.forEach(function(bond){
    if(bond.status!=="active") return;
    bond.holders.forEach(function(h){
      if(h.remainingInterest<=0||h.paidDays>=bond.duration) return;
      var dailyInterest=h.dailyInterest;
      if(dailyInterest>h.remainingInterest) dailyInterest=h.remainingInterest;

      var governmentShare=dailyInterest*BOND_GOV_SHARE;
      var cbShare;
      if(gov.treasury>=governmentShare){
        gov.treasury-=governmentShare;
      } else {
        governmentShare=gov.treasury;
        gov.treasury=0;
      }
      cbShare=dailyInterest-governmentShare; // 不足部分全由央行印鈔補足

      gov.totalSpent+=governmentShare;

      // 央行印鈔支付：不受 bank.wallet 限制，直接創造貨幣
      if(h.ownerType==="central_bank"){
        // 央行自己持有的部分：利息直接記在央行錢包（內部結算，不創造新貨幣淨增量）
        world.bank.wallet += dailyInterest;
      } else {
        var receiver=world.companies.find(function(c){ return c.id===h.ownerId; });
        if(receiver){
          receiver.cash += dailyInterest;
          if(receiver.isPlayer) notify("💵 國債利息入帳："+money(dailyInterest), receiver.id);
        }
      }

      h.remainingInterest -= dailyInterest;
      h.paidDays++;
    });
  });

  // 結清已付完所有利息的國債，移入歷史
  gov.bonds.forEach(function(bond){
    if(bond.status!=="active") return;
    var allPaid=bond.holders.every(function(h){ return h.remainingInterest<=0||h.paidDays>=bond.duration; });
    if(allPaid){
      bond.status="closed";
      notify("🏛️ 國債（第"+bond.issueDay+"天發行）已全部結清利息");
    }
  });
  var closed=gov.bonds.filter(function(b){ return b.status==="closed"; });
  closed.forEach(function(b){ gov.bondHistory.unshift(b); });
  if(gov.bondHistory.length>20) gov.bondHistory=gov.bondHistory.slice(0,20);
  gov.bonds=gov.bonds.filter(function(b){ return b.status!=="closed"; });
}

// ── 六、每日 tick：發行判斷 + 募集到期 + 利息支付 ─────────────
function govTickBonds(){
  var gov=ensureGovernment();

  // 募集期截止判斷
  gov.bonds.forEach(function(b){
    if(b.status==="subscribing" && world.day>=b.subscribeEndDay){
      govCloseBondSubscription(b);
    }
  });

  // 每日利息支付
  govTickBondInterest();

  // 發行判斷（連續2天財政不足且無進行中國債）
  govCheckBondTrigger();
}

function tickGovernmentSystem(){
  var gov=ensureGovernment();

  // ── 選舉週期判斷 ──────────────────────────────────────────
  govTickElection();

  // ── 政策到期判斷 ──────────────────────────────────────────
  govTickPolicy();

  // ── 國債系統：發行判斷 + 募集到期 + 利息支付 ───────────────
  govTickBonds();

  // 標記過期訂單
  gov.orders.forEach(function(o){
    if(o.status==="open"||o.status==="partial"){
      if(world.day>=o.expiresDay) o.status="expired";
    }
  });

  // 將已結束訂單移入歷史
  var done=gov.orders.filter(function(o){ return o.status==="filled"||o.status==="expired"; });
  done.forEach(function(o){ gov.orderHistory.unshift(o); });
  if(gov.orderHistory.length>20) gov.orderHistory=gov.orderHistory.slice(0,20);
  gov.orders=gov.orders.filter(function(o){ return o.status==="open"||o.status==="partial"; });

  // AI 先自動履單
  govNpcFulfillOrders();

  // 生成新一天的採購訂單
  govGenerateOrders();

  // 重置每日統計
  gov.dailyStats={ collected:0, spent:0, ordersIssued:0 };
}

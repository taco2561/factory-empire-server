// ══════════════════════════════════════════════════════════════
// 股票交易系統 V1.3
// ══════════════════════════════════════════════════════════════

var STOCK_TOTAL_SHARES   = 100000; // 每家公司固定總股數
var STOCK_PUBLIC_RATIO   = 0.20;   // 對外釋出 20%
var STOCK_IPO_RESERVE_RATIO = 0.20;// IPO 募資 20% 存備用
var STOCK_IPO_MIN_ASSETS = 20000;  // 上市最低總資產
var STOCK_IPO_MIN_DAYS   = 30;     // 上市最低成立天數
var STOCK_SMOOTH         = 0.08;   // 股價平滑因子
var STOCK_EMA_ALPHA      = 0.15;   // 成交量 EMA
var STOCK_DIVIDEND_RATIO = 0.20;   // 每次發放股利佔利潤比例
var STOCK_DIVIDEND_INTERVAL = 8;   // 每 8 天自動評估發股利

// ── 確保 world.stock 存在 ───────────────────────────────────
function ensureStock(){
  if(!world.stock) world.stock={
    companies:{}, shares:{}, orderBook:{},
    ipoQueue:[], dailyStats:{totalVolume:0,totalValue:0},
  };
  return world.stock;
}

// ── 取得股票代號（公司名稱前兩字）──────────────────────────
function stockSymbol(company){
  return (company.name||"??").substring(0,2);
}

// ── 取得上市公司股價（若尚未上市回傳 0）────────────────────
function stockPrice(companyId){
  var s=ensureStock();
  var sc=s.companies[companyId]; if(!sc) return 0;
  return sc.price||sc.ipoPrice||1;
}

// ── 取得某持有者的持股數量 ─────────────────────────────────
function stockHolding(companyId, holderId){
  var s=ensureStock();
  return (s.shares[companyId]&&s.shares[companyId][holderId])||0;
}

// ── 計算市值 ───────────────────────────────────────────────
function stockMarketCap(companyId){
  var s=ensureStock(); var sc=s.companies[companyId]; if(!sc) return 0;
  return sc.price * sc.totalShares;
}

// ══════════════════════════════════════════════════════════════
// 一、上市資格檢查
// ══════════════════════════════════════════════════════════════
function stockCheckIPOEligible(company){
  var s=ensureStock();
  if(s.companies[company.id]) return { ok:false, reason:"已上市" };
  if(s.ipoQueue.some(function(q){ return q.companyId===company.id; }))
    return { ok:false, reason:"申請中" };
  if(company.bankrupt) return { ok:false, reason:"已破產" };
  if(world.day < STOCK_IPO_MIN_DAYS) return { ok:false, reason:"成立未滿 30 天（第 "+world.day+" 天）" };
  var assets = companyBookValue(company);
  if(assets < STOCK_IPO_MIN_ASSETS) return { ok:false, reason:"總資產不足（"+money(assets)+" / 需 "+money(STOCK_IPO_MIN_ASSETS)+"）" };
  // 現金流正：最近有收入
  var hasIncome = (company.finance&&company.finance.revenue>0);
  if(!hasIncome) return { ok:false, reason:"現金流不足" };
  return { ok:true };
}

// ══════════════════════════════════════════════════════════════
// 二、IPO 申請與執行
// ══════════════════════════════════════════════════════════════
function stockApplyIPO(companyId, ipoPrice){
  var company=world.companies.find(function(c){ return c.id===companyId; });
  if(!company) return { ok:false, reason:"公司不存在" };
  var check=stockCheckIPOEligible(company);
  if(!check.ok) return { ok:false, reason:check.reason };
  ipoPrice=Math.max(0.1, ipoPrice||1.0);
  var s=ensureStock();
  s.ipoQueue.push({ companyId:companyId, ipoPrice:ipoPrice, applyDay:world.day });
  if(company.isPlayer) notify("📈 "+company.name+" 已提交上市申請（IPO 價格："+money(ipoPrice)+"）", company.id);
  return { ok:true };
}

function stockExecuteIPO(entry){
  var s=ensureStock();
  var company=world.companies.find(function(c){ return c.id===entry.companyId; });
  if(!company||company.bankrupt) return;
  var ipoPrice=entry.ipoPrice;
  var publicShares  = Math.floor(STOCK_TOTAL_SHARES * STOCK_PUBLIC_RATIO);  // 20000
  var founderShares = STOCK_TOTAL_SHARES - publicShares;                      // 80000
  var raised        = publicShares * ipoPrice;
  var toCash        = Math.floor(raised * (1-STOCK_IPO_RESERVE_RATIO));       // 80%
  var toReserve     = raised - toCash;                                         // 20%

  company.cash += toCash;
  // IPO 募資是資本性融資，不是營業收入：只記入歷史統計，不計入 periodRevenue（避免污染股利/股價計算）
  if(company.finance) company.finance.revenue=(company.finance.revenue||0)+toCash;

  // 初始化上市資料
  s.companies[company.id]={
    companyId:    company.id,
    symbol:       stockSymbol(company),
    ipoDay:       world.day,
    ipoPrice:     ipoPrice,
    price:        ipoPrice,
    prevDayPrice: ipoPrice,
    totalShares:  STOCK_TOTAL_SHARES,
    publicShares: publicShares,
    founderShares:founderShares,
    ipoReserve:   toReserve,
    buyEMA:       0, sellEMA:0,
    thisTickBuy:  0, thisTickSell:0,
    dividendPerShare: 0,
    lastDividendDay:  world.day,
    priceHistory: [ipoPrice],
    todayVolume:  publicShares,
    todayValue:   raised,
  };

  // 持股初始化：創辦人（公司自己）持有 80000 股
  if(!s.shares[company.id]) s.shares[company.id]={};
  s.shares[company.id][company.id] = founderShares;
  // 流通股在市場掛出賣單
  if(!s.orderBook[company.id]) s.orderBook[company.id]={buy:[],sell:[]};
  s.orderBook[company.id].sell.push({
    id:uid(), holderId:company.id, qty:publicShares, remaining:publicShares, price:ipoPrice
  });

  notify("🚀 "+company.name+"（"+stockSymbol(company)+"）正式上市！IPO 價 "+money(ipoPrice)+"，募資 "+money(raised)+"（現金 "+money(toCash)+"，備用 "+money(toReserve)+"）");
}

// ══════════════════════════════════════════════════════════════
// 三、股票撮合（Order Book）
// ══════════════════════════════════════════════════════════════
function stockPlaceOrder(companyId, holderId, side, qty, price){
  var s=ensureStock(); var sc=s.companies[companyId];
  if(!sc) return { ok:false, reason:"公司未上市" };
  if(qty<=0||price<=0) return { ok:false, reason:"數量或價格無效" };

  var holder=world.companies.find(function(c){ return c.id===holderId; });
  if(!holder) return { ok:false, reason:"持有者不存在" };

  if(side==="buy"){
    var total=price*qty;
    if(holder.cash<total) return { ok:false, reason:"現金不足（需 "+money(total)+"）" };
    holder.cash-=total; // 凍結資金
  } else {
    var holding=stockHolding(companyId,holderId);
    if(holding<qty) return { ok:false, reason:"持股不足（持有 "+holding+"，賣出 "+qty+"）" };
    // 凍結股票
    if(!s.shares[companyId]) s.shares[companyId]={};
    s.shares[companyId][holderId]-=qty;
  }

  var book=s.orderBook[companyId];
  var order={id:uid(), holderId:holderId, qty:qty, remaining:qty, price:price};
  book[side].push(order);
  book[side].sort(function(a,b){ return side==="buy"?b.price-a.price:a.price-b.price; });
  stockMatch(companyId);
  return { ok:true };
}

function stockMatch(companyId){
  var s=ensureStock(); var sc=s.companies[companyId]; if(!sc) return;
  var book=s.orderBook[companyId]; var changed=true;
  while(changed){
    changed=false;
    if(!book.buy.length||!book.sell.length) break;
    var bb=book.buy[0],bs=book.sell[0];
    if(bb.price>=bs.price){
      var filled=Math.min(bb.remaining,bs.remaining);
      var tp=(bb.price+bs.price)/2;
      var buyer=world.companies.find(function(c){ return c.id===bb.holderId; });
      var seller=world.companies.find(function(c){ return c.id===bs.holderId; });
      // 買方：退還差價，分配股票
      if(buyer) buyer.cash+=(bb.price-tp)*filled; // 退差價
      if(!s.shares[companyId]) s.shares[companyId]={};
      s.shares[companyId][bb.holderId]=(s.shares[companyId][bb.holderId]||0)+filled;
      // 賣方：獲得現金（股票交易屬投資收益，非本業營收，只記歷史統計）
      if(seller){ seller.cash+=tp*filled; if(seller.finance) seller.finance.revenue=(seller.finance.revenue||0)+tp*filled; }
      bb.remaining-=filled; bs.remaining-=filled;
      sc.price=tp;
      sc.thisTickBuy=(sc.thisTickBuy||0)+filled;
      sc.thisTickSell=(sc.thisTickSell||0)+filled;
      sc.todayVolume=(sc.todayVolume||0)+filled;
      sc.todayValue=(sc.todayValue||0)+filled*tp;
      s.dailyStats.totalVolume=(s.dailyStats.totalVolume||0)+filled;
      s.dailyStats.totalValue=(s.dailyStats.totalValue||0)+filled*tp;
      if(bb.remaining<=0) book.buy.shift();
      if(bs.remaining<=0) book.sell.shift();
      changed=true;
    }
  }
}

// 取消訂單
function stockCancelOrder(companyId, holderId, orderId){
  var s=ensureStock(); var book=s.orderBook[companyId]; if(!book) return false;
  ["buy","sell"].forEach(function(side){
    var idx=book[side].findIndex(function(o){ return o.id===orderId&&o.holderId===holderId; });
    if(idx<0) return;
    var order=book[side][idx];
    var holder=world.companies.find(function(c){ return c.id===holderId; });
    if(side==="buy"){ if(holder) holder.cash+=order.remaining*order.price; }
    else { if(!s.shares[companyId]) s.shares[companyId]={}; s.shares[companyId][holderId]=(s.shares[companyId][holderId]||0)+order.remaining; }
    book[side].splice(idx,1);
  });
  return true;
}

// ══════════════════════════════════════════════════════════════
// 四、股價更新（每天）
// ══════════════════════════════════════════════════════════════
function tickStockPrices(){
  var s=ensureStock();
  Object.values(s.companies).forEach(function(sc){
    var company=world.companies.find(function(c){ return c.id===sc.companyId; });
    if(!company||company.bankrupt) return;
    // 防呆：確保關鍵欄位是有效數字
    if(!isFinite(sc.totalShares)||sc.totalShares<=0) sc.totalShares=STOCK_TOTAL_SHARES;
    if(!isFinite(sc.price)||sc.price<=0) sc.price=sc.ipoPrice||1;
    if(!isFinite(sc.ipoPrice)||sc.ipoPrice<=0) sc.ipoPrice=sc.price||1;
    // EMA 更新
    sc.buyEMA  = (sc.buyEMA||0)*(1-STOCK_EMA_ALPHA)+(sc.thisTickBuy||0)*STOCK_EMA_ALPHA;
    sc.sellEMA = (sc.sellEMA||0)*(1-STOCK_EMA_ALPHA)+(sc.thisTickSell||0)*STOCK_EMA_ALPHA;
    sc.thisTickBuy=0; sc.thisTickSell=0;
    // 基礎價值 = 每股帳面資產
    var assets=Number(companyBookValue(company))||0;
    var baseValue=assets/sc.totalShares;
    if(!isFinite(baseValue)) baseValue=sc.price;
    // 盈利因子
    // 修復：盈利因子改用「本期淨利」（periodProfit），反映近期經營績效
    // 而非累計歷史營收（避免公司成立越久股價自然越高，與經營好壞無關）
    var fin=ensureFinancePeriod(company);
    var periodProfit=fin.periodProfit||(fin.periodRevenue-fin.periodExpense)||0;
    var earningsFactor=Math.min(1.5, Math.max(0.7, 1+periodProfit/(assets*0.5+1)));
    if(!isFinite(earningsFactor)) earningsFactor=1;
    // 需求因子
    var buyEMA=sc.buyEMA||0.01, sellEMA=sc.sellEMA||0.01;
    var demandFactor=Math.min(1.3, Math.max(0.8, buyEMA/sellEMA));
    if(!isFinite(demandFactor)) demandFactor=1;
    // 景氣因子
    var econFactor=world.economyState.prosperityIndex===1?1.05:world.economyState.prosperityIndex===-1?0.95:1;
    var targetPrice=baseValue*earningsFactor*demandFactor*econFactor;
    if(!isFinite(targetPrice)||targetPrice<=0) targetPrice=sc.price;
    sc.prevDayPrice=sc.price;
    sc.price+=(targetPrice-sc.price)*STOCK_SMOOTH;
    // clamp
    var minP=sc.ipoPrice*0.2, maxP=Math.max(baseValue*3, sc.ipoPrice*5);
    sc.price=Math.max(minP, Math.min(maxP, sc.price));
    if(!isFinite(sc.price)||sc.price<=0) sc.price=sc.ipoPrice||1; // 最終防線
    // 紀錄
    sc.priceHistory.push(sc.price);
    if(sc.priceHistory.length>60) sc.priceHistory.shift();
    // 重置當日統計
    sc.todayVolume=0; sc.todayValue=0;
  });
}

// ══════════════════════════════════════════════════════════════
// 五、股利發放（每 8 天自動評估）
// ══════════════════════════════════════════════════════════════
function tickStockDividends(){
  var s=ensureStock();
  Object.values(s.companies).forEach(function(sc){
    if(world.day-sc.lastDividendDay < STOCK_DIVIDEND_INTERVAL) return;
    var company=world.companies.find(function(c){ return c.id===sc.companyId; });
    if(!company||company.bankrupt) return;

    var f=ensureFinancePeriod(company);
    var periodProfit = f.periodRevenue - f.periodExpense;
    f.periodProfit = periodProfit;

    sc.lastDividendDay=world.day;

    // 虧損或損益兩平 → 不發股利，直接重置期間資料
    if(periodProfit <= 0){
      sc.dividendPerShare=0;
      f.periodRevenue=0; f.periodExpense=0; f.periodProfit=0;
      return;
    }

    // ── AI 配息率決策（玩家可自行決定，這裡先用同一套規則做預設）──
    var payoutRatio = stockDecidePayoutRatio(company, periodProfit);

    // ── 股利池 = 本期淨利 × 配息率，並以「目前現金」為上限 ──
    var dividendPool = Math.floor(periodProfit * payoutRatio);
    dividendPool = Math.min(dividendPool, Math.max(0, company.cash));

    if(dividendPool < 1){
      sc.dividendPerShare=0;
      f.periodRevenue=0; f.periodExpense=0; f.periodProfit=0;
      return;
    }

    var perShare=dividendPool/sc.totalShares;
    sc.dividendPerShare=perShare;

    // ── 分配給所有股東：用「分配後剩餘」精算最後一位，確保總額完全等於 dividendPool ──
    var shares=s.shares[sc.companyId]||{};
    var holders=Object.keys(shares).filter(function(hid){ return (shares[hid]||0)>0; });
    var totalPaid=0;
    holders.forEach(function(holderId, idx){
      var qty=shares[holderId]||0;
      var dividend;
      if(idx===holders.length-1){
        // 最後一位股東拿「池子剩餘」，避免無條件捨去造成總額對不上
        dividend = dividendPool - totalPaid;
      } else {
        dividend = Math.floor(perShare*qty);
      }
      if(dividend<=0) return;
      var holder=world.companies.find(function(c){ return c.id===holderId; });
      if(holder){ holder.cash+=dividend; totalPaid+=dividend; }
    });

    // 公司現金扣除「實際發放總額」，與股東收到總額完全一致，不會產生負現金
    company.cash -= totalPaid;

    var label=company.isPlayer?"💰 "+company.name+" 發放股利：每股 "+money(perShare)+"，共 "+money(totalPaid)+"（配息率 "+Math.round(payoutRatio*100)+"%）":null;
    if(label) notify(label, company.id);
    notify("📊 "+company.name+"（"+sc.symbol+"）每股股利："+money(perShare)+"　本期淨利："+money(periodProfit));

    // ── 結算完成：重置期間資料，開始累積下一個週期 ──
    f.periodRevenue=0; f.periodExpense=0; f.periodProfit=0;
  });
}

// ── AI 配息率決策（依公司營運狀況，不超過 50%）─────────────
function stockDecidePayoutRatio(company, periodProfit){
  // 現金不足：現金低於「7天估算薪資」視為不足，不發股利
  var dailyWage=company.buildings.filter(function(b){return b.isCompleted;}).reduce(function(s,b){
    return s+(BUILDINGS[b.type]||{workers:0}).workers*1.5;},0);
  var safeReserve=Math.max(dailyWage*7, 500);
  if(company.cash < safeReserve) return 0;

  // 正在擴廠：有未完工建築視為擴廠中
  var expanding=company.buildings.some(function(b){ return !b.isCompleted; });
  if(expanding) return 0;

  // 景氣狀態
  var pi=(world.economyState&&world.economyState.prosperityIndex)||0;

  // 現金充裕程度（現金 / 安全儲備）
  var cashRatio = company.cash / Math.max(safeReserve,1);

  if(pi===-1) return 0.10;              // 景氣蕭條
  if(cashRatio>=10) return 0.50;        // 非常成熟且資金大量閒置
  if(cashRatio>=5)  return 0.40;        // 現金充裕且無擴張需求
  return 0.20;                          // 正常營運
}

// ══════════════════════════════════════════════════════════════
// 六、上市備用資金自動釋放
// ══════════════════════════════════════════════════════════════
function tickStockIPOReserve(){
  var s=ensureStock();
  Object.values(s.companies).forEach(function(sc){
    if(!sc.ipoReserve||sc.ipoReserve<=0) return;
    var company=world.companies.find(function(c){ return c.id===sc.companyId; });
    if(!company||company.bankrupt) return;
    // 觸發條件：現金<=0 或幾乎耗盡
    if(company.cash<=100){
      company.cash+=sc.ipoReserve;
      notify("🏦 "+company.name+" 觸發資金危機，釋放上市備用資金 "+money(sc.ipoReserve));
      sc.ipoReserve=0;
    }
  });
}

// ══════════════════════════════════════════════════════════════
// 七、每天 tick（由 game-loop 呼叫）
// ══════════════════════════════════════════════════════════════
function tickStockSystem(){
  var s=ensureStock();
  // 處理 IPO 申請（提交後 1 天生效）
  var today=world.day;
  s.ipoQueue.forEach(function(entry){
    if(today>=entry.applyDay+1){ stockExecuteIPO(entry); }
  });
  s.ipoQueue=s.ipoQueue.filter(function(q){ return today<q.applyDay+1; });
  // 股價更新
  tickStockPrices();
  // 股利
  tickStockDividends();
  // 備用資金監控
  tickStockIPOReserve();
  // 重置每日統計
  s.dailyStats={totalVolume:0,totalValue:0};
  // AI 上市評估 + 投資
  npcStockDecision();
}

// ══════════════════════════════════════════════════════════════
// 八、AI 股票決策
// ══════════════════════════════════════════════════════════════
function npcStockDecision(){
  var s=ensureStock();
  world.companies.filter(function(c){ return !c.isPlayer&&!c.bankrupt; }).forEach(function(npc){
    // 1. 評估是否符合上市資格
    if(!s.companies[npc.id]&&!s.ipoQueue.some(function(q){ return q.companyId===npc.id; })){
      var check=stockCheckIPOEligible(npc);
      if(check.ok&&npc.cash>STOCK_IPO_MIN_ASSETS*0.3){
        var assets=companyBookValue(npc);
        var ipoPrice=assets/STOCK_TOTAL_SHARES*1.2; // 溢價 20% 上市
        stockApplyIPO(npc.id, ipoPrice);
      }
    }
    // 2. 評估投資其他上市公司（用閒置現金買股）
    if(npc.cash>8000){
      var targets=Object.values(s.companies).filter(function(sc){
        return sc.companyId!==npc.id; // 不買自己的股票
      }).sort(function(a,b){
        // 優先買本益比低（價值投資）的公司
        var ca=world.companies.find(function(c){ return c.id===a.companyId; });
        var cb=world.companies.find(function(c){ return c.id===b.companyId; });
        var aVal=ca?companyBookValue(ca)/a.totalShares:0;
        var bVal=cb?companyBookValue(cb)/b.totalShares:0;
        var aRatio=aVal>0?a.price/aVal:999;
        var bRatio=bVal>0?b.price/bVal:999;
        return aRatio-bRatio; // 價格/帳面越低越前面
      });
      if(targets.length>0){
        var target=targets[0];
        var tc=world.companies.find(function(c){ return c.id===target.companyId; });
        if(!tc||tc.bankrupt) return;
        var budget=Math.min(npc.cash*0.1, 2000); // 最多用 10% 現金買股，上限 2000
        if(budget>=target.price){
          var qty=Math.floor(budget/target.price);
          if(qty>0) stockPlaceOrder(target.companyId, npc.id, "buy", qty, target.price*1.05);
        }
      }
    }
    // 3. 賣出虧損股票（持股跌超過 30%）
    Object.keys(s.companies).forEach(function(cid){
      var sc=s.companies[cid]; if(!sc) return;
      var held=stockHolding(cid,npc.id); if(held<=0) return;
      var buyPrice=sc.ipoPrice; // 簡化：以 IPO 價為買入成本基準
      if(sc.price<buyPrice*0.7){
        var sellQty=Math.floor(held*0.5); // 賣一半
        if(sellQty>0) stockPlaceOrder(cid, npc.id, "sell", sellQty, sc.price*0.98);
      }
    });
  });
}

// ══════════════════════════════════════════════════════════════
// 工具函式
// ══════════════════════════════════════════════════════════════

// 取得公司所有股東列表
function stockShareholders(companyId){
  var s=ensureStock(); var shares=s.shares[companyId]||{};
  var sc=s.companies[companyId]; if(!sc) return [];
  return Object.keys(shares).map(function(hid){
    var qty=shares[hid]||0;
    var company=world.companies.find(function(c){ return c.id===hid; });
    return { holderId:hid, name:company?company.name:"未知", qty:qty, ratio:qty/sc.totalShares };
  }).filter(function(h){ return h.qty>0; }).sort(function(a,b){ return b.qty-a.qty; });
}

// 股票漲跌幅
function stockChangeRate(sc){
  var price=Number(sc&&sc.price);
  var prev=Number(sc&&sc.prevDayPrice);
  if(!isFinite(price)||!isFinite(prev)||prev===0) return 0;
  return (price-prev)/prev;
}

// ══════════════════════════════════════════════════════════════
// 新聞系統 V2.0
// 每 8 個遊戲日發布一次，內容完全根據遊戲資料自動生成
// ══════════════════════════════════════════════════════════════

function generateDailyNews(){
  var econ = world.economyState;
  var day  = world.day;
  var report = world.monitor.reports[0]; // 用最新監測報告

  // ── 1. 各類型前三名排行榜 ────────────────────────────────
  var typeOrder   = ["producer","seller","arbitrage","integrated"];
  var typeLabels  = { producer:"🏭 生產型", seller:"🏪 銷售型", arbitrage:"🚀 擴張型", integrated:"🔬 專精型" };
  var rankingLines = [];
  if(report){
    typeOrder.forEach(function(t){
      var top3 = (report.byType[t]||[]).slice(0,3);
      if(!top3.length) return;
      rankingLines.push("<b>"+typeLabels[t]+"</b>");
      top3.forEach(function(snap, i){
        rankingLines.push("　"+(i+1)+". "+snap.name+" <b>"+money(snap.assets)+"</b>　現金 "+money(snap.cash));
      });
    });
  } else {
    // 無報告時用全體排名
    world.companies.filter(function(c){ return !c.isPlayer; })
      .sort(function(a,b){ return companyBookValue(b)-companyBookValue(a); })
      .slice(0,5).forEach(function(c,i){
        rankingLines.push("　"+(i+1)+". "+c.name+" "+money(companyBookValue(c)));
      });
  }

  // ── 2. 市場動態 ──────────────────────────────────────────
  var prevReport = world.monitor.reports[1];
  var priceChanges = [];
  Object.values(world.market).forEach(function(m){
    var pid = m.productId;
    var p = PRODUCTS[pid];
    if(!p) return;
    var prevPrice = prevReport && prevReport.marketSnap && prevReport.marketSnap[pid]
      ? prevReport.marketSnap[pid].price : m.price;
    var change = prevPrice > 0 ? (m.price - prevPrice) / prevPrice : 0;
    priceChanges.push({ pid:pid, name:p.name, emoji:p.emoji, price:m.price, change:change, demand:m.demand, supply:m.supply, trades:m.trades });
  });
  priceChanges.sort(function(a,b){ return b.change-a.change; });

  var topRise  = priceChanges[0];
  var topFall  = priceChanges[priceChanges.length-1];
  var topDemand= priceChanges.slice().sort(function(a,b){ return b.demand-a.demand; })[0];
  var topSurplus=priceChanges.slice().sort(function(a,b){ return (b.supply-b.demand)-(a.supply-a.demand); })[0];

  var marketLines = [];
  if(topRise  && Math.abs(topRise.change)  > 0.001) marketLines.push("📈 漲幅最大："+topRise.emoji+topRise.name+" "+money(topRise.price)+"（"+(topRise.change>=0?"+":"")+(topRise.change*100).toFixed(1)+"%）");
  if(topFall  && Math.abs(topFall.change)  > 0.001) marketLines.push("📉 跌幅最大："+topFall.emoji+topFall.name+" "+money(topFall.price)+"（"+(topFall.change>=0?"+":"")+(topFall.change*100).toFixed(1)+"%）");
  if(topDemand) marketLines.push("🔥 需求最旺："+topDemand.emoji+topDemand.name+"（需求指數 "+topDemand.demand.toFixed(0)+"）");
  if(topSurplus && topSurplus.supply > topSurplus.demand) marketLines.push("📦 供給過剩："+topSurplus.emoji+topSurplus.name+"（供 "+topSurplus.supply.toFixed(0)+" vs 需 "+topSurplus.demand.toFixed(0)+"）");

  // ── 3. AI 重大事件 ────────────────────────────────────────
  var eventLines = [];
  // 近期新建建築
  var bigBuilders = [];
  world.companies.filter(function(c){ return !c.isPlayer; }).forEach(function(c){
    var newBldgs = c.buildings.filter(function(b){
      return !b.isCompleted && b.endTime > 0;
    });
    if(newBldgs.length > 0){
      newBldgs.forEach(function(b){
        bigBuilders.push(c.name+"正在建造 "+BUILDINGS[b.type].name);
      });
    }
  });
  bigBuilders.slice(0,3).forEach(function(s){ eventLines.push("🏗️ "+s); });
  // 破產
  world.companies.filter(function(c){ return c.bankrupt; }).forEach(function(c){
    eventLines.push("💀 "+c.name+" 宣告破產");
  });
  // 大額借款（>5000）
  world.companies.filter(function(c){ return !c.isPlayer && c.bankAccount; }).forEach(function(c){
    var loans = c.bankAccount.loans.filter(function(l){ return l.principal >= 5000 && l.daysLeft > l.termDays-3; });
    loans.forEach(function(l){ eventLines.push("🏦 "+c.name+" 申請大額貸款 "+money(l.principal)); });
  });
  if(!eventLines.length) eventLines.push("　（本期無重大事件）");

  // ── 4. 經濟摘要 ──────────────────────────────────────────
  var econTag  = econ.prosperityLabel;
  var gdpText  = (econ.gdpGrowth>=0?"+":"")+(econ.gdpGrowth*100).toFixed(1)+"%";
  var econCause = "";
  // 自動分析主因
  if(topSurplus && topSurplus.supply > topSurplus.demand * 1.5){
    econCause = "近期「"+topSurplus.name+"」供給大幅過剩，拉低市場均價。";
  } else if(topRise && topRise.change > 0.10){
    econCause = "「"+topRise.name+"」需求上升推動市場活絡，帶動整體景氣。";
  } else if(econ.prosperityIndex === -1){
    econCause = "消費力不足，員工錢包緊縮，市場需求下滑。中央銀行已啟動補貼政策。";
  } else if(econ.prosperityIndex === 1){
    econCause = "市場供需平衡，消費活躍，多數產業正常運作。";
  } else {
    econCause = "市場維持平穩，供需無明顯失衡。";
  }

  // ── 組合新聞內文 ─────────────────────────────────────────
  // ── 政府景氣補助資訊 ──
  var gov = ensureGovernment();
  var subsidyLines = [];
  var lastGovSubsidy = (gov.subsidyLog && gov.subsidyLog[0]) || null;
  if(lastGovSubsidy && lastGovSubsidy.day === day){
    subsidyLines.push("　發放日期：第 "+lastGovSubsidy.day+" 天");
    subsidyLines.push("　補助類型："+lastGovSubsidy.type);
    subsidyLines.push("　補助金額：<b>"+money(lastGovSubsidy.amount)+"</b>（注入員工錢包）");
    subsidyLines.push("　政府財政餘額："+money(lastGovSubsidy.treasuryAfter));
  } else {
    var piLabel = econ.prosperityIndex===1?"繁榮（不補助）":econ.prosperityIndex===-1?"蕭條（每天 20% 財政）":"平穩（每天 2% 財政）";
    subsidyLines.push("　目前景氣："+piLabel);
    subsidyLines.push("　政府財政："+money(gov.treasury));
  }

  var sections = [
    "【第 "+day+" 天 · 財經要聞（每 8 天發布）】\n",
    "━━━━━━━━━━━━━━━━━━━━━━━━",
    "🏆 各類型 AI 公司資產排行（前三名）",
    rankingLines.join("\n"),
    "",
    "━━━━━━━━━━━━━━━━━━━━━━━━",
    "📊 市場動態",
    marketLines.join("\n") || "　（市場數據不足）",
    "",
    "━━━━━━━━━━━━━━━━━━━━━━━━",
    "📡 AI 公司重大事件",
    eventLines.join("\n"),
    "",
    "━━━━━━━━━━━━━━━━━━━━━━━━",
    "🏛️ 政府景氣補助",
    subsidyLines.join("\n"),
    "",
    "━━━━━━━━━━━━━━━━━━━━━━━━",
    "🌐 經濟摘要",
    "　景氣狀況：<b>"+econTag+"</b>　GDP 成長率："+gdpText,
    "　"+econCause,
    "　流通貨幣："+money(econ.moneySupply)+"　員工錢包："+money(EMPLOYEE_WALLET),
  ];

  var body = sections.join("\n");

  world.currentNews.unshift({
    title:  "📰 第 "+day+" 天 · 財經要聞",
    body:   body,
    tag:    econTag,
    prosperityIndex: econ.prosperityIndex,
    time:   Date.now(),
    day:    day,
  });
  if(world.currentNews.length > 20) world.currentNews.pop();

  // 重置消費偏好計數
  Object.keys(world.consumerPrefs).forEach(function(pid){ world.consumerPrefs[pid]=0; });
}

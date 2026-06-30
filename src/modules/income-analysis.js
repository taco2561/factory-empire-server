// ══════════════════════════════════════════════════════════════
// 強化版收入來源分析（用於監測頁面前八大排行）
// ══════════════════════════════════════════════════════════════
function getDetailedIncomeSources(company) {
  var log = company.activityLog || {};
  var buildings = company.buildings.filter(function(b) { return b.isCompleted; });

  // ① 解析活動記錄 → sell / buy 分類統計
  var sellMap = {}, buyMap = {};
  Object.entries(log).forEach(function(e) {
    var parts = e[0].split("_");
    var action = parts[parts.length - 1];
    var pid = parts.slice(0, -1).join("_");
    if (!PRODUCTS[pid]) return;
    if (action === "sell") sellMap[pid] = (sellMap[pid] || 0) + e[1];
    if (action === "buy")  buyMap[pid]  = (buyMap[pid]  || 0) + e[1];
  });
  var sellEntries = Object.entries(sellMap).sort(function(a, b) { return b[1] - a[1]; });

  // ② 分析建築組合
  var prodBldgs = [], venueLabels = [], venueTypes = [];
  buildings.forEach(function(b) {
    var bDef = BUILDINGS[b.type];
    if (isVenueBuilding(bDef)) {
      var lbl = bDef.isRestaurant ? "🍽️餐廳" : bDef.isClothingStore ? "👗服飾店" : "🛒超市";
      venueLabels.push(lbl);
      venueTypes.push(bDef.venueType);
    } else {
      prodBldgs.push({ emoji: bDef.emoji, name: bDef.name, products: bDef.products });
    }
  });

  // ③ 策略標籤
  var t = company.npcType;
  var stratChip = "";
  if (t === "producer")   stratChip = '<span class="chip green"  style="font-size:10px">🏭 生產型</span>';
  else if (t === "seller")     stratChip = '<span class="chip yellow" style="font-size:10px">🏪 銷售型</span>';
  else if (t === "integrated") stratChip = '<span class="chip teal"   style="font-size:10px">🔬 專精型</span>';
  else if (t === "arbitrage")  stratChip = '<span class="chip purple" style="font-size:10px">🚀 擴張型</span>';
  else                         stratChip = '<span class="chip blue"   style="font-size:10px">🏢 玩家</span>';

  // ④ 商品顏色
  function catColor(cat) {
    return cat === "meal" ? "purple"
      : cat === "fashion" ? "pink"
      : cat === "fruit" ? "green"
      : cat === "fashion_mat" ? "pink"
      : cat === "livestock" ? "orange"
      : cat === "feed" ? "yellow" : "blue";
  }

  // ⑤ 通路標籤
  function channelTag(pid) {
    var p = PRODUCTS[pid];
    if (!p) return "";
    if (p.venue === "supermarket" && venueTypes.indexOf("supermarket") >= 0) return "🛒超市";
    if (p.venue === "restaurant"  && venueTypes.indexOf("restaurant")  >= 0) return "🍽️餐廳";
    if (p.venue === "clothing"    && venueTypes.indexOf("clothing")    >= 0) return "👗服飾店";
    if (venueLabels.length > 0) return venueLabels[0];
    return "📊市場";
  }

  var lines = [];

  if (sellEntries.length > 0) {
    // 有銷售記錄：顯示前3大商品，帶通路標籤
    var top3 = sellEntries.slice(0, 3);
    top3.forEach(function(e) {
      var p = PRODUCTS[e[0]];
      var qty = e[1];
      var cc = catColor(p.category);
      var ch = channelTag(e[0]);
      lines.push(
        '<div class="income-row">' +
        '<span class="chip ' + cc + '" style="font-size:10px;padding:1px 5px">' + p.emoji + ' ' + p.name + '</span>' +
        '<span class="income-qty">×' + qty + '</span>' +
        '<span class="income-channel">' + ch + '</span>' +
        '</div>'
      );
    });
  } else if (t === "arbitrage") {
    // 擴張型：顯示目標產業和任務佇列狀態
    var npcSt = company.npcState;
    var target = npcSt && npcSt.targetPid ? npcSt.targetPid : null;
    var queueLen = npcSt && npcSt.taskQueue ? npcSt.taskQueue.length : 0;
    var totalBldgs = buildings.filter(function(b){ return !isVenueBuilding(BUILDINGS[b.type]); }).length;
    if(target && PRODUCTS[target]){
      var tp = PRODUCTS[target];
      lines.push('<div class="income-row"><span style="font-size:10px;color:var(--purple)">🚀 目標</span>'+
        '<span class="chip '+catColor(tp.category)+'" style="font-size:10px;padding:1px 5px">'+tp.emoji+' '+tp.name+'</span>'+
        (queueLen>0?'<span class="income-qty">['+queueLen+'項任務]</span>':'')+'</div>');
    }
    if (sellEntries.length) {
      sellEntries.slice(0, 2).forEach(function(e) {
        var p = PRODUCTS[e[0]]; if (!p) return;
        lines.push('<div class="income-row">'+
          '<span style="font-size:10px;color:var(--purple)">🚀 擴張</span>'+
          '<span class="chip '+catColor(p.category)+'" style="font-size:10px;padding:1px 5px">'+p.emoji+' '+p.name+'</span>'+
          '<span class="income-qty">×'+e[1]+'</span>'+
          '<span class="income-channel">'+channelTag(e[0])+'</span></div>');
      });
      lines.push('<div style="font-size:10px;color:var(--purple)">🏗️ 生產建築 '+totalBldgs+' 棟</div>');
    } else {
      lines.push('<div style="font-size:10px;color:var(--muted)">🚀 擴張中，累積資本…</div>');
    }
  } else if (prodBldgs.length > 0) {
    // 有生產建築但無銷售記錄：顯示可生產的商品
    var allProds = [];
    prodBldgs.forEach(function(b) { allProds = allProds.concat(b.products.slice(0, 2)); });
    allProds = allProds.slice(0, 3);
    allProds.forEach(function(pid) {
      var p = PRODUCTS[pid]; if (!p) return;
      lines.push(
        '<div class="income-row">' +
        '<span style="font-size:10px;color:var(--muted)">⚙️ 生產中</span>' +
        '<span class="chip ' + catColor(p.category) + '" style="font-size:10px;padding:1px 5px">' + p.emoji + ' ' + p.name + '</span>' +
        '</div>'
      );
    });
  } else if (venueLabels.length > 0) {
    lines.push('<div style="font-size:10px;color:var(--muted)">🏪 ' + venueLabels.join('、') + ' — 等待進貨</div>');
  } else {
    lines.push('<div style="font-size:10px;color:var(--muted)">— 尚無記錄</div>');
  }

  // ⑥ 建築標籤列
  var allBldgLabels = [];
  prodBldgs.forEach(function(b) { allBldgLabels.push(b.emoji + b.name); });
  venueLabels.forEach(function(l) { allBldgLabels.push(l); });
  var bldgBadges = "";
  if (allBldgLabels.length) {
    bldgBadges = '<div class="income-buildings">' +
      allBldgLabels.slice(0, 4).map(function(l) {
        return '<span class="income-bldg-tag">' + l + '</span>';
      }).join("") + '</div>';
  }

  return '<div class="income-block income-strategy">' + stratChip + '</div>' +
    '<div class="income-block">' + lines.join("") + '</div>' +
    bldgBadges;
}

// 保留舊的 getIncomeSources 供其他地方使用
function getIncomeSources(company){
  var sources=[];
  var log=company.activityLog||{};
  var sellEntries=[];
  Object.entries(log).forEach(function(e){
    var parts=e[0].split("_");
    var action=parts[parts.length-1];
    var pid=parts.slice(0,-1).join("_");
    if(action==="sell"&&PRODUCTS[pid]&&e[1]>0) sellEntries.push({pid:pid,qty:e[1]});
  });
  sellEntries.sort(function(a,b){ return b.qty-a.qty; });
  var topSells=sellEntries.slice(0,3);
  var hasProdBuilding=false, hasVenue=false;
  var venueTypes=[], prodTypes=[];
  company.buildings.filter(function(b){ return b.isCompleted; }).forEach(function(b){
    var bDef=BUILDINGS[b.type];
    if(isVenueBuilding(bDef)){
      hasVenue=true;
      if(bDef.venueType==="supermarket") venueTypes.push("超市");
      else if(bDef.venueType==="restaurant") venueTypes.push("餐廳");
      else if(bDef.venueType==="clothing") venueTypes.push("服飾店");
    } else {
      hasProdBuilding=true;
      prodTypes.push(bDef.name);
    }
  });
  if(topSells.length){
    topSells.forEach(function(s){
      var p=PRODUCTS[s.pid];
      var channel=hasVenue&&venueTypes.length?"門市":"市場";
      sources.push(p.emoji+p.name+"（"+channel+" ×"+s.qty+"）");
    });
  } else if(hasProdBuilding){
    sources.push("⚙️ "+prodTypes.slice(0,2).join("、")+" 生產");
  } else if(hasVenue){
    sources.push("🏪 "+venueTypes.join("、")+" 零售");
  }
  if(!sources.length) sources.push("—");
  return sources;
}

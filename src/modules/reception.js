// ══════════════════════════════════════════════════════════════
// 接待中心系統（v0.3）
// 僅玩家使用。NPC 不參與此系統。
// ══════════════════════════════════════════════════════════════

// ── 工具：依機率表隨機抽樣 ──────────────────────────────────
function weightedRandom(weightedItems) {
  var r = Math.random();
  var acc = 0;
  for (var i = 0; i < weightedItems.length; i++) {
    acc += weightedItems[i].weight;
    if (r < acc) return weightedItems[i];
  }
  return weightedItems[weightedItems.length - 1];
}

// ── 產生一張訂單 ─────────────────────────────────────────────
function generateConstructionOrder() {
  // 決定訂單種類
  var r = Math.random();
  var orderType = r < ORDER_TYPE_WEIGHTS.townhouse ? "townhouse" : "detached";

  // 決定樓層數
  var floorEntry = weightedRandom(ORDER_FLOOR_WEIGHTS);
  var floors = floorEntry.floors;

  // 計算所需材料
  var perFloor = orderType === "townhouse" ? ORDER_TOWNHOUSE_PER_FLOOR : ORDER_DETACHED_PER_FLOOR;
  var required = {};
  Object.keys(perFloor).forEach(function(pid) {
    required[pid] = perFloor[pid] * floors;
  });

  // 計算現金獎勵（材料市場總價 × 利潤倍率）
  var materialValue = 0;
  Object.keys(required).forEach(function(pid) {
    var mktPrice = world.market[pid] ? world.market[pid].price : (PRODUCTS[pid] ? PRODUCTS[pid].basePrice : 0);
    materialValue += mktPrice * required[pid];
  });
  var reward = Math.round(materialValue * ORDER_PROFIT_MULTIPLIER);

  return {
    id: uid(),
    type: orderType,       // "townhouse" | "detached"
    floors: floors,
    required: required,    // { reinforced_concrete: N, brick: N }
    reward: reward,
    createdAt: Date.now(),
  };
}

// ── 取得玩家的接待中心建築（第一個完工的） ──────────────────
function getPlayerReceptionBuilding() {
  var player = getPlayer();
  return player.buildings.find(function(b) {
    return b.isCompleted && b.type === "reception_center";
  }) || null;
}

// ── 取得玩家的接待中心狀態（掛在 world 上） ─────────────────
function getReceptionState() {
  if (!world.reception) {
    world.reception = makeDefaultReceptionState();
  }
  return world.reception;
}

function makeDefaultReceptionState() {
  return {
    searching: false,       // 是否正在尋找客戶
    searchStartTime: null,  // 尋找開始的真實時間戳（ms）
    searchEndTime: null,    // 尋找結束的真實時間戳（ms）
    currentOrder: null,     // 目前待接訂單（null = 無）
    totalOrdersCompleted: 0,
    totalEarned: 0,
  };
}

// ── 開始尋找客戶 ─────────────────────────────────────────────
function receptionStartSearch() {
  var player = getPlayer();
  var rc = getReceptionState();
  var bldg = getPlayerReceptionBuilding();

  if (!bldg) return { ok: false, msg: "尚未有完工的接待中心" };
  if (rc.searching) return { ok: false, msg: "已在尋找客戶中" };

  // 支付開發客戶成本
  if (player.cash < RECEPTION_SEARCH_COST) {
    return { ok: false, msg: "現金不足以支付開發客戶成本（需 " + money(RECEPTION_SEARCH_COST) + "）" };
  }
  player.cash -= RECEPTION_SEARCH_COST;
  player.finance.expenses = (player.finance.expenses || 0) + RECEPTION_SEARCH_COST;

  var now = Date.now();
  rc.searching = true;
  rc.searchStartTime = now;
  rc.searchEndTime = now + RECEPTION_SEARCH_DURATION_MS;
  rc.currentOrder = null;

  notify("🏢 接待中心開始尋找客戶（支付開發費 " + money(RECEPTION_SEARCH_COST) + "）");
  return { ok: true };
}

// ── 接受訂單 ─────────────────────────────────────────────────
function receptionAcceptOrder() {
  var rc = getReceptionState();
  if (!rc.currentOrder) return { ok: false, msg: "目前沒有待接訂單" };
  if (rc.searching) return { ok: false, msg: "仍在尋找客戶中" };
  // 訂單已在 currentOrder，接受即保留，立刻開始下一次尋找
  notify("✅ 已接受訂單：" + orderLabel(rc.currentOrder));
  return { ok: true };
}

// ── 拒絕訂單 ─────────────────────────────────────────────────
function receptionRejectOrder() {
  var rc = getReceptionState();
  if (!rc.currentOrder) return { ok: false, msg: "目前沒有待接訂單" };
  notify("🚫 已拒絕訂單：" + orderLabel(rc.currentOrder));
  rc.currentOrder = null;
  // 立即開始下一次尋找
  receptionStartSearch();
  return { ok: true };
}

// ── 交付訂單 ─────────────────────────────────────────────────
function receptionDeliverOrder() {
  var player = getPlayer();
  var rc = getReceptionState();
  if (!rc.currentOrder) return { ok: false, msg: "目前沒有進行中的訂單" };

  var order = rc.currentOrder;

  // 檢查倉庫是否足夠
  var shortages = [];
  Object.keys(order.required).forEach(function(pid) {
    var have = player.warehouse[pid] || 0;
    var need = order.required[pid];
    if (have < need) shortages.push(PRODUCTS[pid].name + "（缺 " + (need - have) + "）");
  });
  if (shortages.length) {
    return { ok: false, msg: "材料不足：" + shortages.join("、") };
  }

  // 扣除材料
  Object.keys(order.required).forEach(function(pid) {
    player.warehouse[pid] -= order.required[pid];
  });

  // 發放獎勵
  player.cash += order.reward;
  if(typeof recordRevenue==="function") recordRevenue(player, order.reward);
  else player.finance.revenue = (player.finance.revenue || 0) + order.reward;

  rc.totalOrdersCompleted++;
  rc.totalEarned += order.reward;
  notify("🏆 訂單交付成功！獲得 " + money(order.reward) + "（" + orderLabel(order) + "）");

  rc.currentOrder = null;

  // 立即開始下一次尋找
  receptionStartSearch();

  return { ok: true };
}

// ── tick 檢查：尋找客戶是否完成 ─────────────────────────────
function tickReception() {
  var bldg = getPlayerReceptionBuilding();
  if (!bldg) return; // 玩家尚未建造接待中心

  var rc = getReceptionState();
  if (!rc.searching) return;

  var now = Date.now();

  // 判斷是否完成尋找
  if (now >= rc.searchEndTime) {
    rc.searching = false;
    var order = generateConstructionOrder();
    rc.currentOrder = order;
    notify("📋 接待中心找到新客戶！" + orderLabel(order) + "，獎勵 " + money(order.reward));
  }
}

// ── 輔助：訂單文字描述 ───────────────────────────────────────
function orderLabel(order) {
  var typeLabel = order.type === "townhouse" ? "透天" : "獨棟";
  return typeLabel + " " + order.floors + "F";
}

// ── 輔助：計算訂單所需材料是否足夠（給 UI 用） ──────────────
function orderCanDeliver(order) {
  var player = getPlayer();
  return Object.keys(order.required).every(function(pid) {
    return (player.warehouse[pid] || 0) >= order.required[pid];
  });
}

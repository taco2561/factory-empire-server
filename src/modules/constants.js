// ══════════════════════════════════════════════════════════════
// 接待中心常數（可依需求調整）
// ══════════════════════════════════════════════════════════════

// 每次「尋找客戶」所需的現實時間（毫秒）
// 24 小時 = 24 * 60 * 60 * 1000
var RECEPTION_SEARCH_DURATION_MS = 24 * 60 * 60 * 1000;

// 每次開始尋找客戶時支付的固定「開發客戶成本」
var RECEPTION_SEARCH_COST = 500;

// 訂單獎勵利潤倍率（材料總價 × 此倍率 = 現金獎勵）
var ORDER_PROFIT_MULTIPLIER = 1.20;

// 透天每層需求
var ORDER_TOWNHOUSE_PER_FLOOR = { reinforced_concrete: 80, brick: 80 };

// 獨棟每層需求
var ORDER_DETACHED_PER_FLOOR  = { reinforced_concrete: 160, brick: 160 };

// 訂單種類出現機率（透天 80%，獨棟 20%）
var ORDER_TYPE_WEIGHTS = { townhouse: 0.80, detached: 0.20 };

// 樓層機率表
var ORDER_FLOOR_WEIGHTS = [
  { floors: 1, weight: 0.80 },
  { floors: 2, weight: 0.16 },
  { floors: 3, weight: 0.04 },
];

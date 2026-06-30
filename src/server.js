// ══════════════════════════════════════════════════════════════
// Factory Empire v3 — Phase 1 Server
//
// 目的（依照第一階段規格）：
//   把六個核心邏輯模組（economy / npc-ai / government-system /
//   stock-system / bank-system / game-loop）搬到 Node.js 伺服器執行，
//   讓遊戲核心開始由伺服器跑，但本階段：
//     - 不加 WebSocket / Socket.io
//     - 不做多人同步
//     - 不加帳號系統 / 資料庫 / 房間系統 / 防作弊
//     - 不修改 localStorage 邏輯本身（state.js 程式碼不變，
//       只是補一個 Node.js 沒有的 localStorage 介面）
//
// 這支程式單純讓伺服器自己跑一份完整的遊戲世界（80家AI公司 + 1個玩家），
// 跟瀏覽器端目前的單機版「平行存在、互不影響」，用來驗證：
//   1. 六個核心模組搬進 Node.js 環境是否能正常執行（無瀏覽器依賴問題）
//   2. Server Tick 是否能穩定、正確地推進遊戲世界
// ══════════════════════════════════════════════════════════════

const fs   = require("fs");
const path = require("path");
const vm   = require("vm");

// ── [Phase 2] 未捕捉例外記錄 ─────────────────────────────────
// 純粹是讓崩潰原因清楚地印在 log 裡，方便在 Railway 上排查。
// 不影響任何遊戲邏輯，也不會「攔截並繼續執行」——還是讓
// Railway 的 restartPolicy 自然接手重啟，符合純背景服務的設計。
process.on("uncaughtException", function(err){
  console.error("[Phase2 Server] 未捕捉例外，程序即將結束：", err);
  process.exit(1);
});
process.on("unhandledRejection", function(reason){
  console.error("[Phase2 Server] 未處理的 Promise rejection：", reason);
});

const MODULES_DIR = path.join(__dirname, "modules");

// ── 固定載入順序（與原本 game.html 組譯腳本的順序完全一致）───
// 只取「遊戲邏輯」需要的模組，不含 ui-render / ui-events / main
// （那三個是前端專用，Phase 1 不在伺服器執行）
const MODULE_ORDER = [
  "utils",
  "constants",
  "data",
  "economy",
  "state",
  "bank-system",
  "reception",
  "game-loop",
  "npc-ai",
  "income-analysis",
  "monitor",
  "stock-system",
  "government-system",
  "news",
];

// ══════════════════════════════════════════════════════════════
// 把所有模組串接成一段腳本，在同一個 vm context 裡執行。
// 原本這些模組是用全域變數互相呼叫（沒有 require/module.exports），
// 為了「只調整執行位置、不重寫既有功能」，這裡完全比照原本瀏覽器端
// 組合 game.html 的方式：把多個檔案的原始碼直接串接成一份大腳本，
// 讓它們繼續用同一份全域作用域互相溝通。
// ══════════════════════════════════════════════════════════════
function loadCombinedSource(){
  const parts = MODULE_ORDER.map(function(name){
    const filePath = path.join(MODULES_DIR, name + ".js");
    return "\n// ── module: " + name + ".js ──\n" + fs.readFileSync(filePath, "utf8");
  });
  return parts.join("\n");
}

// ── 建立一個最小的全域環境（不含 document/window 等瀏覽器物件）──
// 六個核心模組本身完全不使用瀏覽器 API（已事先確認），
// 唯一需要補上的瀏覽器相依是 state.js 用到的 localStorage，
// 而 state.js 內部已經自帶一份相容介面（見 modules/state.js 開頭）。
function createSandbox(){
  const sandbox = {
    console: console,
    Date: Date,
    Math: Math,
    JSON: JSON,
    Object: Object,
    Array: Array,
    String: String,
    Number: Number,
    Boolean: Boolean,
    RegExp: RegExp,
    Error: Error,
    Promise: Promise,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    setInterval: setInterval,
    clearInterval: clearInterval,
    isNaN: isNaN,
    isFinite: isFinite,
    parseInt: parseInt,
    parseFloat: parseFloat,
  };
  sandbox.global = sandbox;
  return sandbox;
}

function main(){
  console.log("[Phase1 Server] 載入遊戲邏輯模組中…");
  const source = loadCombinedSource();

  const sandbox = createSandbox();
  vm.createContext(sandbox);

  try{
    vm.runInContext(source, sandbox, { filename: "factory-empire-core.js" });
  } catch(e){
    console.error("[Phase1 Server] 模組載入失敗：", e);
    process.exit(1);
  }

  console.log("[Phase1 Server] 模組載入完成，world 已初始化。");
  console.log("[Phase1 Server] 初始狀態 → day:", sandbox.world.day, " tick:", sandbox.world.tick,
              " 公司數:", sandbox.world.companies.length);

  startServerTick(sandbox);
}

// ══════════════════════════════════════════════════════════════
// Server Tick
//
// 原本前端 1x 速度的 tick 間隔是 3000ms（見 ui-render.js: applySpeed）。
// 規格要求「不修改任何遊戲規則 / 平衡數值」，因此 Phase 1 伺服器沿用
// 同樣的基準速度（3000ms 一次 tick），不加速、不調整任何遊戲內公式。
//
// 每呼叫一次全域的 tick()，遊戲世界就往前推進一格，
// 跟原本瀏覽器端 setInterval(tick, tickMs) 的行為完全相同，
// 只是現在是伺服器自己持續呼叫，不依賴任何使用者開著分頁。
// ══════════════════════════════════════════════════════════════
const TICK_MS = 3000;          // 與前端 1x 速度一致
const LOG_EVERY_N_TICKS = 20;  // 每跑完一個遊戲天（20 tick）印一次狀態，方便觀察

function startServerTick(sandbox){
  console.log("[Phase1 Server] 啟動 Server Tick，間隔 " + TICK_MS + "ms（與前端 1x 速度相同）…");

  setInterval(function(){
    try{
      sandbox.tick();
    } catch(e){
      console.error("[Phase1 Server] tick() 執行時發生錯誤：", e);
      return;
    }

    if(sandbox.world.dayTick === 0){
      // dayTick 剛被 tick() 內部重置為 0，代表這一格剛好跨過一個新的遊戲天
      logWorldSummary(sandbox.world);
    }
  }, TICK_MS);
}

function logWorldSummary(world){
  const player = world.companies.find(function(c){ return c.isPlayer; });
  const aliveNpc = world.companies.filter(function(c){ return !c.isPlayer && !c.bankrupt; }).length;
  const bankruptNpc = world.companies.filter(function(c){ return !c.isPlayer && c.bankrupt; }).length;

  console.log(
    "[Phase1 Server] Day " + world.day +
    " | Tick " + world.tick +
    " | 玩家現金 $" + Math.round(player ? player.cash : 0) +
    " | 存活NPC " + aliveNpc +
    " | 破產NPC " + bankruptNpc +
    " | 景氣 " + (world.economyState && world.economyState.prosperityLabel)
  );
}

main();

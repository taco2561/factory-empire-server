// ══════════════════════════════════════════════════════════════
// Factory Empire v3 — Server (Phase 1 + Phase 2 + Phase 3)
//
// Phase 1：把六個核心邏輯模組搬到 Node.js 伺服器執行。
// Phase 2：部署到 Railway，作為純背景服務 24 小時運行。
// Phase 3：world 狀態改存進 Supabase（PostgreSQL），取代原本只存在
//          記憶體中的做法，讓伺服器重啟後能恢復上一次的進度。
//
// Phase 3 的設計原則：
//   - state.js 的 loadWorld()/saveWorld() 函式本體完全沒有修改
//   - 只是這兩個函式底層呼叫的 localStorage.getItem/setItem，
//     現在背後接了一份會同步資料庫的記憶體層（見 modules/state.js）
//   - 本檔案負責「啟動時把資料庫內容預先載入進那份記憶體」，
//     確保 var world = loadWorld() 執行的當下資料已經就緒
// ══════════════════════════════════════════════════════════════

const fs   = require("fs");
const path = require("path");
const vm   = require("vm");
const http = require("http");
const db   = require("./db");
const api  = require("./api");
const ws   = require("./ws-server");

// ── 未捕捉例外記錄 ───────────────────────────────────────────
process.on("uncaughtException", function(err){
  console.error("[Server] 未捕捉例外，程序即將結束：", err);
  process.exit(1);
});
process.on("unhandledRejection", function(reason){
  console.error("[Server] 未處理的 Promise rejection：", reason);
});

const MODULES_DIR = path.join(__dirname, "modules");

// ── 固定載入順序（與原本 game.html 組譯腳本的順序完全一致）───
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

function loadCombinedSource(){
  const parts = MODULE_ORDER.map(function(name){
    const filePath = path.join(MODULES_DIR, name + ".js");
    return "\n// ── module: " + name + ".js ──\n" + fs.readFileSync(filePath, "utf8");
  });
  return parts.join("\n");
}

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

const STORAGE_KEY = "pe3_world_v3"; // 與 state.js 內部使用的 key 完全一致

async function main(){
  console.log("[Server] 載入遊戲邏輯模組中…");
  const source = loadCombinedSource();

  const sandbox = createSandbox();
  vm.createContext(sandbox);

  // ── [Phase 3] 先載入模組「定義」，但還不執行頂層的 `var world = loadWorld()` ──
  // 這裡有個關鍵時序問題：state.js 開頭就有 `var world = loadWorld();`，
  // 如果直接把整段 source 丟進 vm 執行，這行會在我們把資料庫內容準備好
  //之前就先跑掉，導致永遠讀到空的、變成每次啟動都是全新世界。
  //
  // 解法：先連資料庫、把存檔內容準備好放進 sandbox 能存取的地方，
  // 再執行整段 source。因為 JS 的 `var` 函式宣告會被提升（hoisting），
  // 但 `var world = loadWorld()` 這個「賦值」仍是按照程式碼順序執行，
  // 所以我們改成：在執行 source 之前，先把 localStorage 的預載資料
  // 準備好，並注入一個資料庫同步函式，這樣 source 執行到
  // `var world = loadWorld()` 時，localStorage.getItem(...) 已經能
  // 拿到正確的資料。
  let dbAvailable = false;
  let preloadValue = null;

  try{
    console.log("[Phase3 Server] 連接資料庫中…");
    await db.ensureSchema();
    const loaded = await db.loadWorldFromDb();
    if(loaded){
      preloadValue = JSON.stringify(loaded);
      console.log("[Phase3 Server] 已從資料庫讀到既有存檔（day:" + loaded.day + " tick:" + loaded.tick + "）。");
      await db.logEvent("load", "day:" + loaded.day + " tick:" + loaded.tick);
    } else {
      console.log("[Phase3 Server] 資料庫目前沒有存檔，將建立全新世界。");
      await db.logEvent("init", "no existing save, will create new world");
    }
    dbAvailable = true;
  } catch(err){
    // 資料庫連線失敗時的退路：不讓整個伺服器掛掉，改用純記憶體模式
    // （等同 Phase 1/2 的行為），並把原因印清楚方便排查。
    console.error("[Phase3 Server] 資料庫連線失敗，本次將以純記憶體模式運行（不會持久化）：", err.message);
  }

  // ── 執行模組腳本：先把預載資料和 key 透過一個小型 bootstrap 片段
  // 注入 sandbox，再執行真正的遊戲邏輯模組 ──
  const bootstrap =
    "var __PHASE3_PRELOAD_KEY = " + JSON.stringify(STORAGE_KEY) + ";\n" +
    "var __PHASE3_PRELOAD_VALUE = " + (preloadValue ? JSON.stringify(preloadValue) : "null") + ";\n";

  try{
    vm.runInContext(bootstrap, sandbox, { filename: "phase3-bootstrap.js" });
  } catch(e){
    console.error("[Server] Bootstrap 注入失敗：", e);
    process.exit(1);
  }

  // 把 state.js 即將定義的 localStorage 物件改造一下：在執行完整段
  // source 之前，我們沒辦法直接呼叫 sandbox 裡的函式（還沒定義），
  // 所以改用「在 source 最前面插入一段小腳本」的方式完成預載，
  // 這段小腳本會在 state.js 真正定義 localStorage 之後、
  // `var world = loadWorld()` 執行之前，把資料庫內容寫進去。
  const patchedSource = injectPreloadHook(source);

  try{
    vm.runInContext(patchedSource, sandbox, { filename: "factory-empire-core.js" });
  } catch(e){
    console.error("[Server] 模組載入失敗：", e);
    process.exit(1);
  }

  console.log("[Server] 模組載入完成，world 已初始化。");
  console.log("[Server] 初始狀態 → day:", sandbox.world.day, " tick:", sandbox.world.tick,
              " 公司數:", sandbox.world.companies.length);

  // ── [Phase 3] 把資料庫寫入函式注入給 state.js 內的同步機制使用 ──
  if(dbAvailable){
    sandbox.__setDbSyncFn(async function(key, value){
      if(key !== STORAGE_KEY) return; // 只同步我們關心的這把 key
      const worldObject = JSON.parse(value);
      await db.saveWorldToDb(worldObject);
    });
    console.log("[Phase3 Server] 資料庫背景同步已啟用，每次 saveWorld() 都會非阻塞地寫回 Supabase。");
  } else {
    console.log("[Phase3 Server] 資料庫不可用，本次運行採純記憶體模式（行為等同 Phase 1/2，重啟即重置）。");
  }

  startServerTick(sandbox);

  // ── [Phase 4A] 啟動 HTTP REST API Server ─────────────────────
  const PORT = process.env.PORT || 3000;
  const httpServer = http.createServer(api.createRequestHandler(sandbox));

  // ── [Phase 5A] 建立 WebSocket Server（共用同一個 HTTP server）
  const wss = ws.createWebSocketServer(httpServer, sandbox);

  httpServer.listen(PORT, function(){
    console.log("[Server] HTTP + WebSocket 已啟動，監聽 port " + PORT);
    console.log("[Phase4A] REST API 路由：");
    console.log("  GET  /api/health         → 健康檢查");
    console.log("  GET  /api/world/summary  → 精簡世界摘要");
    console.log("  GET  /api/world          → 完整 world 狀態");
    console.log("  POST /api/action         → 執行玩家操作");
    console.log("[Phase5A] WebSocket：ws://同網址 → 即時 world 更新");
  });

  startServerTick(sandbox, wss);
}

// ── 在組合好的模組原始碼裡，找到 state.js 定義完 localStorage 之後、
// `var world = loadWorld();` 執行之前的位置，插入一行預載呼叫。
// 這樣完全不需要修改 state.js 檔案本身的任何一行程式碼。
function injectPreloadHook(source){
  const marker = "var world = loadWorld();";
  const idx = source.indexOf(marker);
  if(idx < 0){
    console.error("[Phase3 Server] 警告：找不到預期的插入點（var world = loadWorld();），" +
                   "將以未預載狀態繼續執行（會被視為全新世界）。");
    return source;
  }
  const hook =
    "if(typeof __PHASE3_PRELOAD_VALUE!=='undefined' && __PHASE3_PRELOAD_VALUE!==null){ " +
    "localStorage.__preload(__PHASE3_PRELOAD_KEY, __PHASE3_PRELOAD_VALUE); }\n";
  return source.slice(0, idx) + hook + source.slice(idx);
}

// ══════════════════════════════════════════════════════════════
// Server Tick（與 Phase 1/2 完全相同，未修改任何遊戲規則）
// ══════════════════════════════════════════════════════════════
const TICK_MS = 3000;
const LOG_EVERY_N_TICKS = 20;

function startServerTick(sandbox, wss){
  console.log("[Server] 啟動 Server Tick，間隔 " + TICK_MS + "ms（與前端 1x 速度相同）…");

  setInterval(function(){
    try{
      sandbox.tick();
    } catch(e){
      console.error("[Server] tick() 執行時發生錯誤：", e);
      return;
    }

    // [Phase 5A] 每個 tick 廣播更新給所有連線的前端
    ws.broadcastTick(wss, sandbox);

    if(sandbox.world.dayTick === 0){
      logWorldSummary(sandbox.world);
    }
  }, TICK_MS);
}

function logWorldSummary(world){
  const player = world.companies.find(function(c){ return c.isPlayer; });
  const aliveNpc = world.companies.filter(function(c){ return !c.isPlayer && !c.bankrupt; }).length;
  const bankruptNpc = world.companies.filter(function(c){ return !c.isPlayer && c.bankrupt; }).length;

  console.log(
    "[Server] Day " + world.day +
    " | Tick " + world.tick +
    " | 玩家現金 $" + Math.round(player ? player.cash : 0) +
    " | 存活NPC " + aliveNpc +
    " | 破產NPC " + bankruptNpc +
    " | 景氣 " + (world.economyState && world.economyState.prosperityLabel)
  );
}

main().catch(function(err){
  console.error("[Server] 啟動失敗：", err);
  process.exit(1);
});


// ══════════════════════════════════════════════════════════════
// Factory Empire v3 — Phase 7B：WorldManager
//
// 背景：Phase 1~6 的架構假設「這個 Node 程序裡只有一個 world」，
// server.js 直接建立一個 vm sandbox、一個 world、一個 tick 迴圈。
// Phase 7 要支援 Main World + Tournament World 同時存在，需要能
// 對任意 worldId 重複做「建立 sandbox → 讀檔 → 跑 tick」這件事。
//
// 關鍵設計決策：**不修改九個核心遊戲模組一行程式碼**。每個 World
// （不管 Main 還是 Tournament）都各自用一個獨立的 vm sandbox 執行
// 同一份模組原始碼——這些模組內部一路以來都是假設「自己是唯一的
// world」在寫（模組層級的 `var world`），只要每個 World 各自關在
// 自己的 vm context 裡，這個假設就繼續成立，完全不用改。
//
// 這支模組只負責「生命週期管理」：
//   - loadWorld(worldId)：建立/讀取指定 world 的 sandbox（若已載入
//     則直接回傳既有的，不會重複建立）
//   - startTick(worldId, onTick)：啟動這個 world 專屬的 tick 迴圈，
//     onTick 是選填的 callback，每個 tick 執行完後呼叫（給呼叫端
//     接 WebSocket 廣播、記錄 log 等用，WorldManager 本身不管這些）
//   - stopTick(worldId) / unloadWorld(worldId)：Tournament 結束後
//     停止 tick、釋放記憶體用
//   - getSandbox(worldId)：查詢用
//
// Phase 7B 階段只有 Main World（worldId=1）會被實際載入/啟動，
// Tournament World 的建立/結束流程留到 Phase 7D 才會真的呼叫這裡
// 的 unloadWorld() 等函式；這支模組本身現在就已經支援多個 world
// 同時被載入（Map 結構天生就是多個），不需要之後再改。
// ══════════════════════════════════════════════════════════════

const fs   = require("fs");
const path = require("path");
const vm   = require("vm");
const db   = require("./db");

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

const STORAGE_KEY = "pe3_world_v3"; // 與 state.js 內部使用的 key 完全一致
const TICK_MS = 3000;

// combinedSource 對所有 world 都是同一份程式碼，只讀一次快取起來，
// 不用每次 loadWorld() 都重新讀硬碟。
// [Phase 7B] extraModules：Tournament World 之後可能會加掛額外模組
// （例如造市商 market-maker.js），Main World 不會用到，先留這個
// 擴充點，避免 Phase 7D 又要回頭改這支檔案的核心邏輯。
const _sourceCache = {};
function loadCombinedSource(extraModules){
  const modules = MODULE_ORDER.concat(extraModules || []);
  const cacheKey = modules.join(",");
  if(_sourceCache[cacheKey]) return _sourceCache[cacheKey];

  const parts = modules.map(function(name){
    const filePath = path.join(MODULES_DIR, name + ".js");
    return "\n// ── module: " + name + ".js ──\n" + fs.readFileSync(filePath, "utf8");
  });
  const combined = parts.join("\n");
  _sourceCache[cacheKey] = combined;
  return combined;
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

// ── 在組合好的模組原始碼裡，找到 state.js 定義完 localStorage 之後、
// `var world = loadWorld();` 執行之前的位置，插入一行預載呼叫。
// 這樣完全不需要修改 state.js 檔案本身的任何一行程式碼。
function injectPreloadHook(source){
  const marker = "var world = loadWorld();";
  const idx = source.indexOf(marker);
  if(idx < 0){
    console.error("[WorldManager] 警告：找不到預期的插入點（var world = loadWorld();），" +
                   "將以未預載狀態繼續執行（會被視為全新世界）。");
    return source;
  }
  const hook =
    "if(typeof __PHASE3_PRELOAD_VALUE!=='undefined' && __PHASE3_PRELOAD_VALUE!==null){ " +
    "localStorage.__preload(__PHASE3_PRELOAD_KEY, __PHASE3_PRELOAD_VALUE); }\n";
  return source.slice(0, idx) + hook + source.slice(idx);
}

// worldId(number) -> { sandbox, tickInterval, dbAvailable, extraModules }
const _worlds = new Map();

// ── 載入（或取得已載入的）指定 world ────────────────────────────
// 若這個 worldId 已經載入過，直接回傳既有的 sandbox（不會重複建立、
// 不會重複讀資料庫）。
async function loadWorld(worldId, extraModules){
  if(_worlds.has(worldId)){
    return _worlds.get(worldId).sandbox;
  }

  console.log("[WorldManager] 載入 world " + worldId + " 中…");
  const source = loadCombinedSource(extraModules);

  const sandbox = createSandbox();
  vm.createContext(sandbox);

  // ── 先連資料庫、把存檔內容準備好，再執行模組原始碼 ──
  // （原因見 injectPreloadHook 註解：state.js 開頭就有
  //   `var world = loadWorld()`，要在這行執行之前就把資料準備好）
  let dbAvailable = false;
  let preloadValue = null;

  try{
    const loaded = await db.loadWorldFromDb(worldId);
    if(loaded){
      preloadValue = JSON.stringify(loaded);
      console.log("[WorldManager] world " + worldId + " 已從資料庫讀到既有存檔（day:" + loaded.day + " tick:" + loaded.tick + "）。");
      await db.logEvent("load", "day:" + loaded.day + " tick:" + loaded.tick, worldId);
    } else {
      console.log("[WorldManager] world " + worldId + " 資料庫目前沒有存檔，將建立全新世界。");
      await db.logEvent("init", "no existing save, will create new world", worldId);
    }
    dbAvailable = true;
  } catch(err){
    // 資料庫連線失敗時的退路：不讓整個 world 載入失敗，改用純記憶體模式，
    // 並把原因印清楚方便排查。
    console.error("[WorldManager] world " + worldId + " 資料庫連線失敗，本次將以純記憶體模式運行（不會持久化）：", err.message);
  }

  const bootstrap =
    "var __PHASE3_PRELOAD_KEY = " + JSON.stringify(STORAGE_KEY) + ";\n" +
    "var __PHASE3_PRELOAD_VALUE = " + (preloadValue ? JSON.stringify(preloadValue) : "null") + ";\n";
  vm.runInContext(bootstrap, sandbox, { filename: "phase3-bootstrap-world" + worldId + ".js" });

  const patchedSource = injectPreloadHook(source);
  vm.runInContext(patchedSource, sandbox, { filename: "factory-empire-core-world" + worldId + ".js" });

  console.log("[WorldManager] world " + worldId + " 初始化完成 → day:" + sandbox.world.day +
              " tick:" + sandbox.world.tick + " 公司數:" + sandbox.world.companies.length);

  // ── 把資料庫寫入函式注入給 state.js 內的同步機制使用 ──
  if(dbAvailable){
    sandbox.__setDbSyncFn(async function(key, value){
      if(key !== STORAGE_KEY) return; // 只同步我們關心的這把 key
      const worldObject = JSON.parse(value);
      await db.saveWorldToDb(worldId, worldObject);
    });
    console.log("[WorldManager] world " + worldId + " 資料庫背景同步已啟用。");
  } else {
    console.log("[WorldManager] world " + worldId + " 資料庫不可用，本次運行採純記憶體模式（重啟即重置）。");
  }

  _worlds.set(worldId, {
    sandbox: sandbox,
    tickInterval: null,
    dbAvailable: dbAvailable,
    extraModules: extraModules || [],
  });

  return sandbox;
}

// ── 啟動指定 world 的 tick 迴圈 ─────────────────────────────────
// onTick(sandbox)：選填，每個 tick 成功執行完後呼叫（WorldManager
// 本身不管 WebSocket 廣播、記錄 log 這些事，交給呼叫端決定）。
// 若這個 world 的 tick 已經在跑，重複呼叫不會啟動第二個迴圈
// （修正舊版 server.js 曾經不小心啟動兩個重疊 tick 迴圈的問題）。
function startTick(worldId, onTick){
  const entry = _worlds.get(worldId);
  if(!entry){
    throw new Error("[WorldManager] world " + worldId + " 尚未載入，無法啟動 tick（請先呼叫 loadWorld）");
  }
  if(entry.tickInterval){
    console.warn("[WorldManager] world " + worldId + " 的 tick 迴圈已經在跑，忽略重複啟動");
    return;
  }

  console.log("[WorldManager] world " + worldId + " 啟動 tick 迴圈，間隔 " + TICK_MS + "ms");
  entry.tickInterval = setInterval(function(){
    try{
      entry.sandbox.tick();
    } catch(e){
      console.error("[WorldManager] world " + worldId + " tick() 執行時發生錯誤：", e);
      return;
    }
    if(typeof onTick === "function"){
      try{ onTick(entry.sandbox); }
      catch(e){ console.error("[WorldManager] world " + worldId + " onTick callback 發生錯誤：", e); }
    }
  }, TICK_MS);
}

// ── 停止指定 world 的 tick 迴圈（不卸載 sandbox，資料還在記憶體裡）──
function stopTick(worldId){
  const entry = _worlds.get(worldId);
  if(entry && entry.tickInterval){
    clearInterval(entry.tickInterval);
    entry.tickInterval = null;
    console.log("[WorldManager] world " + worldId + " 已停止 tick 迴圈");
  }
}

// ── 完全卸載指定 world（停止 tick + 從記憶體釋放，之後要用要重新
//    loadWorld()）。Tournament World 結束後用來釋放資源。──
function unloadWorld(worldId){
  stopTick(worldId);
  _worlds.delete(worldId);
  console.log("[WorldManager] world " + worldId + " 已卸載");
}

// ── 查詢用 ───────────────────────────────────────────────────
function getSandbox(worldId){
  const entry = _worlds.get(worldId);
  return entry ? entry.sandbox : null;
}

function isLoaded(worldId){
  return _worlds.has(worldId);
}

function listLoadedWorldIds(){
  return Array.from(_worlds.keys());
}

module.exports = {
  loadWorld,
  startTick,
  stopTick,
  unloadWorld,
  getSandbox,
  isLoaded,
  listLoadedWorldIds,
};

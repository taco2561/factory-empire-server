var PRODUCTS = {
  water:    { id:"water",    name:"水",    emoji:"💧", basePrice:5,   inputs:{},                          consumer:false, category:"raw" },
  power:    { id:"power",    name:"電",    emoji:"⚡", basePrice:8,   inputs:{},                          consumer:false, category:"raw" },
  seeds:    { id:"seeds",    name:"種子",  emoji:"🌱", basePrice:12,  inputs:{water:1},                    consumer:false, category:"raw" },
  apple:    { id:"apple",    name:"蘋果",  emoji:"🍎", basePrice:35,  inputs:{seeds:1,water:1},            consumer:true, demandPerWorker:0.12, venue:"supermarket", category:"fruit" },
  grape:    { id:"grape",    name:"葡萄",  emoji:"🍇", basePrice:42,  inputs:{seeds:1,water:1},            consumer:true, demandPerWorker:0.10, venue:"supermarket", category:"fruit" },
  feed:     { id:"feed",     name:"飼料",  emoji:"🌾", basePrice:15,  inputs:{water:2},                    consumer:false, category:"feed" },
  pig:      { id:"pig",      name:"豬",    emoji:"🐷", basePrice:80,  inputs:{feed:3},                     consumer:false, category:"livestock" },
  cow:      { id:"cow",      name:"牛",    emoji:"🐄", basePrice:120, inputs:{feed:5},                     consumer:false, category:"livestock" },
  chicken:  { id:"chicken",  name:"雞",    emoji:"🐔", basePrice:40,  inputs:{feed:2},                     consumer:false, category:"livestock" },
  porkchop: { id:"porkchop", name:"豬排",  emoji:"🥩", basePrice:180, inputs:{pig:1,power:1,water:1},      consumer:true, demandPerWorker:0.06, venue:"restaurant", category:"meal" },
  beefsteak:{ id:"beefsteak",name:"牛排",  emoji:"🥩", basePrice:280, inputs:{cow:1,power:1,water:1},      consumer:true, demandPerWorker:0.04, venue:"restaurant", category:"meal" },
  chicken_steak:{ id:"chicken_steak",name:"雞排",emoji:"🍗",basePrice:120,inputs:{chicken:1,power:1,water:1},consumer:true,demandPerWorker:0.08,venue:"restaurant",category:"meal" },
  cloth:    { id:"cloth",    name:"布",    emoji:"🧵", basePrice:30,  inputs:{power:2},                    consumer:false, category:"fashion_mat" },
  leather:  { id:"leather",  name:"皮革",  emoji:"🦬", basePrice:60,  inputs:{cow:1,power:1},               consumer:true,  demandPerWorker:0.04, venue:"clothing", category:"fashion_mat" },
  shirt:    { id:"shirt",    name:"上衣",  emoji:"👕", basePrice:150, inputs:{cloth:2,leather:1,power:1},   consumer:true,  demandPerWorker:0.05, venue:"clothing", category:"fashion" },
  pants:    { id:"pants",    name:"褲子",  emoji:"👖", basePrice:140, inputs:{cloth:2,leather:1,power:1},   consumer:true,  demandPerWorker:0.05, venue:"clothing", category:"fashion" },
  shoes:    { id:"shoes",    name:"鞋子",  emoji:"👟", basePrice:200, inputs:{cloth:1,leather:2,power:1},   consumer:true,  demandPerWorker:0.04, venue:"clothing", category:"fashion" },

  // ── 建材產業（v0.3 新增）──
  limestone:           { id:"limestone",           name:"石灰石",   emoji:"🪨", basePrice:18,  inputs:{power:1},                              consumer:false, category:"construction_raw" },
  clay:                { id:"clay",                name:"黏土",     emoji:"🧱", basePrice:15,  inputs:{power:1},                              consumer:false, category:"construction_raw" },
  cement:              { id:"cement",              name:"水泥",     emoji:"🏚️", basePrice:50,  inputs:{limestone:2},                          consumer:false, category:"construction_mat" },
  brick:               { id:"brick",               name:"磚頭",     emoji:"🧱", basePrice:52,  inputs:{clay:2},                               consumer:false, category:"construction_mat" },
  reinforced_concrete: { id:"reinforced_concrete", name:"鋼筋混凝土",emoji:"🏗️", basePrice:120, inputs:{water:1,cement:2},                    consumer:false, category:"construction_mat" },

  // ── 礦業原料（v0.4 新增）── 礦洞隨機產出，無固定 inputs ──
  iron_ore:     { id:"iron_ore",     name:"鐵礦",     emoji:"⛓️",  basePrice:25,  inputs:{},                     consumer:false, category:"mineral" },
  copper_ore:   { id:"copper_ore",   name:"銅礦",     emoji:"🟧",  basePrice:30,  inputs:{},                     consumer:false, category:"mineral" },
  aluminum_ore: { id:"aluminum_ore", name:"鋁礦",     emoji:"⬜",  basePrice:28,  inputs:{},                     consumer:false, category:"mineral" },
  lithium_ore:  { id:"lithium_ore",  name:"鋰礦",     emoji:"🔋",  basePrice:45,  inputs:{},                     consumer:false, category:"mineral" },
  silica_sand:  { id:"silica_sand",  name:"石英砂",   emoji:"🏖️",  basePrice:22,  inputs:{},                     consumer:false, category:"mineral" },

  // ── 材料加工（v0.4 新增）──
  silicon_wafer:{ id:"silicon_wafer",name:"矽晶圓",   emoji:"💿",  basePrice:160, inputs:{silica_sand:3,power:4}, consumer:false, category:"material" },
  plastic:      { id:"plastic",      name:"塑膠",     emoji:"🧪",  basePrice:35,  inputs:{crude_oil:2,power:1},   consumer:false, category:"material" },
  chemicals:    { id:"chemicals",    name:"化學品",   emoji:"⚗️",  basePrice:40,  inputs:{crude_oil:2,power:1},   consumer:false, category:"material" },
  steel:        { id:"steel",        name:"鋼材",     emoji:"🔩",  basePrice:55,  inputs:{iron_ore:2,power:1},    consumer:false, category:"material" },
  crude_oil:    { id:"crude_oil",    name:"原油",     emoji:"🛢️",  basePrice:20,  inputs:{},                     consumer:false, category:"mineral" },

  // ── 電子零組件（v0.4 新增）──
  battery:      { id:"battery",      name:"電池",     emoji:"🔋",  basePrice:90,  inputs:{lithium_ore:2,copper_ore:1,chemicals:1}, consumer:false, category:"electronic_part" },
  pcb:          { id:"pcb",          name:"電路板",   emoji:"🟩",  basePrice:75,  inputs:{copper_ore:2,plastic:1,chemicals:1},     consumer:false, category:"electronic_part" },
  cpu:          { id:"cpu",          name:"處理器",   emoji:"🧠",  basePrice:220, inputs:{silicon_wafer:1,copper_ore:1,chemicals:1},consumer:false, category:"electronic_part" },
  memory:       { id:"memory",       name:"記憶體",   emoji:"💾",  basePrice:150, inputs:{silicon_wafer:1,copper_ore:1,chemicals:1},consumer:false, category:"electronic_part" },
  display:      { id:"display",      name:"螢幕",     emoji:"🖥️",  basePrice:130, inputs:{copper_ore:1,chemicals:2},               consumer:false, category:"electronic_part" },
  power_supply: { id:"power_supply", name:"電源",     emoji:"🔌",  basePrice:60,  inputs:{steel:1,copper_ore:1},                   consumer:false, category:"electronic_part" },

  // ── 終端電子產品（v0.4 新增）──
  smartphone:   { id:"smartphone",   name:"智慧手機", emoji:"📱",  basePrice:680, inputs:{battery:1,cpu:1,memory:1,pcb:1,display:1}, consumer:true, demandPerWorker:0.05, venue:"electronics", category:"electronics" },
  computer:     { id:"computer",     name:"電腦",     emoji:"💻",  basePrice:850, inputs:{cpu:1,memory:1,pcb:1,power_supply:1},      consumer:true, demandPerWorker:0.04, venue:"electronics", category:"electronics" },
  television:   { id:"television",   name:"電視",     emoji:"📺",  basePrice:520, inputs:{display:1,pcb:1,chemicals:1},              consumer:true, demandPerWorker:0.04, venue:"electronics", category:"electronics" },
};

// ── 礦洞可能產出的礦物清單（每座礦洞建造時隨機抽取其中3種）──
var MINE_POSSIBLE_ORES = ["iron_ore","copper_ore","aluminum_ore","lithium_ore","silica_sand"];

var BUILDINGS = {
  reservoir:    { id:"reservoir",    name:"蓄水池",  emoji:"🏗️", cost:600,  buildTime:60,  workers:2, products:["water"],    description:"手動生產水，每批次支付員工薪資" },
  powerplant:   { id:"powerplant",   name:"發電廠",  emoji:"⚡", cost:1200, buildTime:90,  workers:4, products:["power"],    description:"手動生產電，每批次支付員工薪資" },
  farm:         { id:"farm",         name:"農場",    emoji:"🌿", cost:800,  buildTime:80,  workers:3, products:["seeds","apple","grape"], description:"生產種子、蘋果、葡萄" },
  ranch:        { id:"ranch",        name:"牧場",    emoji:"🐄", cost:1500, buildTime:120, workers:5, products:["feed","pig","cow","chicken"], description:"生產飼料、豬牛雞" },
  slaughter:    { id:"slaughter",    name:"屠宰場",  emoji:"🔪", cost:2500, buildTime:160, workers:6, products:["porkchop","beefsteak","chicken_steak"], description:"生產豬排、牛排、雞排" },
  clothing_factory: { id:"clothing_factory", name:"服飾工廠", emoji:"🏭", cost:3500, buildTime:180, workers:7, products:["cloth","leather","shirt","pants","shoes"], description:"生產布、皮革、上衣、褲子、鞋子" },
  supermarket:  { id:"supermarket",  name:"生鮮超市",emoji:"🛒", cost:3000, buildTime:180, workers:5, products:[], isSupermarket:true, venueType:"supermarket", venueProducts:["apple","grape"], description:"販售蘋果葡萄給員工" },
  restaurant:   { id:"restaurant",   name:"餐廳",    emoji:"🍽️", cost:4000, buildTime:200, workers:8, products:[], isRestaurant:true, venueType:"restaurant", venueProducts:["porkchop","beefsteak","chicken_steak"], description:"販售排餐給員工" },
  clothing_store:{ id:"clothing_store",name:"服飾商店",emoji:"👗", cost:3500, buildTime:180, workers:5, products:[], isClothingStore:true, venueType:"clothing", venueProducts:["leather","shirt","pants","shoes"], description:"販售服裝給員工" },

  // ── 建材產業（v0.3 新增）──
  quarry:           { id:"quarry",           name:"採石場",    emoji:"⛏️",  cost:8000,  buildTime:240, workers:4, products:["limestone","clay"],                          description:"消耗電力，生產石灰石與黏土" },
  concrete_factory: { id:"concrete_factory", name:"混凝土廠",  emoji:"🏭",  cost:15000, buildTime:360, workers:10, products:["brick","cement","reinforced_concrete"],       description:"生產磚頭、水泥、鋼筋混凝土" },
  reception_center: { id:"reception_center", name:"接待中心",  emoji:"🏢",  cost:20000, buildTime:300, workers:10,  products:[],                                            isReceptionCenter:true, description:"尋找建築客戶，接受訂單並交付建材賺取報酬" },

  // ── 礦業與電子產業（v0.4 新增）──
  // 礦洞：建造時從 MINE_POSSIBLE_ORES 隨機抽取 3 種礦物作為該礦洞的固定產出（products 在 startBuilding 時動態決定）
  mine:             { id:"mine",             name:"礦洞",      emoji:"⛏️",  cost:6000,  buildTime:200, workers:8,  products:[], isMine:true, description:"開採隨機礦物資源，不同礦洞產出組合不同" },
  oil_rig:          { id:"oil_rig",          name:"油井",      emoji:"🛢️",  cost:5000,  buildTime:180, workers:6,  products:["crude_oil"], description:"開採原油，供應材料加工廠" },
  material_factory: { id:"material_factory", name:"材料加工廠",emoji:"🏭",  cost:9000,  buildTime:260, workers:10, products:["silicon_wafer","plastic","chemicals","steel"], description:"加工礦物與原油，生產矽晶圓、塑膠、化學品、鋼材（矽晶圓加工時間長）" },
  electronics_factory:{ id:"electronics_factory", name:"電子廠", emoji:"🔧",  cost:18000, buildTime:340, workers:14, products:["battery","pcb","cpu","memory","display","power_supply","smartphone","computer","television"], description:"組裝電子零組件與終端電子產品" },
  electronics_store:{ id:"electronics_store",name:"電子賣場",  emoji:"🏬",  cost:12000, buildTime:260, workers:9,  products:[], isElectronicsStore:true, venueType:"electronics", venueProducts:["smartphone","computer","television"], description:"販售智慧手機、電腦、電視給員工" },
};

// ── 通路類型 → 對應建築 key（資料驅動，新增通路只需在此加一行）──
var VENUE_TYPE_TO_BUILDING = {
  supermarket: "supermarket",
  restaurant:  "restaurant",
  clothing:    "clothing_store",
  electronics: "electronics_store",
};

var AUTO_PRODUCE = {};

var NPC_TYPES = {
  producer:   { id:"producer",   label:"生產型",   emoji:"🏭", color:"green",  desc:"最大化生產能力，超市滿足後剩餘才賣市場" },
  seller:     { id:"seller",     label:"銷售型",   emoji:"🏪", color:"yellow", desc:"從市場低買高賣，閒錢存銀行收利息" },
  integrated: { id:"integrated", label:"專精型",   emoji:"🔬", color:"teal",   desc:"選定單一產業鏈持續深化，不頻繁切換方向" },
  arbitrage:  { id:"arbitrage",  label:"擴張型",   emoji:"🚀", color:"purple", desc:"快速擴建，評估 ROI 可借款，積極擴大規模" },
};

var NPC_NAMES = [
  "北方貿易公司","南海商行","東方集團","西城工業","中央物流","峰頂實業","聯合商社","大陸資本","星光企業","海灣貿易",
  "永興農業","鑫源牧場","翠谷農莊","豐收食品","綠野農產","金牛畜牧","天河電力","清泉水務","旭日能源","碧波水業",
  "宏達屠宰","精品食材","美味工坊","鮮切肉品","御廚食品","民生超市","百鮮生鮮","樂購商行","豐盛餐飲","味道餐廳",
  "泰山控股","長城實業","龍騰集團","鳳凰商業","海龍企業","瑞豐投資","嘉禾農業","萬象商貿","華陽產業","恆信集團",
  "明日科技","富強工業","興業商社","利民貿易","天成企業","博遠集團","同心商行","遠景實業","鼎盛農牧","銀河商業",
  "錦繡服飾","時尚布坊","皮革工坊","潮流服飾","雅緻時裝","天絲布業","金線刺繡","龍鳳服裝","尚品皮具","優質鞋業",
  "聯豐農場","旺盛牧業","豐年農莊","春色農業","綠源牧場","大地農產","碧山農業","豐澤牧場","金穗農莊","銀葉農業",
  "匯通商行","通達物流","博信貿易","廣源實業","順風商社","鴻運企業","吉祥商業","福星集團","萬年實業","長興商行"
];

// ══════════════════════════════════════════════════════════════
// 銀行系統 v1
// 功能：借款、存款（活期/定期）、信用評級、違約/破產機制
// NPC 自動評估 ROI 決定是否借款
// ══════════════════════════════════════════════════════════════

// ── 基準利率（央行設定，可調整） ────────────────────────────
var BANK_BASE_RATE = 0.05; // 5% / 貸款期

// ── 信用評級加碼 ─────────────────────────────────────────────
var CREDIT_MARKUP = { A: 0.02, B: 0.04, C: 0.08, D: 0.15 };

// ── 存款利率（固定，低於最低借款利率） ──────────────────────
var DEPOSIT_RATE_DEMAND = 0.02; // 活期 2%（每天計息）
var DEPOSIT_RATE_12D    = 0.04; // 定期 12 天 4%
var DEPOSIT_RATE_24D    = 0.06; // 定期 24 天 6%
var DEPOSIT_EARLY_PENALTY = 0.50; // 提前解約：利息打 50 折

// ── 信用評分門檻 ─────────────────────────────────────────────
var CREDIT_UPGRADE_DAYS  = 10; // 連續正常還款天數 → 升一級
var CREDIT_LATE_ONCE     = 1;  // 逾期 1 次 → 降一級
var CREDIT_D_DEFAULT_DAYS = 5; // D 級連續逾期天數 → 拍賣建築
var CREDIT_AUCTION_RATIO  = 0.60; // 拍賣建築回收比例

// ── 初始化公司銀行帳戶 ──────────────────────────────────────
function ensureBankAccount(company) {
  if (!company.bankAccount) {
    company.bankAccount = {
      creditRating:    'B',   // A/B/C/D
      goodDays:        0,     // 連續正常還款天數
      lateDays:        0,     // 連續逾期天數（D 級專用）
      loans:           [],    // 貸款清單
      deposits:        [],    // 存款清單
      totalLoanPaid:   0,
      totalInterestPaid: 0,
      defaultCount:    0,     // 累計逾期次數
      auctionLog:      [],
    };
  }
  return company.bankAccount;
}

// ── 工具：計算可借款額度 ─────────────────────────────────────
function calcLoanLimit(company) {
  var buildingVal = companyBuildingValue(company);
  var acc = ensureBankAccount(company);
  var outstanding = acc.loans.reduce(function(s, l) { return s + l.remaining; }, 0);
  return Math.max(0, buildingVal * 0.80 - outstanding);
}

// ── 工具：借款利率（依信用評級） ────────────────────────────
function loanRate(company) {
  var rating = ensureBankAccount(company).creditRating;
  return BANK_BASE_RATE + (CREDIT_MARKUP[rating] || CREDIT_MARKUP['B']);
}

// ── 工具：信用評級文字 ────────────────────────────────────────
function creditLabel(rating) {
  return { A:'💚 A（優良）', B:'🟡 B（正常）', C:'🟠 C（警示）', D:'🔴 D（危險）' }[rating] || rating;
}

// ── 借款 ─────────────────────────────────────────────────────
function takeLoan(companyId, amount, termDays) {
  var company = world.companies.find(function(c) { return c.id === companyId; });
  if (!company) return { ok: false, msg: '公司不存在' };
  if (termDays !== 12 && termDays !== 24) return { ok: false, msg: '期數只能選 12 天或 24 天' };
  if (amount <= 0) return { ok: false, msg: '借款金額必須大於 0' };
  var limit = calcLoanLimit(company);
  if (amount > limit) return { ok: false, msg: '超過可借額度（上限 ' + money(limit) + '）' };

  var acc = ensureBankAccount(company);
  var rate = loanRate(company);
  var totalInterest = amount * rate;
  var totalRepay = amount + totalInterest;
  var dailyRepay = totalRepay / termDays;

  var loan = {
    id:          uid(),
    principal:   amount,
    remaining:   amount,
    totalRepay:  totalRepay,
    dailyRepay:  dailyRepay,
    termDays:    termDays,
    daysLeft:    termDays,
    rate:        rate,
    startDay:    world.day,
    dueDay:      world.day + termDays,
    lateCount:   0,
  };
  acc.loans.push(loan);
  company.cash += amount;
  if (company.isPlayer) notify('🏦 借款 ' + money(amount) + '（' + termDays + '天期，利率 ' + (rate * 100).toFixed(0) + '%，每日還款 ' + money(dailyRepay) + '）', company.id);
  return { ok: true, loan: loan };
}

// ── 存款（活期） ──────────────────────────────────────────────
function depositDemand(companyId, amount) {
  var company = world.companies.find(function(c) { return c.id === companyId; });
  if (!company || amount <= 0 || company.cash < amount) return { ok: false, msg: '現金不足或金額無效' };
  var acc = ensureBankAccount(company);
  company.cash -= amount;
  acc.deposits.push({
    id:      uid(),
    type:    'demand',
    amount:  amount,
    startDay: world.day,
    rate:    DEPOSIT_RATE_DEMAND,
    accrued: 0, // 累積利息
  });
  if (company.isPlayer) notify('🏦 活期存款 ' + money(amount) + '（年利率 ' + (DEPOSIT_RATE_DEMAND * 100).toFixed(0) + '%/天）', company.id);
  return { ok: true };
}

// ── 存款（定期） ──────────────────────────────────────────────
function depositFixed(companyId, amount, termDays) {
  var company = world.companies.find(function(c) { return c.id === companyId; });
  if (!company || amount <= 0 || company.cash < amount) return { ok: false, msg: '現金不足或金額無效' };
  if (termDays !== 12 && termDays !== 24) return { ok: false, msg: '定期只支援 12 天或 24 天' };
  var rate = termDays === 12 ? DEPOSIT_RATE_12D : DEPOSIT_RATE_24D;
  var acc = ensureBankAccount(company);
  company.cash -= amount;
  acc.deposits.push({
    id:       uid(),
    type:     'fixed',
    amount:   amount,
    startDay: world.day,
    termDays: termDays,
    dueDay:   world.day + termDays,
    rate:     rate,
    matured:  false,
  });
  if (company.isPlayer) notify('🏦 定期存款 ' + money(amount) + '（' + termDays + '天，利率 ' + (rate * 100).toFixed(0) + '%）', company.id);
  return { ok: true };
}

// ── 提款（活期） ──────────────────────────────────────────────
function withdrawDemand(companyId, depositId) {
  var company = world.companies.find(function(c) { return c.id === companyId; });
  if (!company) return { ok: false, msg: '公司不存在' };
  var acc = ensureBankAccount(company);
  var idx = acc.deposits.findIndex(function(d) { return d.id === depositId && d.type === 'demand'; });
  if (idx === -1) return { ok: false, msg: '找不到活期存款' };
  var dep = acc.deposits[idx];
  var total = dep.amount + dep.accrued;
  company.cash += total;
  acc.deposits.splice(idx, 1);
  if (company.isPlayer) notify('🏦 活期提款 ' + money(total) + '（本金 ' + money(dep.amount) + ' + 利息 ' + money(dep.accrued) + '）', company.id);
  return { ok: true, total: total };
}

// ── 提款（定期，提前解約或到期） ────────────────────────────
function withdrawFixed(companyId, depositId) {
  var company = world.companies.find(function(c) { return c.id === companyId; });
  if (!company) return { ok: false, msg: '公司不存在' };
  var acc = ensureBankAccount(company);
  var idx = acc.deposits.findIndex(function(d) { return d.id === depositId && d.type === 'fixed'; });
  if (idx === -1) return { ok: false, msg: '找不到定期存款' };
  var dep = acc.deposits[idx];
  var isMatured = (world.day >= dep.dueDay);
  var interest, penalty = '';
  if (isMatured) {
    interest = dep.amount * dep.rate;
  } else {
    // 提前解約：按活期計息 × 50%
    var daysHeld = world.day - dep.startDay;
    interest = dep.amount * DEPOSIT_RATE_DEMAND * daysHeld * DEPOSIT_EARLY_PENALTY;
    penalty = '（提前解約，利息打 50 折）';
  }
  var total = dep.amount + interest;
  company.cash += total;
  // 利息支出從銀行錢包扣除（提前解約利息已打折，仍需記帳）
  world.bank.wallet            -= interest;
  world.bank.totalInterestPaid += interest;
  acc.deposits.splice(idx, 1);
  if (company.isPlayer) notify('🏦 定期' + (isMatured ? '到期' : '提前解約') + penalty + '：取回 ' + money(total) + '（利息 ' + money(interest) + '）', company.id);
  return { ok: true, total: total, interest: interest, early: !isMatured };
}

// ── 每天銀行 tick（還款 / 計息 / 信用 / 違約） ──────────────
function tickBankSystem() {
  if (world.dayTick !== 1) return; // 每天只執行一次（新天第一 tick）

  world.companies.forEach(function(company) {
    if (!company.bankAccount) return;
    var acc = company.bankAccount;

    // ① 活期存款計息
    acc.deposits.forEach(function(dep) {
      if (dep.type === 'demand') {
        var dailyInterest = dep.amount * DEPOSIT_RATE_DEMAND;
        dep.accrued = (dep.accrued || 0) + dailyInterest;
        // 利息支出從銀行錢包扣除
        world.bank.wallet            -= dailyInterest;
        world.bank.totalInterestPaid += dailyInterest;
      }
    });

    // ② 定期存款到期自動返還
    var matured = acc.deposits.filter(function(d) { return d.type === 'fixed' && world.day >= d.dueDay && !d.matured; });
    matured.forEach(function(dep) {
      dep.matured = true;
      var interest = dep.amount * dep.rate;
      var total = dep.amount + interest;
      company.cash += total;
      // 利息支出從銀行錢包扣除
      world.bank.wallet            -= interest;
      world.bank.totalInterestPaid += interest;
      var idx = acc.deposits.indexOf(dep);
      if (idx !== -1) acc.deposits.splice(idx, 1);
      if (company.isPlayer) notify('🏦 定期存款到期：取回 ' + money(total) + '（利息 ' + money(interest) + '）', company.id);
    });

    // ③ 貸款每日還款
    var hadLate = false;
    acc.loans.forEach(function(loan) {
      if (loan.daysLeft <= 0) return;
      if (company.cash >= loan.dailyRepay) {
        company.cash -= loan.dailyRepay;
        var dailyPrincipal = loan.principal / loan.termDays;
        var dailyInterest  = loan.dailyRepay - dailyPrincipal;
        loan.remaining = Math.max(0, loan.remaining - dailyPrincipal);
        loan.daysLeft--;
        acc.totalLoanPaid     += loan.dailyRepay;
        acc.totalInterestPaid += dailyInterest;
        // 利息收入流入銀行錢包
        world.bank.wallet             += dailyInterest;
        world.bank.totalInterestEarned += dailyInterest;
        acc.goodDays++;
      } else {
        // 逾期
        loan.lateCount++;
        acc.defaultCount++;
        acc.goodDays = 0;
        hadLate = true;
        if (company.isPlayer) notify('⚠️ 貸款逾期！現金不足，今日未能還款（剩 ' + money(loan.remaining) + '）', company.id);
      }
    });

    // 移除還清的貸款
    acc.loans = acc.loans.filter(function(l) { return l.daysLeft > 0 && l.remaining > 0.01; });

    // ④ 信用評級更新
    updateCreditRating(company, acc, hadLate);

    // ⑤ D 級連續逾期 → 拍賣建築
    if (acc.creditRating === 'D' && hadLate) {
      acc.lateDays = (acc.lateDays || 0) + 1;
      if (acc.lateDays >= CREDIT_D_DEFAULT_DAYS) {
        auctionBuilding(company, acc);
      }
    } else {
      acc.lateDays = 0;
    }
  });

  // ── 更新銀行總額快取（即時統計所有公司） ────────────────
  var sumDeposits = 0, sumLoans = 0;
  world.companies.forEach(function(c) {
    if (!c.bankAccount) return;
    c.bankAccount.deposits.forEach(function(d) {
      sumDeposits += d.amount + (d.accrued || 0);
    });
    c.bankAccount.loans.forEach(function(l) {
      sumLoans += l.remaining;
    });
  });
  world.bank.totalDeposits = sumDeposits;
  world.bank.totalLoansOut = sumLoans;
}

// ── 信用評級更新 ─────────────────────────────────────────────
function updateCreditRating(company, acc, hadLate) {
  var order = ['A', 'B', 'C', 'D'];
  var idx = order.indexOf(acc.creditRating);
  if (hadLate) {
    acc.goodDays = 0;
    // 降一級
    if (idx < order.length - 1) {
      acc.creditRating = order[idx + 1];
      if (company.isPlayer) notify('📉 信用評級下降：' + creditLabel(acc.creditRating), company.id);
    }
  } else {
    // 累積 goodDays，達門檻升一級
    if (acc.goodDays >= CREDIT_UPGRADE_DAYS && idx > 0) {
      acc.creditRating = order[idx - 1];
      acc.goodDays = 0;
      if (company.isPlayer) notify('📈 信用評級提升：' + creditLabel(acc.creditRating), company.id);
    }
  }
}

// ── 拍賣建築 ─────────────────────────────────────────────────
function auctionBuilding(company, acc) {
  // 修復：核心建築（超市/蓄水池/農場）不可拍賣，否則公司永久停擺
  var PROTECTED_TYPES = {"supermarket":true, "reservoir":true, "farm":true};

  // 選最貴的完工建築拍賣（排除核心建築）
  var candidates = company.buildings.filter(function(b) {
    return b.isCompleted && (b.purchaseCost || 0) > 0 && !PROTECTED_TYPES[b.type];
  }).sort(function(a, b) { return (b.purchaseCost || 0) - (a.purchaseCost || 0); });

  // 若無非核心建築可拍賣，才考慮核心建築（最後手段）
  if (!candidates.length) {
    candidates = company.buildings.filter(function(b) {
      return b.isCompleted && (b.purchaseCost || 0) > 0;
    }).sort(function(a, b) { return (b.purchaseCost || 0) - (a.purchaseCost || 0); });
  }

  if (!candidates.length) {
    company.bankrupt = true;
    notify('💀 ' + company.name + ' 因無法清償債務，宣告破產！');
    return;
  }

  var bldg = candidates[0];
  var proceeds = (bldg.purchaseCost || 0) * CREDIT_AUCTION_RATIO;
  company.cash += proceeds;
  company.buildings = company.buildings.filter(function(b) { return b.id !== bldg.id; });

  world.venues = world.venues.filter(function(v) { return v.buildingId !== bldg.id; });

  acc.auctionLog.unshift({ day: world.day, building: BUILDINGS[bldg.type].name, proceeds: proceeds });
  acc.lateDays = 0;

  notify('🔨 ' + company.name + ' 建築「' + BUILDINGS[bldg.type].name + '」被拍賣，回收 ' + money(proceeds));

  acc.loans.forEach(function(loan) {
    if (company.cash >= loan.remaining) {
      company.cash -= loan.remaining;
      acc.totalLoanPaid += loan.remaining;
      loan.remaining = 0;
      loan.daysLeft = 0;
    }
  });
  acc.loans = acc.loans.filter(function(l) { return l.remaining > 0.01; });

  var totalOwed = acc.loans.reduce(function(s, l) { return s + l.remaining; }, 0);
  if (totalOwed > 0 && company.buildings.filter(function(b) { return b.isCompleted; }).length === 0) {
    company.bankrupt = true;
    notify('💀 ' + company.name + ' 資產耗盡，宣告破產！');
  }
}

// ── NPC 自動借款評估 ─────────────────────────────────────────
// 只有當預期 ROI > 借款利率時才借
function npcEvaluateLoan(npc) {
  if (npc.bankrupt) return;
  var acc = ensureBankAccount(npc);
  if (acc.creditRating === 'D') return; // D 級不再借
  if (acc.loans.length >= 2) return;    // 最多同時持有 2 筆

  var limit = calcLoanLimit(npc);
  if (limit < 500) return; // 額度太小無意義

  var rate = loanRate(npc);

  // 估算預期 ROI：用最近的毛利率作為參考
  // 簡化：若公司有完工建築且現金 < 建築總價值的 50%，且毛利率 > 借款利率，才借
  var buildingVal = companyBuildingValue(npc);
  if (buildingVal === 0) return;
  var cashRatio = npc.cash / buildingVal;
  if (cashRatio > 0.5) return; // 現金充裕，不需要借

  // 從 npcState 取得最高毛利率
  var bestMargin = 0;
  if (npc.npcState && npc.npcState.productStats) {
    // 無直接 margin 記錄，用最近 decisionLog 估算
  }
  // 保守估算：只有在現金 < 建築價值 20% 且信用 A/B 時才借一小筆
  if (cashRatio > 0.2) return;
  if (acc.creditRating !== 'A' && acc.creditRating !== 'B') return;

  var borrowAmt = Math.min(limit, buildingVal * 0.3);
  if (borrowAmt < 300) return;

  // 確認預期收益大於利率成本
  var expectedReturn = borrowAmt * 0.12; // 保守預期 12% 投資回報
  var loanCost = borrowAmt * rate;
  if (expectedReturn <= loanCost) return;

  takeLoan(npc.id, Math.floor(borrowAmt), 12);
}

// ── 取得公司所有存款總額（含利息） ──────────────────────────
function totalDepositValue(company) {
  if (!company.bankAccount) return 0;
  return company.bankAccount.deposits.reduce(function(s, d) {
    if (d.type === 'demand') return s + d.amount + (d.accrued || 0);
    return s + d.amount; // 定期：本金（利息到期才計入）
  }, 0);
}

// ── 取得公司未償還貸款總額 ───────────────────────────────────
function totalLoanOutstanding(company) {
  if (!company.bankAccount) return 0;
  return company.bankAccount.loans.reduce(function(s, l) { return s + l.remaining; }, 0);
}

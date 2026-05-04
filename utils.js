// ─── Pure computation functions (no database access) ─────────────────────────
// Extracted from sheets.js during the Supabase migration.
// These are all deterministic functions: date math, text parsing, formatting.

const { isCommitted, parseIndianDate, getCategoryEmoji } = require('./constants');

// ─── Salary cycle ────────────────────────────────────────────────────────────
// Default cycle is the calendar month. Users configure their actual pay date
// via "salary 26" / "salary last" / "salary last working day" — see
// computeUserCycleBounds for the three configurable types.
function getSalaryCycleBounds(referenceDate, userConfig) {
  const d = referenceDate || new Date();
  const today = new Date(d.getFullYear(), d.getMonth(), d.getDate());

  if (userConfig && userConfig.salaryType) {
    return computeUserCycleBounds(today, userConfig);
  }

  const cycleStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const cycleEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0);
  cycleEnd.setHours(23, 59, 59, 999);
  return { cycleStart, cycleEnd };
}

function computeUserCycleBounds(today, config) {
  let cycleStart, cycleEnd;

  if (config.salaryType === 'fixed' && config.salaryDay) {
    const day = config.salaryDay;
    if (today.getDate() >= day) {
      cycleStart = new Date(today.getFullYear(), today.getMonth(), day);
      cycleEnd = new Date(today.getFullYear(), today.getMonth() + 1, day - 1);
    } else {
      cycleStart = new Date(today.getFullYear(), today.getMonth() - 1, day);
      cycleEnd = new Date(today.getFullYear(), today.getMonth(), day - 1);
    }
  } else if (config.salaryType === 'last') {
    const lastDayThisMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
    if (today.getDate() >= lastDayThisMonth) {
      cycleStart = new Date(today.getFullYear(), today.getMonth() + 1, 0);
      cycleEnd = new Date(today.getFullYear(), today.getMonth() + 2, 0);
      cycleEnd.setDate(cycleEnd.getDate() - 1);
    } else {
      cycleStart = new Date(today.getFullYear(), today.getMonth(), 0);
      cycleEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0);
      cycleEnd.setDate(cycleEnd.getDate() - 1);
    }
  } else if (config.salaryType === 'last_working') {
    const getLastWeekday = (year, month) => {
      const last = new Date(year, month + 1, 0);
      while (last.getDay() === 0 || last.getDay() === 6) last.setDate(last.getDate() - 1);
      return last;
    };
    const lwdThisMonth = getLastWeekday(today.getFullYear(), today.getMonth());
    if (today >= lwdThisMonth) {
      cycleStart = new Date(lwdThisMonth);
      const lwdNext = getLastWeekday(today.getFullYear(), today.getMonth() + 1);
      cycleEnd = new Date(lwdNext);
      cycleEnd.setDate(cycleEnd.getDate() - 1);
    } else {
      cycleStart = getLastWeekday(today.getFullYear(), today.getMonth() - 1);
      cycleEnd = new Date(lwdThisMonth);
      cycleEnd.setDate(cycleEnd.getDate() - 1);
    }
  } else {
    cycleStart = new Date(today.getFullYear(), today.getMonth(), 1);
    cycleEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0);
  }

  cycleEnd.setHours(23, 59, 59, 999);
  return { cycleStart, cycleEnd };
}

function getCycleLabel() {
  const { cycleStart, cycleEnd } = getSalaryCycleBounds();
  const fmt = d => d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
  return fmt(cycleStart) + ' – ' + fmt(cycleEnd);
}

// ─── Summary helpers (operate on row arrays) ────────────────────────────────
function buildCategoryTotals(rows, filterFn) {
  const byCategory = {};
  let total = 0;
  const filtered = rows.filter(r => r[0] && r[2] && filterFn(parseIndianDate(r[0])));
  for (const row of filtered) {
    const amt = parseFloat(row[2]);
    if (isNaN(amt)) continue;
    const cat = row[3] || 'Other';
    byCategory[cat] = (byCategory[cat] || 0) + amt;
    total += amt;
  }
  return { byCategory, total, count: filtered.length };
}

function buildSummaryText(byCategory) {
  return Object.entries(byCategory)
    .sort((a, b) => b[1] - a[1])
    .map(([cat, amt]) => getCategoryEmoji(cat) + ' ' + cat + '   ₹' + Math.round(amt).toLocaleString('en-IN'))
    .join('\n') || '  No expenses yet.';
}

function buildDiscretionarySplit(byCategory, total) {
  let committed = 0, discretionary = 0;
  for (const [cat, amt] of Object.entries(byCategory)) {
    isCommitted(cat) ? (committed += amt) : (discretionary += amt);
  }
  const discPct = total > 0 ? Math.round((discretionary / total) * 100) : 0;
  const commPct = total > 0 ? Math.round((committed / total) * 100) : 0;
  return (
    '\n━━━━━━━━━━━━\n' +
    '🔒 Committed   ₹' + Math.round(committed).toLocaleString('en-IN') + '  (' + commPct + '%)\n' +
    '🎲 Discretionary   ₹' + Math.round(discretionary).toLocaleString('en-IN') + '  (' + discPct + '%)'
  );
}

function buildProgressBar(pct) {
  const filled = Math.min(10, Math.round(pct / 10));
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
}

function getISOWeek(d) {
  const date = new Date(d);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + 3 - (date.getDay() + 6) % 7);
  const week1 = new Date(date.getFullYear(), 0, 4);
  return `${date.getFullYear()}-W${String(1 + Math.round(((date.getTime() - week1.getTime()) / 86400000 - 3 + (week1.getDay() + 6) % 7) / 7)).padStart(2, '0')}`;
}

// ─── Salary/statement parsing ───────────────────────────────────────────────
function parseSalaryInput(input) {
  const s = input.toLowerCase().trim();
  if (s === 'last' || s === 'end of month' || s === 'eom') return { type: 'last', day: null };
  if (s.includes('last working') || s.includes('last weekday') || s.includes('lwd')) return { type: 'last_working', day: null };
  const num = parseInt(s.replace(/[^0-9]/g, ''));
  if (!isNaN(num) && num >= 1 && num <= 31) return { type: 'fixed', day: num };
  return null;
}

function parseStatementInput(input) {
  // Reject bank SMS / debit alerts — these are NOT statement date replies
  if (/\b(debited|credited|balance|transaction|acct|account|transferred|withdrawn|deposited|upi|neft|imps|otp|avl\s*bal)\b/i.test(input)) {
    return {};
  }
  // Reject messages with currency amounts (Rs 163.00, INR 5000) — bank SMS pattern
  if (/\b(rs|inr)\s*\.?\s*\d{3,}/i.test(input)) {
    return {};
  }

  const results = {};
  const matches = input.matchAll(/([a-zA-Z]+[\w\s]*?)\s*[:\-]?\s*(\d{1,2})/g);
  const fillerWords = /\b(is|on|the|my|card|statement|date|of|at)\b/gi;
  for (const m of matches) {
    let card = m[1].trim().replace(fillerWords, '').replace(/\s+/g, ' ').trim().toUpperCase();
    if (!card) continue; // skip if only filler words
    const day = parseInt(m[2]);
    if (day >= 1 && day <= 31) results[card] = day;
  }
  if (Object.keys(results).length === 0) {
    const num = parseInt(input.trim());
    if (!isNaN(num) && num >= 1 && num <= 31) return { _single: num };
  }
  return results;
}

function getDaysUntilStatement(statementDay) {
  const now = new Date();
  const today = now.getDate();
  if (today < statementDay) return statementDay - today;
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  return (daysInMonth - today) + statementDay;
}

function getBillingCycleAdvice(statementDates) {
  if (!statementDates || Object.keys(statementDates).length === 0) return null;
  const advice = Object.entries(statementDates).map(([card, day]) => {
    const daysUntil = getDaysUntilStatement(day);
    const interestFreeDays = daysUntil + 20;
    return { card, statementDay: day, daysUntilStatement: daysUntil, interestFreeDays };
  });
  advice.sort((a, b) => b.interestFreeDays - a.interestFreeDays);
  return advice;
}

// ─── Setup-hint persistence ─────────────────────────────────────────────────
// Tracks whether we've already asked the user about CC / salary setup so we
// don't nag them on every restart. Two states:
//   'sent'  — user gave a definitive yes/no; never re-ask
//   'later' — user tapped "Later"; re-ask after `cooldownDays`
//
// Shape stored in users.setup_hints_sent:
//   { cc: { state: 'sent' | 'later', askedAt: '<iso>' }, salary: { ... } }
function shouldAskHint(user, kind, cooldownDays) {
  const days = typeof cooldownDays === 'number' ? cooldownDays : 7;
  const h = (user && user.setupHintsSent) ? user.setupHintsSent[kind] : null;
  if (!h) return true;
  if (h.state === 'sent') return false;
  if (h.state === 'later' && h.askedAt) {
    const ageDays = (Date.now() - new Date(h.askedAt).getTime()) / 86400000;
    return ageDays >= days;
  }
  return true; // unknown state shape — re-ask
}

function buildHintUpdate(user, kind, state) {
  const current = (user && user.setupHintsSent) ? user.setupHintsSent : {};
  return {
    ...current,
    [kind]: { state, askedAt: new Date().toISOString() }
  };
}

// ─── Session window ─────────────────────────────────────────────────────────
function isWithinSessionWindow(user) {
  if (!user || !user.lastMessageAt) return false;
  const lastMsg = new Date(user.lastMessageAt);
  const hoursSince = (Date.now() - lastMsg.getTime()) / (1000 * 60 * 60);
  return hoursSince < 24;
}

// ─── Household ID generator ─────────────────────────────────────────────────
function generateHouseholdId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let code = 'hh_';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// ─── Forecasting helpers ────────────────────────────────────────────────────
// Both pure — no DB access, no side effects. Tested in test/forecasting.test.js.

/**
 * Exponential weighted moving average. Recent values weight more.
 * halfLife = number of "steps" after which weight halves. Default 7 (days).
 * Returns the EWMA evaluated at the latest point (suitable as a "current rate").
 *
 * @param {number[]} values - chronologically ordered series (oldest → newest).
 * @param {number} halfLife
 */
function computeEwma(values, halfLife) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  const hl = Math.max(1, halfLife || 7);
  const alpha = 1 - Math.pow(0.5, 1 / hl);
  let v = Number(values[0]) || 0;
  for (let i = 1; i < values.length; i++) {
    const x = Number(values[i]) || 0;
    v = alpha * x + (1 - alpha) * v;
  }
  return v;
}

/**
 * Day-of-week factors. Given a series of [{date: Date, amount: number}],
 * returns factor[0..6] where factor[d] = avgSpendOnDow_d / globalAvg.
 * Returns all-1.0 (no adjustment) if history is too sparse.
 *
 * @param {Array<{date: Date|string, amount: number}>} history
 * @returns {{factors: number[], counts: number[], avgByDow: number[], avgGlobal: number}}
 */
function computeDowFactors(history) {
  const sumByDow = [0, 0, 0, 0, 0, 0, 0];
  const countByDow = [0, 0, 0, 0, 0, 0, 0];
  let total = 0;
  let totalCount = 0;
  for (const r of history || []) {
    const d = r.date instanceof Date ? r.date : new Date(r.date);
    if (isNaN(d.getTime())) continue;
    const amt = Number(r.amount) || 0;
    const dow = d.getDay();
    sumByDow[dow] += amt;
    countByDow[dow]++;
    total += amt;
    totalCount++;
  }
  // Need at least one observation per DOW to compute factors; otherwise neutral.
  const minObservations = 4; // rough heuristic
  if (totalCount < minObservations || total === 0) {
    return { factors: [1, 1, 1, 1, 1, 1, 1], counts: countByDow, avgByDow: [0, 0, 0, 0, 0, 0, 0], avgGlobal: 0 };
  }
  const avgGlobal = total / totalCount;
  const avgByDow = sumByDow.map((s, i) => countByDow[i] > 0 ? s / countByDow[i] : avgGlobal);
  const factors = avgByDow.map(a => avgGlobal > 0 ? a / avgGlobal : 1);
  return { factors, counts: countByDow, avgByDow, avgGlobal };
}

/**
 * Forecast remaining-cycle spend using EWMA daily rate × DOW factors per day.
 *
 * @param {Date} fromDate - start of the projection window (typically tomorrow)
 * @param {Date} toDate   - end (inclusive) of the projection window
 * @param {number} dailyRate - EWMA-estimated rate per day (₹/day)
 * @param {number[]} dowFactors - 7-element factor array from computeDowFactors
 */
function projectRemainingCycle(fromDate, toDate, dailyRate, dowFactors) {
  let total = 0;
  const cur = new Date(fromDate);
  cur.setHours(0, 0, 0, 0);
  const end = new Date(toDate);
  end.setHours(0, 0, 0, 0);
  while (cur.getTime() <= end.getTime()) {
    const f = (dowFactors && dowFactors[cur.getDay()]) || 1;
    total += dailyRate * f;
    cur.setDate(cur.getDate() + 1);
  }
  return total;
}

module.exports = {
  getSalaryCycleBounds,
  computeUserCycleBounds,
  getCycleLabel,
  buildCategoryTotals,
  buildSummaryText,
  buildDiscretionarySplit,
  buildProgressBar,
  getISOWeek,
  parseSalaryInput,
  parseStatementInput,
  getDaysUntilStatement,
  getBillingCycleAdvice,
  isWithinSessionWindow,
  generateHouseholdId,
  shouldAskHint,
  buildHintUpdate,
  computeEwma,
  computeDowFactors,
  projectRemainingCycle
};

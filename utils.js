// ─── Pure computation functions (no database access) ─────────────────────────
// Extracted from sheets.js during the Supabase migration.
// These are all deterministic functions: date math, text parsing, formatting.

const { isCommitted, parseIndianDate, getCategoryEmoji } = require('./constants');

// ─── Salary cycle (Salesforce India 2026 pay schedule) ───────────────────────
const PAY_DATES_2026 = [
  new Date('2026-01-29'),
  new Date('2026-02-26'),
  new Date('2026-03-27'),
  new Date('2026-04-29'),
  new Date('2026-05-28'),
  new Date('2026-06-29'),
  new Date('2026-07-29'),
  new Date('2026-08-28'),
  new Date('2026-09-29'),
  new Date('2026-10-29'),
  new Date('2026-11-27'),
  new Date('2026-12-29'),
];

function getSalaryCycleBounds(referenceDate, userConfig) {
  const d = referenceDate || new Date();
  const today = new Date(d.getFullYear(), d.getMonth(), d.getDate());

  if (userConfig && userConfig.salaryType) {
    return computeUserCycleBounds(today, userConfig);
  }

  let cycleStart = null;
  for (let i = PAY_DATES_2026.length - 1; i >= 0; i--) {
    if (PAY_DATES_2026[i] <= today) { cycleStart = PAY_DATES_2026[i]; break; }
  }

  let cycleEnd = null;
  for (let i = 0; i < PAY_DATES_2026.length; i++) {
    if (PAY_DATES_2026[i] > (cycleStart || today)) {
      cycleEnd = new Date(PAY_DATES_2026[i]);
      cycleEnd.setDate(cycleEnd.getDate() - 1);
      break;
    }
  }

  if (!cycleStart) cycleStart = new Date(today.getFullYear(), today.getMonth(), 1);
  if (!cycleEnd) cycleEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0);

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

module.exports = {
  PAY_DATES_2026,
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
  generateHouseholdId
};

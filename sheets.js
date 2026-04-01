const { google } = require('googleapis');

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME = 'Expenses';
const BUDGET_SHEET = 'Budgets';
const HEADERS = ['Date', 'Time', 'Amount (₹)', 'Category', 'Merchant', 'Note', 'Raw Message'];
const BUDGET_HEADERS = ['Category', 'Monthly Budget (₹)'];

// ─── Committed vs Discretionary ───────────────────────────────────────────────
const COMMITTED_CATEGORIES = new Set([
  'Rent', 'Loan EMI', 'Investments', 'Family Transfer', 'Utilities', 'Subscriptions', 'Credit Card Payment'
]);

function isCommitted(category) {
  return COMMITTED_CATEGORIES.has(category);
}

// ─── Salary cycle (Salesforce India 2026 pay schedule) ───────────────────────
// Cycles run from pay date → day before next pay date

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

function getSalaryCycleBounds(referenceDate) {
  const d = referenceDate || new Date();
  const today = new Date(d.getFullYear(), d.getMonth(), d.getDate()); // strip time

  // Find the most recent pay date on or before today
  let cycleStart = null;
  for (let i = PAY_DATES_2026.length - 1; i >= 0; i--) {
    if (PAY_DATES_2026[i] <= today) {
      cycleStart = PAY_DATES_2026[i];
      break;
    }
  }

  // Find the next pay date after cycleStart
  let cycleEnd = null;
  for (let i = 0; i < PAY_DATES_2026.length; i++) {
    if (PAY_DATES_2026[i] > (cycleStart || today)) {
      // Cycle ends the day before the next pay date
      cycleEnd = new Date(PAY_DATES_2026[i]);
      cycleEnd.setDate(cycleEnd.getDate() - 1);
      break;
    }
  }

  // Fallbacks for dates outside the 2026 schedule
  if (!cycleStart) cycleStart = new Date(today.getFullYear(), today.getMonth(), 1);
  if (!cycleEnd) {
    cycleEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0); // end of month
  }

  cycleEnd.setHours(23, 59, 59, 999);
  return { cycleStart, cycleEnd };
}

function getCycleLabel() {
  const { cycleStart, cycleEnd } = getSalaryCycleBounds();
  const fmt = d => d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
  return fmt(cycleStart) + ' – ' + fmt(cycleEnd);
}

// ─── Auth ─────────────────────────────────────────────────────────────────────
function getAuth() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  return new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
}

async function getSheetsClient() {
  const auth = await getAuth();
  return google.sheets({ version: 'v4', auth });
}

// ─── Init ─────────────────────────────────────────────────────────────────────
async function initSheet() {
  const sheets = await getSheetsClient();

  // Expenses sheet
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${SHEET_NAME}!A1:G1` });
  if (!res.data.values?.[0] || res.data.values[0][0] !== 'Date') {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID, range: `${SHEET_NAME}!A1:G1`,
      valueInputOption: 'RAW', requestBody: { values: [HEADERS] }
    });
    console.log('✅ Expenses sheet headers initialised');
  }

  // Budgets sheet — create if missing
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const budgetExists = meta.data.sheets.some(s => s.properties.title === BUDGET_SHEET);
  if (!budgetExists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: BUDGET_SHEET } } }] }
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID, range: `${BUDGET_SHEET}!A1:B1`,
      valueInputOption: 'RAW', requestBody: { values: [BUDGET_HEADERS] }
    });
    console.log('✅ Budgets sheet created');
  }
}

// ─── Expenses ─────────────────────────────────────────────────────────────────
async function appendExpense({ amount, category, merchant, note, raw }) {
  const sheets = await getSheetsClient();
  const now = new Date();
  const date = now.toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const time = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID, range: `${SHEET_NAME}!A:G`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[date, time, amount, category, merchant || '', note || '', raw]] }
  });
}

async function batchAppendExpenses(transactions) {
  const sheets = await getSheetsClient();
  const rows = transactions.map(tx => {
    const d = new Date(tx.date);
    const date = d.toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' });
    return [date, 'imported', tx.amount, tx.category, tx.merchant || '', tx.note || '', '[PDF import]'];
  });
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID, range: `${SHEET_NAME}!A:G`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: rows }
  });
}

async function getAllRows() {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${SHEET_NAME}!A:G` });
  return (res.data.values || []).slice(1);
}

// ─── Budgets ──────────────────────────────────────────────────────────────────
async function getBudgets() {
  const sheets = await getSheetsClient();
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${BUDGET_SHEET}!A:B` });
    const rows = (res.data.values || []).slice(1);
    const budgets = {};
    for (const row of rows) {
      if (row[0] && row[1]) budgets[row[0]] = parseFloat(row[1]);
    }
    return budgets;
  } catch { return {}; }
}

// suggestBudgets: needs at least 2 complete weeks of data
// Suggests ~10% below average weekly spend * 4 for each discretionary category
async function suggestBudgets() {
  const rows = await getAllRows();
  const now = new Date();

  const byWeek = {};
  for (const row of rows) {
    if (!row[0] || !row[2]) continue;
    const d = parseIndianDate(row[0]);
    if (!d) continue;
    const wk = getISOWeek(d);
    const currentWk = getISOWeek(now);
    if (wk === currentWk) continue; // exclude current incomplete week
    if (!byWeek[wk]) byWeek[wk] = {};
    const cat = row[3] || 'Other';
    const amt = parseFloat(row[2]);
    if (!isNaN(amt)) byWeek[wk][cat] = (byWeek[wk][cat] || 0) + amt;
  }

  const completedWeeks = Object.values(byWeek);
  if (completedWeeks.length < 2) {
    return { ready: false, weeksLogged: completedWeeks.length };
  }

  const allCats = [...new Set(completedWeeks.flatMap(w => Object.keys(w)))];
  const suggestions = [];

  for (const cat of allCats) {
    const weeklyAmts = completedWeeks.map(w => w[cat] || 0);
    const avgWeekly = weeklyAmts.reduce((a, b) => a + b, 0) / completedWeeks.length;
    if (avgWeekly < 100) continue; // skip negligible categories

    // Suggest ~10% below monthly run-rate (avg weekly * 4.33)
    const monthlyRunRate = avgWeekly * 4.33;
    const suggested = Math.round(monthlyRunRate * 0.9 / 100) * 100; // round to nearest 100

    suggestions.push({
      category: cat,
      avgMonthly: Math.round(monthlyRunRate),
      suggested,
      committed: isCommitted(cat)
    });
  }

  return {
    ready: true,
    weeksLogged: completedWeeks.length,
    suggestions: suggestions.sort((a, b) => b.avgMonthly - a.avgMonthly)
  };
}

// ─── Summary helpers ──────────────────────────────────────────────────────────
function parseIndianDate(dateStr) {
  const parts = dateStr.split('/');
  if (parts.length !== 3) return null;
  return new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0]));
}

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

async function getMonthlySummary() {
  const rows = await getAllRows();
  const { cycleStart, cycleEnd } = getSalaryCycleBounds();
  const { byCategory, total, count } = buildCategoryTotals(rows,
    d => d && d >= cycleStart && d <= cycleEnd
  );
  return {
    total: Math.round(total).toLocaleString('en-IN'),
    breakdown: buildSummaryText(byCategory),
    discretionarySplit: buildDiscretionarySplit(byCategory, total),
    cycleLabel: getCycleLabel(),
    count,
    byCategory
  };
}

async function getWeeklySummary() {
  const rows = await getAllRows();
  const now = new Date();
  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - now.getDay());
  startOfWeek.setHours(0, 0, 0, 0);
  const { byCategory, total, count } = buildCategoryTotals(rows, d => d && d >= startOfWeek);
  return {
    total: Math.round(total).toLocaleString('en-IN'),
    breakdown: buildSummaryText(byCategory),
    discretionarySplit: buildDiscretionarySplit(byCategory, total),
    count,
    byCategory
  };
}

// ─── Budget status ────────────────────────────────────────────────────────────
async function getBudgetStatus() {
  const [budgets, rows] = await Promise.all([getBudgets(), getAllRows()]);
  if (Object.keys(budgets).length === 0) return null;

  const now = new Date();
  const { byCategory } = buildCategoryTotals(rows,
    d => d && d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear()
  );

  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const dayOfMonth = now.getDate();
  const monthProgress = dayOfMonth / daysInMonth;

  const lines = [];
  for (const [cat, budget] of Object.entries(budgets)) {
    const spent = byCategory[cat] || 0;
    const pct = Math.round((spent / budget) * 100);
    const expectedPct = Math.round(monthProgress * 100);
    const bar = buildProgressBar(pct);
    const status = pct >= 100 ? '🔴' : pct >= 70 ? '🟡' : '🟢';
    const pace = pct > expectedPct + 15 ? ' ⚡ahead of pace' : '';
    lines.push(`${status} ${cat}\n  ${bar} ${pct}% of ₹${Math.round(budget).toLocaleString('en-IN')}${pace}`);
  }

  return lines.join('\n\n');
}

function buildProgressBar(pct) {
  const filled = Math.min(10, Math.round(pct / 10));
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
}

// ─── Anomaly detection ────────────────────────────────────────────────────────
async function checkAnomaly(amount, category) {
  const rows = await getAllRows();
  const now = new Date();

  // Get past 60 days of transactions in this category (excluding today)
  const past = rows.filter(r => {
    if (!r[0] || !r[2] || r[3] !== category) return false;
    const d = parseIndianDate(r[0]);
    if (!d) return false;
    const daysAgo = (now - d) / (1000 * 60 * 60 * 24);
    return daysAgo > 0 && daysAgo <= 60;
  }).map(r => parseFloat(r[2])).filter(n => !isNaN(n));

  if (past.length < 3) {
    // No history — flag if >₹5000 for discretionary, >₹50000 for committed
    const threshold = isCommitted(category) ? 50000 : 5000;
    return amount > threshold ? { type: 'large', amount, threshold } : null;
  }

  const avg = past.reduce((a, b) => a + b, 0) / past.length;
  const max = Math.max(...past);

  // Flag if 3x the average OR higher than any previous transaction
  if (amount > avg * 3 && amount > 1000) {
    return { type: 'spike', amount, avg: Math.round(avg), multiple: Math.round(amount / avg) };
  }
  if (amount > max * 1.5 && amount > 2000) {
    return { type: 'high', amount, prev_max: Math.round(max) };
  }
  return null;
}

// ─── Overspend (weekly baseline) ──────────────────────────────────────────────
async function getOverspendAlerts() {
  const rows = await getAllRows();
  const now = new Date();
  const byWeek = {};

  for (const row of rows) {
    if (!row[0] || !row[2]) continue;
    const d = parseIndianDate(row[0]);
    if (!d) continue;
    const wk = getISOWeek(d);
    const currentWk = getISOWeek(now);
    if (wk === currentWk) continue;
    if (!byWeek[wk]) byWeek[wk] = {};
    const cat = row[3] || 'Other';
    const amt = parseFloat(row[2]);
    if (!isNaN(amt)) byWeek[wk][cat] = (byWeek[wk][cat] || 0) + amt;
  }

  const completedWeeks = Object.values(byWeek);
  if (completedWeeks.length < 2) return null;

  const baseline = {};
  const allCats = [...new Set(completedWeeks.flatMap(w => Object.keys(w)))];
  for (const cat of allCats) {
    baseline[cat] = completedWeeks.reduce((s, w) => s + (w[cat] || 0), 0) / completedWeeks.length;
  }

  const currentWk = getISOWeek(now);
  const currentWeek = {};
  for (const row of rows) {
    if (!row[0] || !row[2]) continue;
    const d = parseIndianDate(row[0]);
    if (!d || getISOWeek(d) !== currentWk) continue;
    const cat = row[3] || 'Other';
    const amt = parseFloat(row[2]);
    if (!isNaN(amt)) currentWeek[cat] = (currentWeek[cat] || 0) + amt;
  }

  const alerts = [];
  for (const [cat, spent] of Object.entries(currentWeek)) {
    const base = baseline[cat];
    if (!base) continue;
    const pct = ((spent - base) / base) * 100;
    if (pct > 20) alerts.push({ category: cat, spent: Math.round(spent), baseline: Math.round(base), pct: Math.round(pct) });
  }

  return alerts.length > 0 ? { alerts, weeksOfData: completedWeeks.length } : null;
}

function getISOWeek(d) {
  const date = new Date(d);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + 3 - (date.getDay() + 6) % 7);
  const week1 = new Date(date.getFullYear(), 0, 4);
  return `${date.getFullYear()}-W${String(1 + Math.round(((date.getTime() - week1.getTime()) / 86400000 - 3 + (week1.getDay() + 6) % 7) / 7)).padStart(2, '0')}`;
}

// ─── Undo ─────────────────────────────────────────────────────────────────────
async function undoLast() {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${SHEET_NAME}!A:G` });
  const rows = res.data.values || [];
  if (rows.length <= 1) throw new Error('No expenses to undo');
  const lastRow = rows[rows.length - 1];
  const lastRowIndex = rows.length;
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const sheet = meta.data.sheets.find(s => s.properties.title === SHEET_NAME);
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: { requests: [{ deleteDimension: { range: { sheetId: sheet.properties.sheetId, dimension: 'ROWS', startIndex: lastRowIndex - 1, endIndex: lastRowIndex } } }] }
  });
  return { amount: lastRow[2], category: lastRow[3], merchant: lastRow[4] };
}

// ─── Emoji map ────────────────────────────────────────────────────────────────
function getCategoryEmoji(category) {
  const map = {
    'Food & Dining': '🍽️', 'Food Delivery': '🛵', 'Groceries': '🛒',
    'Transport': '🚗', 'Shopping': '🛍️', 'Entertainment': '🎬',
    'Health & Fitness': '💊', 'Utilities': '💡', 'Rent': '🏠',
    'Travel': '✈️', 'Personal Care': '💆', 'Subscriptions': '📱',
    'Family Transfer': '👨‍👩‍👧', 'Investments': '📈', 'Loan EMI': '🏦', 'Credit Card Payment': '💳', 'Other': '📦'
  };
  return map[category] || '💸';
}

// ─── Cycle pace analysis ──────────────────────────────────────────────────────
// Returns how spending compares to expected pace at this point in the cycle

async function getCyclePaceAnalysis() {
  const rows = await getAllRows();
  const now = new Date();
  const { cycleStart, cycleEnd } = getSalaryCycleBounds(now);

  // Days elapsed and total days in cycle
  const totalCycleDays = Math.round((cycleEnd - cycleStart) / (1000 * 60 * 60 * 24));
  const daysElapsed = Math.round((now - cycleStart) / (1000 * 60 * 60 * 24));
  const daysUntilPayday = Math.round((cycleEnd - now) / (1000 * 60 * 60 * 24)) + 1;
  const cycleProgress = daysElapsed / totalCycleDays; // 0 to 1

  // Current cycle spend (discretionary only — committed is fixed)
  const { byCategory, total } = buildCategoryTotals(rows,
    d => d && d >= cycleStart && d <= now
  );

  let discretionaryTotal = 0;
  const discretionaryByCategory = {};
  for (const [cat, amt] of Object.entries(byCategory)) {
    if (!isCommitted(cat)) {
      discretionaryTotal += amt;
      discretionaryByCategory[cat] = amt;
    }
  }

  // Get previous cycle's discretionary spend as baseline
  // Find previous cycle bounds
  const prevCycleEnd = new Date(cycleStart);
  prevCycleEnd.setDate(prevCycleEnd.getDate() - 1);
  const prevCycleStart = getSalaryCycleBounds(prevCycleEnd).cycleStart;

  const { total: prevTotal, byCategory: prevByCategory } = buildCategoryTotals(rows,
    d => d && d >= prevCycleStart && d <= prevCycleEnd
  );

  let prevDiscretionary = 0;
  for (const [cat, amt] of Object.entries(prevByCategory)) {
    if (!isCommitted(cat)) prevDiscretionary += amt;
  }

  // No previous cycle data = not enough to make a comparison
  if (prevDiscretionary === 0) {
    return { ready: false, reason: 'no_prev_cycle', daysElapsed, cycleProgress: Math.round(cycleProgress * 100) };
  }

  const baselineMonthly = prevDiscretionary;
  const expectedByNow = baselineMonthly * cycleProgress;
  const paceRatio = expectedByNow > 0 ? discretionaryTotal / expectedByNow : 1;

  // Top overspending categories vs previous cycle
  // Only include categories where we have meaningful prev cycle data (>500 Rs)
  const hotCategories = Object.entries(discretionaryByCategory)
    .map(([cat, amt]) => {
      const prev = prevByCategory[cat] || 0;
      if (prev < 500) return null; // skip categories with no meaningful baseline
      const prevExpected = prev * cycleProgress;
      const over = ((amt - prevExpected) / prevExpected) * 100;
      return { cat, amt: Math.round(amt), over: Math.round(over) };
    })
    .filter(x => x !== null && x.over > 30)
    .sort((a, b) => b.over - a.over)
    .slice(0, 3);

  return {
    ready: true,
    daysElapsed,
    daysUntilPayday,
    totalCycleDays,
    cycleProgress: Math.round(cycleProgress * 100),
    discretionaryTotal: Math.round(discretionaryTotal),
    expectedByNow: Math.round(expectedByNow),
    baselineMonthly: Math.round(baselineMonthly),
    paceRatio,
    hotCategories,
    cycleLabel: getCycleLabel()
  };
}

// ─── Last entry info ─────────────────────────────────────────────────────────
// Returns date of last logged entry and how many days ago it was

async function getLastEntryInfo() {
  const rows = await getAllRows();
  if (rows.length === 0) return { hasEntries: false, daysAgo: null, lastDate: null };

  // Find the most recent entry date
  let lastDate = null;
  for (let i = rows.length - 1; i >= 0; i--) {
    const d = parseIndianDate(rows[i][0]);
    if (d) { lastDate = d; break; }
  }

  if (!lastDate) return { hasEntries: false, daysAgo: null, lastDate: null };

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const lastDay = new Date(lastDate.getFullYear(), lastDate.getMonth(), lastDate.getDate());
  const daysAgo = Math.round((today - lastDay) / (1000 * 60 * 60 * 24));

  // Count entries today and yesterday
  const todayCount = rows.filter(r => {
    const d = parseIndianDate(r[0]);
    return d && new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() === today.getTime();
  }).length;

  const yesterdayTs = today.getTime() - 86400000;
  const yesterdayCount = rows.filter(r => {
    const d = parseIndianDate(r[0]);
    return d && new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() === yesterdayTs;
  }).length;

  return { hasEntries: true, daysAgo, lastDate, todayCount, yesterdayCount };
}

module.exports = {
  getCyclePaceAnalysis, getLastEntryInfo,
  initUsersSheet, getUser, createUser, updateUser, incrementExpenseCount, getAllUsers,
  parseSalaryInput, parseStatementInput, getDaysUntilStatement, getBillingCycleAdvice, editLastExpense, deleteRowByIndex, bulkRecategorize, initSheet, appendExpense, batchAppendExpenses, getAllRows,
  getMonthlySummary, getWeeklySummary, getOverspendAlerts,
  getBudgets, suggestBudgets, getBudgetStatus,
  checkAnomaly, undoLast, getCategoryEmoji,
  buildDiscretionarySplit
};

// ─── Edit last expense ────────────────────────────────────────────────────────
async function editLastExpense(field, value) {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${SHEET_NAME}!A:G` });
  const rows = res.data.values || [];
  if (rows.length <= 1) throw new Error('No expenses to edit');

  const lastRowIndex = rows.length; // 1-based
  const fieldMap = { amount: 'C', category: 'D', merchant: 'E', note: 'F' };
  const col = fieldMap[field];
  if (!col) throw new Error('Unknown field: ' + field);

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!${col}${lastRowIndex}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[value]] }
  });

  return { field, value, row: lastRowIndex };
}

// ─── Delete specific row by 1-based data index ────────────────────────────────
async function deleteRowByIndex(dataIndex) {
  const sheets = await getSheetsClient();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const sheet = meta.data.sheets.find(s => s.properties.title === SHEET_NAME);
  const sheetRowIndex = dataIndex; // data index 1 = sheet row 2 (row 1 is header)

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      requests: [{
        deleteDimension: {
          range: {
            sheetId: sheet.properties.sheetId,
            dimension: 'ROWS',
            startIndex: sheetRowIndex, // 0-based: row 2 = index 1
            endIndex: sheetRowIndex + 1
          }
        }
      }]
    }
  });
}

// ─── Bulk recategorise ────────────────────────────────────────────────────────
async function bulkRecategorize(updates) {
  // updates = [{rowIndex (1-based data index), category}]
  const sheets = await getSheetsClient();
  const requests = updates.map(u => ({
    range: `${SHEET_NAME}!D${u.rowIndex + 1}`, // +1 for header row
    values: [[u.category]]
  }));

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      valueInputOption: 'USER_ENTERED',
      data: requests
    }
  });

  return updates.length;
}

// ─── Users tab ────────────────────────────────────────────────────────────────
// Columns: Phone | Name | Salary Type | Salary Day | Cards JSON | Statement Dates JSON | Joined | Expense Count

const USERS_SHEET = 'Users';
const USER_HEADERS = ['Phone', 'Name', 'Salary Type', 'Salary Day', 'Cards', 'Statement Dates', 'Joined', 'Expense Count'];

async function initUsersSheet() {
  const sheets = await getSheetsClient();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const exists = meta.data.sheets.some(s => s.properties.title === USERS_SHEET);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: USERS_SHEET } } }] }
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID, range: `${USERS_SHEET}!A1:H1`,
      valueInputOption: 'RAW', requestBody: { values: [USER_HEADERS] }
    });
    console.log('Users sheet created');
  }
}

async function getUser(phone) {
  const sheets = await getSheetsClient();
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${USERS_SHEET}!A:H` });
    const rows = (res.data.values || []).slice(1);
    const row = rows.find(r => r[0] === phone);
    if (!row) return null;
    return {
      phone: row[0],
      name: row[1] || null,
      salaryType: row[2] || null,   // 'fixed', 'last', 'last_working'
      salaryDay: row[3] ? parseInt(row[3]) : null,
      cards: row[4] ? JSON.parse(row[4]) : [],           // [{name, statementDay}]
      statementDates: row[5] ? JSON.parse(row[5]) : {},  // {HSBC: 5, AMEX: 12}
      joined: row[6] || null,
      expenseCount: row[7] ? parseInt(row[7]) : 0
    };
  } catch { return null; }
}

async function createUser(phone, name) {
  const sheets = await getSheetsClient();
  const now = new Date().toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' });
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID, range: `${USERS_SHEET}!A:H`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[phone, name, '', '', '[]', '{}', now, 0]] }
  });
  return { phone, name, salaryType: null, salaryDay: null, cards: [], statementDates: {}, joined: now, expenseCount: 0 };
}

async function updateUser(phone, updates) {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${USERS_SHEET}!A:H` });
  const rows = res.data.values || [];
  const rowIndex = rows.findIndex((r, i) => i > 0 && r[0] === phone);
  if (rowIndex < 0) return null;

  const existing = rows[rowIndex];
  const merged = [
    existing[0],
    updates.name !== undefined ? updates.name : existing[1],
    updates.salaryType !== undefined ? updates.salaryType : existing[2],
    updates.salaryDay !== undefined ? updates.salaryDay : existing[3],
    updates.cards !== undefined ? JSON.stringify(updates.cards) : existing[4],
    updates.statementDates !== undefined ? JSON.stringify(updates.statementDates) : existing[5],
    existing[6],
    updates.expenseCount !== undefined ? updates.expenseCount : existing[7]
  ];

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${USERS_SHEET}!A${rowIndex + 1}:H${rowIndex + 1}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [merged] }
  });
  return getUser(phone);
}

async function incrementExpenseCount(phone) {
  const user = await getUser(phone);
  if (!user) return;
  await updateUser(phone, { expenseCount: (user.expenseCount || 0) + 1 });
  return (user.expenseCount || 0) + 1;
}

async function getAllUsers() {
  const sheets = await getSheetsClient();
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${USERS_SHEET}!A:H` });
    const rows = (res.data.values || []).slice(1);
    return rows.filter(r => r[0]).map(row => ({
      phone: row[0],
      name: row[1] || null,
      salaryType: row[2] || null,
      salaryDay: row[3] ? parseInt(row[3]) : null,
      cards: row[4] ? JSON.parse(row[4]) : [],
      statementDates: row[5] ? JSON.parse(row[5]) : {},
      joined: row[6] || null,
      expenseCount: row[7] ? parseInt(row[7]) : 0
    }));
  } catch { return []; }
}

// Parse salary input: "26", "last", "last working day", "28th"
function parseSalaryInput(input) {
  const s = input.toLowerCase().trim();
  if (s === 'last' || s === 'end of month' || s === 'eom') {
    return { type: 'last', day: null };
  }
  if (s.includes('last working') || s.includes('last weekday') || s.includes('lwd')) {
    return { type: 'last_working', day: null };
  }
  const num = parseInt(s.replace(/[^0-9]/g, ''));
  if (!isNaN(num) && num >= 1 && num <= 31) {
    return { type: 'fixed', day: num };
  }
  return null;
}

// Parse statement dates input: "HSBC 5, AMEX 12" or just "5" for a single card
function parseStatementInput(input) {
  const results = {};
  // Match patterns like "HSBC 5" or "AMEX: 12" or "Axis-18"
  const matches = input.matchAll(/([a-zA-Z]+[\w\s]*?)\s*[:\-]?\s*(\d{1,2})/g);
  for (const m of matches) {
    const card = m[1].trim().toUpperCase();
    const day = parseInt(m[2]);
    if (day >= 1 && day <= 31) results[card] = day;
  }
  // If just a number, return raw
  if (Object.keys(results).length === 0) {
    const num = parseInt(input.trim());
    if (!isNaN(num) && num >= 1 && num <= 31) return { _single: num };
  }
  return results;
}

// Get days until next statement for a card
function getDaysUntilStatement(statementDay) {
  const now = new Date();
  const today = now.getDate();
  if (today < statementDay) return statementDay - today;
  // Next month
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  return (daysInMonth - today) + statementDay;
}

// Get best card and timing for a big purchase
function getBillingCycleAdvice(statementDates) {
  if (!statementDates || Object.keys(statementDates).length === 0) return null;
  const advice = Object.entries(statementDates).map(([card, day]) => {
    const daysUntil = getDaysUntilStatement(day);
    // Days after statement = interest free days = ~30 (cycle) + ~20 (grace) - days already in cycle
    const interestFreeDays = daysUntil + 20; // approx grace period
    return { card, statementDay: day, daysUntilStatement: daysUntil, interestFreeDays };
  });
  advice.sort((a, b) => b.interestFreeDays - a.interestFreeDays);
  return advice;
}

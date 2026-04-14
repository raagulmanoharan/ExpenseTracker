// ─── Supabase Data Access Layer ──────────────────────────────────────────────
// Drop-in replacement for sheets.js. Same function signatures, same return formats.
// Aggregation logic uses the same JS helpers from utils.js — data just comes from PostgreSQL.

const { createClient } = require('@supabase/supabase-js');
const { isCommitted, parseIndianDate } = require('./constants');
const {
  getSalaryCycleBounds, computeUserCycleBounds, getCycleLabel,
  buildCategoryTotals, buildSummaryText, buildDiscretionarySplit, buildProgressBar,
  getISOWeek,
  parseSalaryInput, parseStatementInput, getDaysUntilStatement, getBillingCycleAdvice,
  isWithinSessionWindow, generateHouseholdId
} = require('./utils');

// ─── Supabase client (singleton) ────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ─── Init (no-ops — schema managed by Supabase migrations) ─────────────────
async function initSheet() {
  // Verify connection
  const { error } = await supabase.from('users').select('phone').limit(1);
  if (error) throw new Error('Supabase connection failed: ' + error.message);
  console.log('✅ Supabase connected');
}

async function initUsersSheet() {
  // No-op — users table created by schema.sql
}

// ─── Row format conversion ──────────────────────────────────────────────────
// Convert Supabase row object to the legacy array format:
// [date, time, amount, category, merchant, note, raw_message, phone]
// This preserves backward compat with buildCategoryTotals, conversation.js, etc.

function rowToArray(row) {
  const d = new Date(row.date + 'T00:00:00'); // parse YYYY-MM-DD
  const dateStr = d.toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' });
  return [
    dateStr,
    row.time || '',
    String(row.amount),
    row.category || 'Other',
    row.merchant || '',
    row.note || '',
    row.raw_message || '',
    row.phone || ''
  ];
}

// ─── Expenses ───────────────────────────────────────────────────────────────
async function appendExpense({ amount, category, merchant, note, raw, phone }) {
  const now = new Date();
  const { error } = await supabase.from('expenses').insert({
    phone,
    date: now.toISOString().split('T')[0],
    time: now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true }),
    amount,
    category: category || 'Other',
    merchant: merchant || null,
    note: note || null,
    raw_message: raw || null
  });
  if (error) throw new Error('appendExpense failed: ' + error.message);
}

async function batchAppendExpenses(transactions, phone) {
  const rows = transactions.map(tx => ({
    phone: phone || null,
    date: tx.date, // already YYYY-MM-DD from PDF parser
    time: 'imported',
    amount: tx.amount,
    category: tx.category || 'Other',
    merchant: tx.merchant || null,
    note: tx.note || null,
    raw_message: '[PDF import]'
  }));
  const { error } = await supabase.from('expenses').insert(rows);
  if (error) throw new Error('batchAppendExpenses failed: ' + error.message);
}

async function getAllRows(phone) {
  let query = supabase.from('expenses')
    .select('*')
    .order('created_at', { ascending: true });
  if (phone) query = query.eq('phone', phone);
  const { data, error } = await query;
  if (error) throw new Error('getAllRows failed: ' + error.message);
  return (data || []).map(rowToArray);
}

// Returns expense objects with IDs — used by conversation.js for edit/delete
async function getRecentExpensesWithIds(phone, limit = 200) {
  let query = supabase.from('expenses')
    .select('id, date, time, amount, category, merchant, note, raw_message, phone')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (phone) query = query.eq('phone', phone);
  const { data, error } = await query;
  if (error) throw new Error('getRecentExpensesWithIds failed: ' + error.message);
  // Reverse to chronological order (oldest first) for context
  return (data || []).reverse();
}

// ─── Budgets ────────────────────────────────────────────────────────────────
async function getBudgets(phone) {
  let query = supabase.from('budgets').select('category, monthly_budget');
  // If phone provided, get per-user budgets; otherwise get all
  if (phone) query = query.eq('phone', phone);
  const { data, error } = await query;
  if (error) return {};
  const budgets = {};
  for (const row of (data || [])) {
    budgets[row.category] = parseFloat(row.monthly_budget);
  }
  return budgets;
}

async function suggestBudgets(phone) {
  const rows = phone ? await getHouseholdRows(phone) : await getAllRows();
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
  if (completedWeeks.length < 2) {
    return { ready: false, weeksLogged: completedWeeks.length };
  }

  const allCats = [...new Set(completedWeeks.flatMap(w => Object.keys(w)))];
  const suggestions = [];

  for (const cat of allCats) {
    const weeklyAmts = completedWeeks.map(w => w[cat] || 0);
    const avgWeekly = weeklyAmts.reduce((a, b) => a + b, 0) / completedWeeks.length;
    if (avgWeekly < 100) continue;
    const monthlyRunRate = avgWeekly * 4.33;
    const suggested = Math.round(monthlyRunRate * 0.9 / 100) * 100;
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

// ─── Summaries ──────────────────────────────────────────────────────────────
async function getMonthlySummary(phone) {
  const rows = phone ? await getHouseholdRows(phone) : await getAllRows();
  const user = phone ? await getUser(phone) : null;
  const userConfig = user && user.salaryType ? { salaryType: user.salaryType, salaryDay: user.salaryDay } : null;
  const { cycleStart, cycleEnd } = getSalaryCycleBounds(new Date(), userConfig);
  const { byCategory, total, count } = buildCategoryTotals(rows,
    d => d && d >= cycleStart && d <= cycleEnd
  );
  const fmt = d => d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
  return {
    total: Math.round(total).toLocaleString('en-IN'),
    breakdown: buildSummaryText(byCategory),
    discretionarySplit: buildDiscretionarySplit(byCategory, total),
    cycleLabel: fmt(cycleStart) + ' – ' + fmt(cycleEnd),
    count,
    byCategory
  };
}

async function getWeeklySummary(phone) {
  const rows = phone ? await getHouseholdRows(phone) : await getAllRows();
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

// ─── Budget status ──────────────────────────────────────────────────────────
async function getBudgetStatus(phone) {
  const [budgets, rows, user] = await Promise.all([
    getBudgets(phone),
    phone ? getHouseholdRows(phone) : getAllRows(),
    phone ? getUser(phone) : null
  ]);
  if (Object.keys(budgets).length === 0) return null;

  const userConfig = user && user.salaryType ? { salaryType: user.salaryType, salaryDay: user.salaryDay } : null;
  const now = new Date();
  const { cycleStart, cycleEnd } = getSalaryCycleBounds(now, userConfig);
  const { byCategory } = buildCategoryTotals(rows,
    d => d && d >= cycleStart && d <= cycleEnd
  );

  const totalCycleDays = Math.round((cycleEnd - cycleStart) / (1000 * 60 * 60 * 24));
  const daysElapsed = Math.round((now - cycleStart) / (1000 * 60 * 60 * 24));
  const monthProgress = totalCycleDays > 0 ? daysElapsed / totalCycleDays : 0;

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

// ─── Anomaly detection ──────────────────────────────────────────────────────
async function checkAnomaly(amount, category, phone) {
  const rows = phone ? await getHouseholdRows(phone) : await getAllRows();
  const now = new Date();

  const past = rows.filter(r => {
    if (!r[0] || !r[2] || r[3] !== category) return false;
    const d = parseIndianDate(r[0]);
    if (!d) return false;
    const daysAgo = (now - d) / (1000 * 60 * 60 * 24);
    return daysAgo > 0 && daysAgo <= 60;
  }).map(r => parseFloat(r[2])).filter(n => !isNaN(n));

  if (past.length < 3) {
    const threshold = isCommitted(category) ? 50000 : 5000;
    return amount > threshold ? { type: 'large', amount, threshold } : null;
  }

  const avg = past.reduce((a, b) => a + b, 0) / past.length;
  const max = Math.max(...past);

  if (amount > avg * 3 && amount > 1000) {
    return { type: 'spike', amount, avg: Math.round(avg), multiple: Math.round(amount / avg) };
  }
  if (amount > max * 1.5 && amount > 2000) {
    return { type: 'high', amount, prev_max: Math.round(max) };
  }
  return null;
}

// ─── Overspend (weekly baseline) ────────────────────────────────────────────
async function getOverspendAlerts(phone) {
  const rows = phone ? await getHouseholdRows(phone) : await getAllRows();
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

// ─── Undo ───────────────────────────────────────────────────────────────────
async function undoLast(phone) {
  // Find last expense for this phone
  let query = supabase.from('expenses')
    .select('id, amount, category, merchant')
    .order('created_at', { ascending: false })
    .limit(1);
  if (phone) query = query.eq('phone', phone);
  const { data, error } = await query;
  if (error || !data || data.length === 0) throw new Error('No expenses to undo');

  const last = data[0];
  const { error: delError } = await supabase.from('expenses').delete().eq('id', last.id);
  if (delError) throw new Error('undoLast delete failed: ' + delError.message);

  return { amount: last.amount, category: last.category, merchant: last.merchant };
}

// ─── Edit last expense ──────────────────────────────────────────────────────
async function editLastExpense(field, value, phone) {
  const fieldMap = { amount: 'amount', category: 'category', merchant: 'merchant', note: 'note' };
  const col = fieldMap[field];
  if (!col) throw new Error('Unknown field: ' + field);

  // Find last expense for this phone (include details for household notifications)
  let query = supabase.from('expenses')
    .select('id, amount, category, merchant')
    .order('created_at', { ascending: false })
    .limit(1);
  if (phone) query = query.eq('phone', phone);
  const { data, error } = await query;
  if (error || !data || data.length === 0) throw new Error('No expenses to edit');

  const before = data[0];
  const { error: updateError } = await supabase.from('expenses')
    .update({ [col]: value })
    .eq('id', before.id);
  if (updateError) throw new Error('editLastExpense failed: ' + updateError.message);

  return { field, value, amount: before.amount, category: before.category, merchant: before.merchant };
}

// ─── Delete by ID (replaces deleteRowByIndex) ───────────────────────────────
async function deleteExpenseById(id) {
  // Fetch details before deleting (for household notifications)
  const { data } = await supabase.from('expenses')
    .select('amount, category, merchant')
    .eq('id', id)
    .limit(1);
  const details = data && data[0] ? data[0] : null;

  const { error } = await supabase.from('expenses').delete().eq('id', id);
  if (error) throw new Error('deleteExpenseById failed: ' + error.message);

  return details;
}

// ─── Bulk recategorize ──────────────────────────────────────────────────────
async function bulkRecategorize(updates) {
  // updates = [{id: UUID, category: string}] (new format)
  // or [{rowIndex: number, category: string}] (legacy format)
  for (const u of updates) {
    if (u.id) {
      const { error } = await supabase.from('expenses')
        .update({ category: u.category })
        .eq('id', u.id);
      if (error) console.error('bulkRecategorize failed for', u.id, error.message);
    } else if (u.rowIndex !== undefined) {
      // Legacy: fetch all rows, find the one at index
      const { data } = await supabase.from('expenses')
        .select('id')
        .order('created_at', { ascending: true });
      if (data && data[u.rowIndex - 1]) {
        await supabase.from('expenses')
          .update({ category: u.category })
          .eq('id', data[u.rowIndex - 1].id);
      }
    }
  }
  return updates.length;
}

// ─── Cycle pace analysis ────────────────────────────────────────────────────
async function getCyclePaceAnalysis(phone) {
  const rows = await getHouseholdRows(phone);
  const now = new Date();
  const user = phone ? await getUser(phone) : null;
  const userConfig = user && user.salaryType ? { salaryType: user.salaryType, salaryDay: user.salaryDay } : null;
  const { cycleStart, cycleEnd } = getSalaryCycleBounds(now, userConfig);

  const totalCycleDays = Math.round((cycleEnd - cycleStart) / (1000 * 60 * 60 * 24));
  const daysElapsed = Math.round((now - cycleStart) / (1000 * 60 * 60 * 24));
  const daysUntilPayday = Math.round((cycleEnd - now) / (1000 * 60 * 60 * 24)) + 1;
  const cycleProgress = daysElapsed / totalCycleDays;

  const { byCategory } = buildCategoryTotals(rows,
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

  const dailyRate = daysElapsed > 0 ? discretionaryTotal / daysElapsed : 0;
  const projectedTotal = Math.round(dailyRate * totalCycleDays);

  const topCategories = Object.entries(discretionaryByCategory)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([cat, amt]) => ({
      cat,
      amt: Math.round(amt),
      daily: daysElapsed > 0 ? Math.round(amt / daysElapsed) : 0
    }));

  const projection = { dailyRate: Math.round(dailyRate), projectedTotal, topCategories };

  const prevCycleEnd = new Date(cycleStart);
  prevCycleEnd.setDate(prevCycleEnd.getDate() - 1);
  const prevCycleStart = getSalaryCycleBounds(prevCycleEnd, userConfig).cycleStart;

  const { byCategory: prevByCategory } = buildCategoryTotals(rows,
    d => d && d >= prevCycleStart && d <= prevCycleEnd
  );

  let prevDiscretionary = 0;
  let prevCatCount = 0;
  for (const [cat, amt] of Object.entries(prevByCategory)) {
    if (!isCommitted(cat)) { prevDiscretionary += amt; prevCatCount++; }
  }

  const comparisonReady = prevDiscretionary >= 2000 && prevCatCount >= 3;

  let comparison = null;
  if (comparisonReady) {
    const baselineMonthly = prevDiscretionary;
    const baselineDaily = Math.round(baselineMonthly / totalCycleDays);
    const expectedByNow = baselineMonthly * cycleProgress;
    const paceRatio = expectedByNow > 0 ? discretionaryTotal / expectedByNow : 1;

    const hotCategories = Object.entries(discretionaryByCategory)
      .map(([cat, amt]) => {
        const prev = prevByCategory[cat] || 0;
        if (prev < 2000) return null;
        const prevDaily = prev / totalCycleDays;
        const currentDaily = daysElapsed > 0 ? amt / daysElapsed : 0;
        const over = prevDaily > 0 ? ((currentDaily - prevDaily) / prevDaily) * 100 : 0;
        return { cat, amt: Math.round(amt), daily: Math.round(currentDaily), prevDaily: Math.round(prevDaily), over: Math.round(over) };
      })
      .filter(x => x !== null && x.over > 30)
      .sort((a, b) => b.over - a.over)
      .slice(0, 3);

    comparison = { baselineMonthly: Math.round(baselineMonthly), baselineDaily, paceRatio, hotCategories };
  }

  return {
    daysElapsed, daysUntilPayday, totalCycleDays,
    cycleProgress: Math.round(cycleProgress * 100),
    discretionaryTotal: Math.round(discretionaryTotal),
    cycleLabel: (() => { const fmt = d => d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }); return fmt(cycleStart) + ' – ' + fmt(cycleEnd); })(),
    projection,
    comparison
  };
}

// ─── Last entry info ────────────────────────────────────────────────────────
async function getLastEntryInfo(phone) {
  const rows = phone ? await getHouseholdRows(phone) : await getAllRows();
  if (rows.length === 0) return { hasEntries: false, daysAgo: null, lastDate: null };

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

// ─── Users ──────────────────────────────────────────────────────────────────
async function getUser(phone) {
  const { data, error } = await supabase.from('users')
    .select('*')
    .eq('phone', phone)
    .maybeSingle();
  if (error || !data) return null;
  return {
    phone: data.phone,
    name: data.name || null,
    salaryType: data.salary_type || null,
    salaryDay: data.salary_day || null,
    cards: data.cards || [],
    statementDates: data.statement_dates || {},
    joined: data.joined || null,
    expenseCount: data.expense_count || 0,
    lastMessageAt: data.last_message_at || null,
    householdId: data.household_id || null,
    sharedCategories: data.shared_categories || null
  };
}

async function createUser(phone, name) {
  const now = new Date();
  const { error } = await supabase.from('users').insert({
    phone,
    name,
    cards: [],
    statement_dates: {},
    joined: now.toISOString(),
    expense_count: 0,
    last_message_at: now.toISOString()
  });
  if (error) throw new Error('createUser failed: ' + error.message);
  return {
    phone, name, salaryType: null, salaryDay: null,
    cards: [], statementDates: {}, joined: now.toISOString(),
    expenseCount: 0, lastMessageAt: now.toISOString(),
    householdId: null, sharedCategories: null
  };
}

async function updateUser(phone, updates) {
  const mapped = {};
  if (updates.name !== undefined) mapped.name = updates.name;
  if (updates.salaryType !== undefined) mapped.salary_type = updates.salaryType;
  if (updates.salaryDay !== undefined) mapped.salary_day = updates.salaryDay;
  if (updates.cards !== undefined) mapped.cards = updates.cards;
  if (updates.statementDates !== undefined) mapped.statement_dates = updates.statementDates;
  if (updates.expenseCount !== undefined) mapped.expense_count = updates.expenseCount;
  if (updates.lastMessageAt !== undefined) mapped.last_message_at = updates.lastMessageAt;
  if (updates.householdId !== undefined) mapped.household_id = updates.householdId || null;
  if (updates.sharedCategories !== undefined) mapped.shared_categories = updates.sharedCategories;

  const { error } = await supabase.from('users').update(mapped).eq('phone', phone);
  if (error) throw new Error('updateUser failed: ' + error.message);
  return getUser(phone);
}

async function incrementExpenseCount(phone) {
  const { data, error } = await supabase.rpc('increment_expense_count', { user_phone: phone });
  if (error) {
    // Fallback: read-then-write
    const user = await getUser(phone);
    if (!user) return 0;
    const newCount = (user.expenseCount || 0) + 1;
    await updateUser(phone, { expenseCount: newCount });
    return newCount;
  }
  return data;
}

async function updateLastMessageAt(phone) {
  const { error } = await supabase.from('users')
    .update({ last_message_at: new Date().toISOString() })
    .eq('phone', phone);
  if (error) console.error('updateLastMessageAt failed:', error.message);
}

async function getAllUsers() {
  const { data, error } = await supabase.from('users').select('*');
  if (error) return [];
  return (data || []).map(row => ({
    phone: row.phone,
    name: row.name || null,
    salaryType: row.salary_type || null,
    salaryDay: row.salary_day || null,
    cards: row.cards || [],
    statementDates: row.statement_dates || {},
    joined: row.joined || null,
    expenseCount: row.expense_count || 0,
    lastMessageAt: row.last_message_at || null,
    householdId: row.household_id || null,
    sharedCategories: row.shared_categories || null
  }));
}

// ─── Household ──────────────────────────────────────────────────────────────
async function getHouseholdPhones(phone) {
  const user = await getUser(phone);
  if (!user || !user.householdId) return [phone];
  const { data } = await supabase.from('users')
    .select('phone')
    .eq('household_id', user.householdId);
  return (data || []).map(r => r.phone);
}

async function getHouseholdMembers(phone) {
  const user = await getUser(phone);
  if (!user || !user.householdId) return [user].filter(Boolean);
  const { data } = await supabase.from('users')
    .select('*')
    .eq('household_id', user.householdId);
  return (data || []).map(row => ({
    phone: row.phone,
    name: row.name || null,
    salaryType: row.salary_type || null,
    salaryDay: row.salary_day || null,
    cards: row.cards || [],
    statementDates: row.statement_dates || {},
    joined: row.joined || null,
    expenseCount: row.expense_count || 0,
    lastMessageAt: row.last_message_at || null,
    householdId: row.household_id || null,
    sharedCategories: row.shared_categories || null
  }));
}

async function getHouseholdRows(phone) {
  const user = await getUser(phone);
  if (!user || !user.householdId) return getAllRows(phone);

  const members = await getHouseholdMembers(phone);
  const sharedCategories = user.sharedCategories || [];
  const otherPhones = members.map(m => m.phone).filter(p => p !== phone);

  // Fetch user's own expenses
  const ownQuery = supabase.from('expenses')
    .select('*')
    .eq('phone', phone)
    .order('created_at', { ascending: true });

  if (otherPhones.length === 0 || sharedCategories.length === 0) {
    // No household members or no shared categories — just own expenses
    const { data, error } = await ownQuery;
    if (error) throw new Error('getHouseholdRows failed: ' + error.message);
    return (data || []).map(rowToArray);
  }

  // Fetch other members' shared-category expenses via SQL filter
  const sharedQuery = supabase.from('expenses')
    .select('*')
    .in('phone', otherPhones)
    .in('category', sharedCategories)
    .order('created_at', { ascending: true });

  const [ownResult, sharedResult] = await Promise.all([ownQuery, sharedQuery]);
  if (ownResult.error) throw new Error('getHouseholdRows own failed: ' + ownResult.error.message);
  if (sharedResult.error) throw new Error('getHouseholdRows shared failed: ' + sharedResult.error.message);

  // Merge and sort by created_at
  const combined = [...(ownResult.data || []), ...(sharedResult.data || [])];
  combined.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  return combined.map(rowToArray);
}

async function createHousehold(phone, sharedCategories) {
  const user = await getUser(phone);
  if (!user) return null;
  if (user.householdId) return { existing: true, householdId: user.householdId };
  const id = generateHouseholdId();
  if (sharedCategories && sharedCategories.length > 0) {
    await updateUser(phone, { householdId: id, sharedCategories });
  }
  return { householdId: id };
}

async function joinHousehold(phone, householdId) {
  const { data: members } = await supabase.from('users')
    .select('name, shared_categories')
    .eq('household_id', householdId);
  if (!members || members.length === 0) return { error: 'not_found' };
  const sharedCategories = members[0].shared_categories || [];
  await updateUser(phone, { householdId, sharedCategories });
  return { members: members.map(u => u.name || 'Unknown'), sharedCategories };
}

async function leaveHousehold(phone) {
  await updateUser(phone, { householdId: '', sharedCategories: [] });
  return { left: true };
}

async function updateSharedCategories(phone, categories) {
  const user = await getUser(phone);
  if (!user || !user.householdId) return null;
  const members = await getHouseholdMembers(phone);
  for (const member of members) {
    await updateUser(member.phone, { sharedCategories: categories });
  }
  return { updated: true, categories };
}

// ─── Export (NEW — replaces "view my sheet") ────────────────────────────────
async function getExpensesForExport(phone) {
  const { data, error } = await supabase.from('expenses')
    .select('date, time, amount, category, merchant, note')
    .eq('phone', phone)
    .order('date', { ascending: true });
  if (error) throw new Error('getExpensesForExport failed: ' + error.message);
  return data || [];
}

// ─── Spending Insights (materialized view queries) ──────────────────────────
// These build compact context for AI conversations instead of sending raw rows.
// Falls back to empty arrays if views don't exist yet (first deploy).

async function getSpendingContext(phone) {
  const [catProfiles, merchantProfiles, dowPatterns, recentTrends, recentExpenses] = await Promise.all([
    getCategoryProfiles(phone),
    getTopMerchants(phone, 10),
    getDowPatterns(phone),
    getCycleTrends(phone, 3),
    getRecentExpensesCompact(phone, 15)
  ]);
  return { catProfiles, merchantProfiles, dowPatterns, recentTrends, recentExpenses };
}

async function getCategoryProfiles(phone) {
  const { data, error } = await supabase.from('mv_category_profiles')
    .select('category, tx_count, avg_amount, total_amount, max_amount, top_merchant, merchant_count, last_seen')
    .eq('phone', phone)
    .order('total_amount', { ascending: false });
  if (error) {
    // View may not exist yet — fall back gracefully
    console.warn('[insights] mv_category_profiles query failed:', error.message);
    return [];
  }
  return data || [];
}

async function getTopMerchants(phone, limit) {
  const { data, error } = await supabase.from('mv_merchant_profiles')
    .select('merchant, category, visit_count, avg_spend, total_spend, last_visit')
    .eq('phone', phone)
    .order('total_spend', { ascending: false })
    .limit(limit || 10);
  if (error) {
    console.warn('[insights] mv_merchant_profiles query failed:', error.message);
    return [];
  }
  return data || [];
}

async function getDowPatterns(phone) {
  const { data, error } = await supabase.from('mv_dow_patterns')
    .select('day_of_week, category, tx_count, avg_amount, total_amount')
    .eq('phone', phone)
    .order('total_amount', { ascending: false });
  if (error) {
    console.warn('[insights] mv_dow_patterns query failed:', error.message);
    return [];
  }
  // Group by day name for readability
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return (data || []).map(r => ({ ...r, dayName: dayNames[r.day_of_week] || '?' }));
}

async function getCycleTrends(phone, months) {
  const { data, error } = await supabase.from('mv_cycle_trends')
    .select('category, month, total, tx_count')
    .eq('phone', phone)
    .order('month', { ascending: false })
    .limit((months || 3) * 20); // rough limit: 20 categories × N months
  if (error) {
    console.warn('[insights] mv_cycle_trends query failed:', error.message);
    return [];
  }
  return data || [];
}

// Compact recent expenses — just the essentials for conversation context
async function getRecentExpensesCompact(phone, limit) {
  const { data, error } = await supabase.from('expenses')
    .select('date, amount, category, merchant, note')
    .eq('phone', phone)
    .order('created_at', { ascending: false })
    .limit(limit || 15);
  if (error) return [];
  return (data || []).reverse(); // chronological
}

// Trigger a refresh of all materialized views (call after bulk imports)
async function refreshSpendingInsights() {
  const { error } = await supabase.rpc('refresh_spending_insights');
  if (error) console.error('[insights] Refresh failed:', error.message);
}

// ─── Exports ────────────────────────────────────────────────────────────────
// Re-export pure functions from utils.js so consumers don't need to change imports
module.exports = {
  // Init
  initSheet, initUsersSheet,
  // Expenses
  appendExpense, batchAppendExpenses, getAllRows,
  getRecentExpensesWithIds,
  // Summaries
  getMonthlySummary, getWeeklySummary, getOverspendAlerts,
  getBudgets, suggestBudgets, getBudgetStatus,
  checkAnomaly, undoLast,
  getCyclePaceAnalysis, getLastEntryInfo,
  // Edit/delete
  editLastExpense, deleteExpenseById, bulkRecategorize,
  // Users
  getUser, createUser, updateUser, incrementExpenseCount,
  updateLastMessageAt, getAllUsers,
  // Household
  generateHouseholdId, getHouseholdPhones, getHouseholdMembers, getHouseholdRows,
  createHousehold, joinHousehold, leaveHousehold, updateSharedCategories,
  // Export
  getExpensesForExport,
  // Spending insights (materialized views)
  getSpendingContext, getCategoryProfiles, getTopMerchants, getDowPatterns,
  getCycleTrends, getRecentExpensesCompact, refreshSpendingInsights,
  // Re-exported from utils.js
  buildDiscretionarySplit,
  getSalaryCycleBounds, computeUserCycleBounds,
  parseSalaryInput, parseStatementInput, getDaysUntilStatement, getBillingCycleAdvice,
  isWithinSessionWindow
};

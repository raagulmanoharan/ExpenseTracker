// ─── Card-rewards analytics ─────────────────────────────────────────────────
//
// Three views over the user's cycle, all backed by the now-clean expenses
// table (cards tagged via the CC-statement reconciler):
//
//   getRewardsReport(phone, cycleStart, cycleEnd)
//     → per-card actual rewards earned (INR), theoretical maximum, and the
//       gap between them. Effective return % per card.
//
//   getMissingRewards(phone, cycleStart, cycleEnd, { limit })
//     → top transactions where the user used the wrong card; what the
//       optimal card would have netted instead. Useful for "next time".
//
//   getMilestoneProgress(phone, opts)
//     → per-card YTD spend vs each milestone tier in the KB.
//
// All three pull from `expenses` where card IS NOT NULL. Untagged rows are
// excluded (we don't know which card was used). Caller can default the cycle
// to the user's salary cycle.

const { loadKB, matchUserCards } = require('./card-strategy');
const { isCommitted } = require('./constants');

// Build a lookup of user-keys → KB cards, scoped to the user.
function ownedKbMap(user) {
  const owned = matchUserCards(user);
  const map = new Map();
  for (const o of owned) map.set(o.userKey, o.card);
  return map;
}

// Best-matching rule for a card at (category, merchant). Mirrors
// card-strategy.js logic but exposed for direct INR scoring on a fixed card.
function bestRuleFor(card, category, merchant) {
  const candidates = [];
  for (const r of card.categoryMultipliers || []) {
    const cats = r.categories || [];
    if (cats.length > 0 && !cats.includes(category)) continue;
    if (!merchantMatches(r.merchantsLike, merchant)) continue;
    candidates.push({
      multiplier: r.multiplier || 1,
      capPerMonth: r.capPerMonth || null,
      capType: r.capType || 'limit',
      valuePerPointInr: r.valuePerPointInr || card.baseEarn?.valuePerPointInr || 0,
      note: r.note || null,
      source: r.source || null
    });
  }
  for (const v of card.voucherTricks || []) {
    if (v.greyArea) continue; // analytics excludes grey-area by default
    if (v.category && v.category !== category) continue;
    if (!merchantMatches(v.merchantsLike, merchant)) continue;
    candidates.push({
      multiplier: v.multiplier || 1,
      capPerMonth: v.capPerMonth || null,
      capType: v.capType || 'limit',
      valuePerPointInr: v.valuePerPointInr || card.baseEarn?.valuePerPointInr || 0,
      note: v.trick || null,
      source: v.source || null
    });
  }
  if (candidates.length === 0) {
    if ((card.exclusions || []).includes(category)) return null;
    return {
      multiplier: 1, capPerMonth: null, capType: 'limit',
      valuePerPointInr: card.baseEarn?.valuePerPointInr || 0,
      note: null, source: null
    };
  }
  // Sort by INR-per-rupee, tie-break by preferring rules that DON'T require a
  // portal (e.g. cashback over Reward-Multiplier-portal routing) — same value
  // but lower friction in practice.
  candidates.sort((a, b) => {
    const va = a.multiplier * a.valuePerPointInr;
    const vb = b.multiplier * b.valuePerPointInr;
    if (vb !== va) return vb - va;
    const aPortal = /portal|reward multiplier|smartbuy|gyftr/i.test(a.note || '');
    const bPortal = /portal|reward multiplier|smartbuy|gyftr/i.test(b.note || '');
    if (aPortal !== bPortal) return aPortal ? 1 : -1;
    return 0;
  });
  return candidates[0];
}

function merchantMatches(merchantsLike, merchant) {
  if (!merchantsLike || merchantsLike.length === 0) return true;
  if (!merchant) return false;
  const m = String(merchant).toLowerCase();
  return merchantsLike.some(needle => m.includes(String(needle).toLowerCase()));
}

// INR value for amount on card under rule, given mtd-so-far on this card.
function inrValueWithCap(amount, card, rule, mtd) {
  if (!rule) return 0;
  const ppm = card.baseEarn?.pointsPer100 || 0;
  const baseVpp = card.baseEarn?.valuePerPointInr || 0;
  const ruleVpp = rule.valuePerPointInr || baseVpp;
  const cap = rule.capPerMonth;
  if (!cap) return (amount / 100) * ppm * (rule.multiplier || 1) * ruleVpp;
  if (rule.capType === 'threshold') {
    const before = Math.max(0, Math.min(amount, cap - mtd));
    const accelerated = amount - before;
    return (before / 100) * ppm * baseVpp + (accelerated / 100) * ppm * (rule.multiplier || 1) * ruleVpp;
  }
  // limit
  const headroom = Math.max(0, cap - mtd);
  const accelerated = Math.min(amount, headroom);
  const overflow = amount - accelerated;
  return (accelerated / 100) * ppm * (rule.multiplier || 1) * ruleVpp + (overflow / 100) * ppm * baseVpp;
}

/**
 * Group expenses by card. Walk in date order; track MTD per card. For each
 * expense, compute (a) actual reward on its tagged card, (b) best reward
 * across all owned cards using cap-aware math at that point in time.
 */
function walkCycle(expenses, user) {
  const kb = loadKB();
  const owned = matchUserCards(user); // [{userKey, card}]
  const userKeyToKb = new Map(owned.map(o => [o.userKey, o.card]));
  const sorted = [...expenses].sort((a, b) => {
    const dateDiff = new Date(a.date || 0).getTime() - new Date(b.date || 0).getTime();
    if (dateDiff !== 0) return dateDiff;
    return new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime();
  });

  const mtdByCard = {}; // userKey -> running INR
  for (const o of owned) mtdByCard[o.userKey] = 0;

  const walked = [];
  for (const e of sorted) {
    const actualKbCard = userKeyToKb.get(e.card);
    const actualRule = actualKbCard ? bestRuleFor(actualKbCard, e.category, e.merchant) : null;
    const actualValue = actualKbCard ? inrValueWithCap(Number(e.amount), actualKbCard, actualRule, mtdByCard[e.card] || 0) : 0;

    // Theoretical best across owned cards (cap-aware, using current MTD).
    // Tie-breaker: prefer non-portal-routed rules (cashback over RM portal etc.)
    let bestValue = 0, bestUserKey = null, bestRuleNote = null, bestPortal = false;
    for (const o of owned) {
      const rule = bestRuleFor(o.card, e.category, e.merchant);
      if (!rule) continue;
      const v = inrValueWithCap(Number(e.amount), o.card, rule, mtdByCard[o.userKey] || 0);
      const portal = /portal|reward multiplier|smartbuy|gyftr/i.test(rule.note || '');
      const replace = v > bestValue || (v === bestValue && bestPortal && !portal);
      if (replace) {
        bestValue = v;
        bestUserKey = o.userKey;
        bestRuleNote = rule.note;
        bestPortal = portal;
      }
    }

    walked.push({
      id: e.id,
      date: e.date,
      amount: Number(e.amount),
      category: e.category,
      merchant: e.merchant,
      actualCard: e.card,
      actualValue,
      actualRuleNote: actualRule?.note || null,
      bestCard: bestUserKey,
      bestValue,
      bestRuleNote,
      gap: Math.max(0, bestValue - actualValue)
    });

    // Update MTD for the card actually used (this reflects reality).
    if (e.card && mtdByCard[e.card] !== undefined) mtdByCard[e.card] += Number(e.amount);
  }
  return walked;
}

/**
 * @param {string} phone
 * @param {object} opts - {
 *   cycleStart: 'YYYY-MM-DD',
 *   cycleEnd:   'YYYY-MM-DD',
 *   db:         { listExpensesInRange, getUser },
 *   user?:      pre-loaded user (saves a fetch),
 * }
 */
async function getRewardsReport(phone, opts) {
  const user = opts.user || await opts.db.getUser(phone);
  const expenses = await opts.db.listExpensesInRange(phone, opts.cycleStart, opts.cycleEnd);
  const tagged = expenses.filter(e => e.card);
  const walked = walkCycle(tagged, user);

  const byCard = {};
  for (const w of walked) {
    const key = w.actualCard;
    if (!byCard[key]) byCard[key] = { card: key, txnCount: 0, totalSpend: 0, actualValue: 0, theoreticalValue: 0 };
    byCard[key].txnCount++;
    byCard[key].totalSpend += w.amount;
    byCard[key].actualValue += w.actualValue;
    byCard[key].theoreticalValue += w.bestValue;
  }

  const cards = Object.values(byCard).map(c => ({
    ...c,
    actualValue: round2(c.actualValue),
    theoreticalValue: round2(c.theoreticalValue),
    gap: round2(c.theoreticalValue - c.actualValue),
    effectiveRatePct: c.totalSpend > 0 ? round2((c.actualValue / c.totalSpend) * 100) : 0,
    optimalRatePct: c.totalSpend > 0 ? round2((c.theoreticalValue / c.totalSpend) * 100) : 0
  })).sort((a, b) => b.totalSpend - a.totalSpend);

  const totals = cards.reduce((acc, c) => {
    acc.totalSpend += c.totalSpend;
    acc.actualValue += c.actualValue;
    acc.theoreticalValue += c.theoreticalValue;
    return acc;
  }, { totalSpend: 0, actualValue: 0, theoreticalValue: 0 });
  totals.gap = round2(totals.theoreticalValue - totals.actualValue);
  totals.actualValue = round2(totals.actualValue);
  totals.theoreticalValue = round2(totals.theoreticalValue);

  return { cards, totals, taggedTxnCount: tagged.length, untaggedTxnCount: expenses.length - tagged.length };
}

async function getMissingRewards(phone, opts) {
  const user = opts.user || await opts.db.getUser(phone);
  const expenses = await opts.db.listExpensesInRange(phone, opts.cycleStart, opts.cycleEnd);
  const tagged = expenses.filter(e => e.card);
  const walked = walkCycle(tagged, user);
  const limit = opts.limit || 5;
  const minGapInr = opts.minGapInr || 25;

  const misses = walked
    .filter(w => w.bestCard && w.bestCard !== w.actualCard && w.gap >= minGapInr)
    .sort((a, b) => b.gap - a.gap)
    .slice(0, limit);

  const totalGap = walked.filter(w => w.bestCard && w.bestCard !== w.actualCard).reduce((s, w) => s + w.gap, 0);

  return {
    top: misses.map(w => ({
      date: w.date,
      amount: w.amount,
      merchant: w.merchant,
      category: w.category,
      usedCard: w.actualCard,
      shouldHaveUsed: w.bestCard,
      missedInr: round2(w.gap),
      bestRuleNote: w.bestRuleNote
    })),
    totalMissedInr: round2(totalGap),
    consideredTxnCount: walked.length
  };
}

/**
 * Per-card YTD progress against milestone thresholds in the KB. YTD = last
 * 365 days by default; milestones are typically annual.
 */
async function getMilestoneProgress(phone, opts) {
  const user = opts.user || await opts.db.getUser(phone);
  const owned = matchUserCards(user);
  if (owned.length === 0) return { cards: [] };

  // 365-day window ending today, unless caller overrode.
  const end = opts.cycleEnd || todayStr();
  const start = opts.cycleStart || shiftDate(end, -365);

  const expenses = await opts.db.listExpensesInRange(phone, start, end);
  const tagged = expenses.filter(e => e.card);

  const byCard = {};
  for (const e of tagged) {
    byCard[e.card] = (byCard[e.card] || 0) + Number(e.amount);
  }

  const out = [];
  for (const o of owned) {
    const ms = (o.card.milestones || []).filter(m => m.spendThreshold);
    if (ms.length === 0) continue;
    const ytd = byCard[o.userKey] || 0;
    const tiers = ms.map(m => ({
      threshold: m.spendThreshold,
      reward: m.reward,
      hit: ytd >= m.spendThreshold,
      progressPct: round2(Math.min(100, (ytd / m.spendThreshold) * 100)),
      remainingInr: Math.max(0, m.spendThreshold - ytd)
    })).sort((a, b) => a.threshold - b.threshold);
    out.push({
      card: o.card.displayName,
      cardUserKey: o.userKey,
      ytdSpend: round2(ytd),
      tiers
    });
  }
  return { cards: out, windowStart: start, windowEnd: end };
}

function round2(n) { return Math.round(Number(n) * 100) / 100; }
function todayStr() { return new Date().toISOString().split('T')[0]; }
function shiftDate(yyyyMmDd, deltaDays) {
  const d = new Date(yyyyMmDd);
  d.setDate(d.getDate() + deltaDays);
  return d.toISOString().split('T')[0];
}

/**
 * Personalized "playbook" — for the user's top spending categories from the
 * last 90 days, recommend the optimal card + actionable flow per category
 * (which portal to route through, voucher to load, etc.). Estimated
 * monthly upside per category + total.
 *
 * Returns: {
 *   periodStart, periodEnd,
 *   entries: [{
 *     category, monthlyAvgSpend, txnCount, sampleMerchants,
 *     bestCard, bestCardUserKey, bestMultiplier, bestRuleNote,
 *     hasVoucherTrick, voucherTrick, sourceUrl,
 *     estimatedMonthlyUpsideInr
 *   }],
 *   totalMonthlyUpsideInr,
 *   skipped: [{ category, reason }]
 * }
 */
async function getPersonalizedPlaybook(phone, opts = {}) {
  const user = opts.user || await opts.db.getUser(phone);
  const owned = matchUserCards(user);
  if (owned.length === 0) {
    return { entries: [], totalMonthlyUpsideInr: 0, skipped: [], periodStart: null, periodEnd: null };
  }

  const lookbackDays = opts.lookbackDays || 90;
  const periodEnd = todayStr();
  const periodStart = shiftDate(periodEnd, -lookbackDays);
  const months = lookbackDays / 30;

  const expenses = await opts.db.listExpensesInRange(phone, periodStart, periodEnd);

  // Aggregate by category — exclude Other, Credit Card Payment (pass-through),
  // and the structurally-excluded categories (rent etc.) since the engine
  // won't recommend anything actionable there anyway.
  const skipCats = new Set(['Other', 'Credit Card Payment', 'Family Transfer']);
  const byCategory = {};
  for (const e of expenses) {
    if (!e.category || skipCats.has(e.category)) continue;
    if (!byCategory[e.category]) byCategory[e.category] = { total: 0, count: 0, merchants: new Set() };
    byCategory[e.category].total += Number(e.amount);
    byCategory[e.category].count++;
    if (e.merchant) byCategory[e.category].merchants.add(e.merchant);
  }

  // Top categories by spend.
  const ranked = Object.entries(byCategory)
    .map(([cat, s]) => ({
      category: cat,
      total: s.total,
      monthlyAvg: s.total / months,
      txnCount: s.count,
      sampleMerchants: [...s.merchants].slice(0, 3)
    }))
    .filter(x => x.total >= 500) // de-noise
    .sort((a, b) => b.total - a.total)
    .slice(0, opts.maxCategories || 7);

  // For each top category, find the optimal card via the engine. Use a
  // representative merchant from the sample for merchant-keyword matching.
  const { suggestForExpense } = require('./card-strategy');
  const entries = [];
  const skipped = [];
  for (const r of ranked) {
    // Use monthlyAvg as the "next purchase" amount so the upside scales right.
    const tip = await suggestForExpense(
      { amount: r.monthlyAvg, category: r.category, merchant: r.sampleMerchants[0] || null },
      user,
      { mtdLookup: opts.mtdLookup, mtdByCard: opts.mtdByCard }
    );
    if (!tip) {
      skipped.push({ category: r.category, reason: 'no special rule beats base earn' });
      continue;
    }
    // Detect whether the rule note describes a voucher/portal flow.
    const note = tip.bestRuleNote || '';
    const hasVoucherTrick = /portal|voucher|load|smartbuy|reward multiplier|gyftr|live\+|tastecard|travel edge/i.test(note);
    entries.push({
      category: r.category,
      monthlyAvgSpend: round2(r.monthlyAvg),
      txnCount: r.txnCount,
      sampleMerchants: r.sampleMerchants,
      bestCard: tip.bestCard,
      bestCardUserKey: tip.bestCardUserKey,
      bestMultiplier: tip.bestMultiplier,
      bestRuleNote: note,
      hasVoucherTrick,
      voucherTrick: hasVoucherTrick ? note : null,
      sourceUrl: tip.source || null,
      estimatedMonthlyUpsideInr: round2(tip.upsideInr)
    });
  }

  const totalMonthlyUpsideInr = round2(entries.reduce((s, e) => s + e.estimatedMonthlyUpsideInr, 0));
  return { periodStart, periodEnd, entries, totalMonthlyUpsideInr, skipped };
}

/**
 * Day-of-week spending profile over the last 90 days. Aggregates across all
 * categories per DOW, computes relative factor vs the global daily average,
 * and surfaces top spending day + lightest day for behavioral insight.
 */
async function getDayOfWeekProfile(phone, opts = {}) {
  const lookbackDays = opts.lookbackDays || 90;
  const periodEnd = todayStr();
  const periodStart = shiftDate(periodEnd, -lookbackDays);
  const expenses = await opts.db.listExpensesInRange(phone, periodStart, periodEnd);
  // Exclude committed categories (Rent, Utilities, EMI, Investments, Family
  // Transfer, Subscriptions, Credit Card Payment) — those land on fixed
  // calendar days and bias the DOW signal away from real behavior.
  const discretionary = expenses.filter(e => e && e.category && !isCommitted(e.category));
  if (discretionary.length === 0) {
    return { period: { start: periodStart, end: periodEnd }, days: [], topDay: null, lightestDay: null, sampleSize: 0 };
  }

  // Aggregate by date so each day is one observation, then group by DOW.
  const byDate = new Map();
  for (const e of discretionary) {
    if (!e.date) continue;
    if (!byDate.has(e.date)) byDate.set(e.date, 0);
    byDate.set(e.date, byDate.get(e.date) + Number(e.amount || 0));
  }

  const sumByDow = [0, 0, 0, 0, 0, 0, 0];
  const countByDow = [0, 0, 0, 0, 0, 0, 0];
  for (const [date, amt] of byDate.entries()) {
    const dow = new Date(date).getDay();
    sumByDow[dow] += amt;
    countByDow[dow]++;
  }

  const totalSum = sumByDow.reduce((a, b) => a + b, 0);
  const totalCount = countByDow.reduce((a, b) => a + b, 0);
  const globalAvg = totalCount > 0 ? totalSum / totalCount : 0;

  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const days = dayNames.map((name, i) => {
    const avg = countByDow[i] > 0 ? sumByDow[i] / countByDow[i] : 0;
    return {
      dow: i,
      name,
      avgPerDay: round2(avg),
      observationDays: countByDow[i],
      total: round2(sumByDow[i]),
      factor: globalAvg > 0 ? round2(avg / globalAvg) : 1
    };
  });

  const sortedDesc = [...days].sort((a, b) => b.avgPerDay - a.avgPerDay);
  const sortedAsc = [...days].filter(d => d.observationDays > 0).sort((a, b) => a.avgPerDay - b.avgPerDay);

  return {
    period: { start: periodStart, end: periodEnd },
    days,
    topDay: sortedDesc[0] || null,
    lightestDay: sortedAsc[0] || null,
    globalAvgPerDay: round2(globalAvg),
    sampleSize: byDate.size
  };
}

module.exports = { getRewardsReport, getMissingRewards, getMilestoneProgress, getPersonalizedPlaybook, getDayOfWeekProfile, walkCycle };

// ─── Credit-card rewards optimizer ──────────────────────────────────────────
//
// Given an expense (amount, category, merchant) and the user's known cards,
// returns the best card + path to maximize points/value, or null when there's
// no actionable opportunity.
//
// Knowledge base lives in card-strategies.json. Each card has:
//   - aliases: fuzzy-match against user.statementDates keys
//   - baseEarn: { pointsPer100, currency, valuePerPointInr }
//   - categoryMultipliers: [{ categories, multiplier, merchantsLike?, capPerMonth?, capType?, note, source }]
//   - voucherTricks: [{ trick, category, multiplier?, valuePerPointInr?, valueEstimate, greyArea, source }]
//   - milestones, transferPartners, exclusions: informational only (not used in scoring yet)
//
// Cap semantics:
//   capType="limit" (default)  — multiplier applies up to capPerMonth/cycle, then base earn.
//                                 e.g. Atlas 5x on first Rs.2L of Travel/month, base 2 above.
//   capType="threshold"        — multiplier ONLY applies after MTD exceeds capPerMonth.
//                                 e.g. Magnus 17.5x kicks in only on incremental spend ABOVE Rs.1.5L/month.
//
// MTD per card comes from the optional `mtdByCard` map passed by the caller
// (server.js queries db.getMonthlySpendByCard). When unknown (zero), capped
// rules degrade gracefully: limit-rules still fire as if you had headroom;
// threshold-rules hold off (no false 17.5x on a Rs.2k dinner).

const fs = require('fs');
const path = require('path');

const KB_PATH = path.join(__dirname, 'card-strategies.json');
const MIN_UPSIDE_INR = 50; // skip suggestion if the upside is trivial

let _kb = null;
function loadKB() {
  if (_kb) return _kb;
  try {
    const raw = fs.readFileSync(KB_PATH, 'utf8');
    _kb = JSON.parse(raw);
  } catch (err) {
    console.error('[card-strategy] failed to load KB:', err.message);
    _kb = { cards: {} };
  }
  return _kb;
}

function _resetKB() { _kb = null; }
function _setKB(kb) { _kb = kb; }

function normalizeKey(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// Match user.statementDates keys against card aliases. Returns { id, card, userKey } per owned card.
function matchUserCards(user) {
  const kb = loadKB();
  const userKeys = Object.keys((user && user.statementDates) || {});
  if (userKeys.length === 0) return [];
  const normalizedUser = userKeys.map(k => ({ raw: k, norm: normalizeKey(k) }));
  const owned = [];
  for (const [id, card] of Object.entries(kb.cards || {})) {
    const aliases = (card.aliases || []).map(normalizeKey);
    const hit = normalizedUser.find(u => aliases.some(a => a && (u.norm === a || u.norm.includes(a) || a.includes(u.norm))));
    if (hit) owned.push({ id, card, userKey: hit.raw });
  }
  return owned;
}

// Best-effort match of free-text message against owned-card aliases.
// Returns the matched user-key (e.g. "AMEX") or null.
function extractCardHint(message, user) {
  if (!message || !user) return null;
  const owned = matchUserCards(user);
  if (owned.length === 0) return null;
  const normMsg = normalizeKey(message);
  // Score by longest alias match — "AMEX PLATINUM" beats "AMEX".
  let bestHit = null;
  for (const { userKey, card } of owned) {
    for (const alias of card.aliases || []) {
      const a = normalizeKey(alias);
      if (a && normMsg.includes(a)) {
        if (!bestHit || a.length > bestHit.aliasLen) {
          bestHit = { userKey, aliasLen: a.length };
        }
      }
    }
  }
  return bestHit ? bestHit.userKey : null;
}

function merchantMatches(merchantsLike, merchant) {
  if (!merchantsLike || merchantsLike.length === 0) return true;
  if (!merchant) return false;
  const m = String(merchant).toLowerCase();
  return merchantsLike.some(needle => m.includes(String(needle).toLowerCase()));
}

// Build the candidate-rule list for a card+category+merchant. Includes plain
// base-earn fallback as the last resort so callers can still score it.
function ruleCandidates(card, category, merchant, { allowGreyArea }) {
  const out = [];
  for (const r of card.categoryMultipliers || []) {
    const cats = r.categories || [];
    if (cats.length > 0 && !cats.includes(category)) continue;
    if (!merchantMatches(r.merchantsLike, merchant)) continue;
    out.push({
      multiplier: r.multiplier || 1,
      note: r.note || null,
      source: r.source || null,
      greyArea: false,
      isVoucherTrick: false,
      capPerMonth: r.capPerMonth || null,
      capType: r.capType || 'limit',
      valuePerPointInr: r.valuePerPointInr || card.baseEarn?.valuePerPointInr || 0
    });
  }
  for (const v of card.voucherTricks || []) {
    if (v.greyArea && !allowGreyArea) continue;
    if (v.category && v.category !== category) continue;
    if (!merchantMatches(v.merchantsLike, merchant)) continue;
    out.push({
      multiplier: v.multiplier || 1,
      note: v.trick || null,
      source: v.source || null,
      greyArea: !!v.greyArea,
      isVoucherTrick: true,
      capPerMonth: v.capPerMonth || null,
      capType: v.capType || 'limit',
      valuePerPointInr: v.valuePerPointInr || card.baseEarn?.valuePerPointInr || 0
    });
  }
  return out;
}

// Effective points value (INR) of `amount` under `rule` for `card`, given
// month-to-date spend `mtd` already on this card. Honors capType.
function inrValueWithCap(amount, card, rule, mtd) {
  const ppm = card.baseEarn?.pointsPer100 || 0;
  const baseVpp = card.baseEarn?.valuePerPointInr || 0;
  const ruleVpp = rule.valuePerPointInr || baseVpp;
  const cap = rule.capPerMonth;
  // No cap → straightforward
  if (!cap) {
    return (amount / 100) * ppm * (rule.multiplier || 1) * ruleVpp;
  }
  if (rule.capType === 'threshold') {
    // Multiplier only applies on spend above the threshold. This purchase
    // covers the spend range [mtd, mtd+amount]; portion below `cap` earns
    // base, portion above earns the multiplier.
    const before = Math.max(0, Math.min(amount, cap - mtd));
    const accelerated = amount - before;
    const baseValue = (before / 100) * ppm * baseVpp;
    const acceleratedValue = (accelerated / 100) * ppm * (rule.multiplier || 1) * ruleVpp;
    return baseValue + acceleratedValue;
  }
  // Default capType "limit": multiplier applies up to cap, then base.
  const headroom = Math.max(0, cap - mtd);
  const accelerated = Math.min(amount, headroom);
  const overflow = amount - accelerated;
  const acceleratedValue = (accelerated / 100) * ppm * (rule.multiplier || 1) * ruleVpp;
  const baseValue = (overflow / 100) * ppm * baseVpp;
  return acceleratedValue + baseValue;
}

function baseInrValue(amount, card, category) {
  if ((card.exclusions || []).includes(category)) return 0;
  const ppm = card.baseEarn?.pointsPer100 || 0;
  const v = card.baseEarn?.valuePerPointInr || 0;
  return (amount / 100) * ppm * v;
}

// Pick the highest-value rule for this card under cap-aware scoring.
// Returns { rule, value } or null when category is excluded with no other rule.
function bestRuleForCardCapAware(card, category, merchant, mtd, opts) {
  const candidates = ruleCandidates(card, category, merchant, opts);
  if (candidates.length === 0) {
    if ((card.exclusions || []).includes(category)) return null;
    const baseRule = {
      multiplier: 1, note: null, source: null, greyArea: false, isVoucherTrick: false,
      capPerMonth: null, capType: 'limit',
      valuePerPointInr: card.baseEarn?.valuePerPointInr || 0
    };
    return { rule: baseRule, value: inrValueWithCap(opts.amount, card, baseRule, mtd) };
  }
  let best = null;
  for (const rule of candidates) {
    const value = inrValueWithCap(opts.amount, card, rule, mtd);
    if (!best || value > best.value) best = { rule, value };
  }
  return best;
}

/**
 * Main entry point. Async because we look up MTD-per-card via the optional
 * `mtdLookup(card_userKey) => Promise<number>` injected by the caller. Tests
 * can pass `mtdByCard` directly to avoid mocking.
 *
 * @param {object} expense - { amount, category, merchant }
 * @param {object} user    - profile from db.getUser
 * @param {object} [opts]  - {
 *     allowGreyArea?: boolean,
 *     minUpsideInr?: number,
 *     mtdLookup?: (userCardKey) => Promise<number>,
 *     mtdByCard?: { [userCardKey]: number }
 *   }
 */
async function suggestForExpense(expense, user, opts = {}) {
  if (!expense || !expense.amount || !expense.category) return null;
  const allowGreyArea = !!opts.allowGreyArea;
  const minUpside = typeof opts.minUpsideInr === 'number' ? opts.minUpsideInr : MIN_UPSIDE_INR;
  const amount = Number(expense.amount);

  const owned = matchUserCards(user);
  if (owned.length === 0) return null;

  // Resolve MTD for each owned card (concurrently when async lookup is provided).
  const mtdMap = {};
  await Promise.all(owned.map(async ({ userKey }) => {
    if (opts.mtdByCard && Object.prototype.hasOwnProperty.call(opts.mtdByCard, userKey)) {
      mtdMap[userKey] = Number(opts.mtdByCard[userKey] || 0);
      return;
    }
    if (typeof opts.mtdLookup === 'function') {
      try { mtdMap[userKey] = Number(await opts.mtdLookup(userKey)) || 0; }
      catch (e) { mtdMap[userKey] = 0; }
      return;
    }
    mtdMap[userKey] = 0;
  }));

  let best = null;
  let baselineValue = 0;
  for (const { card, userKey } of owned) {
    const mtd = mtdMap[userKey] || 0;
    const baseVal = baseInrValue(amount, card, expense.category);
    if (baseVal > baselineValue) baselineValue = baseVal;

    const picked = bestRuleForCardCapAware(card, expense.category, expense.merchant, mtd, {
      allowGreyArea, amount
    });
    if (!picked) continue;
    if (!best || picked.value > best.value) best = { card, ...picked, mtd, userKey };
  }

  if (!best) return null;
  // Category-only: skip when the winner is plain base earn with no special note.
  if (best.rule.multiplier === 1 && !best.rule.note) return null;

  const upside = best.value - baselineValue;
  if (upside < minUpside) return null;

  return {
    bestCard: best.card.displayName,
    bestCardUserKey: best.userKey,
    bestMultiplier: best.rule.multiplier,
    bestRuleNote: best.rule.note,
    bestValueInr: Math.round(best.value),
    baselineValueInr: Math.round(baselineValue),
    upsideInr: Math.round(upside),
    greyArea: !!best.rule.greyArea,
    source: best.rule.source || null,
    isVoucherTrick: !!best.rule.isVoucherTrick,
    capPerMonth: best.rule.capPerMonth || null,
    capType: best.rule.capType || null,
    mtdSoFar: Math.round(best.mtd)
  };
}

module.exports = {
  suggestForExpense,
  matchUserCards,
  extractCardHint,
  loadKB,
  _resetKB,
  _setKB,
  MIN_UPSIDE_INR
};

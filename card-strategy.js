// ─── Credit-card rewards optimizer ──────────────────────────────────────────
//
// Given an expense (amount, category, merchant) and the user's known cards,
// returns the best card + path to maximize points/value, or null when there's
// no actionable opportunity.
//
// Knowledge base lives in card-strategies.json. Each card has:
//   - aliases: fuzzy-match against user.statementDates keys
//   - baseEarn: { pointsPer100, currency, valuePerPointInr }
//   - categoryMultipliers: [{ categories, multiplier, merchantsLike?, capPerMonth?, note, source }]
//   - voucherTricks: [{ trick, category, multiplier?, valuePerPointInr?, valueEstimate, greyArea, source }]
//   - milestones, transferPartners, exclusions: informational only (not used in scoring yet)
//
// Scoring: for each user-held card, find the best matching rule for the
// (category, merchant) pair. Compute INR value of points earned. Pick the
// winner and the worst owned card; if winner − worst ≥ MIN_UPSIDE_INR, fire.

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

// For tests / hot reloads.
function _resetKB() { _kb = null; }
function _setKB(kb) { _kb = kb; }

function normalizeKey(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// Match user.statementDates keys against card aliases. Returns { id, card } pairs
// for every card the user holds.
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

function merchantMatches(merchantsLike, merchant) {
  if (!merchantsLike || merchantsLike.length === 0) return true; // category-only rule
  if (!merchant) return false;
  const m = String(merchant).toLowerCase();
  return merchantsLike.some(needle => m.includes(String(needle).toLowerCase()));
}

// Returns { multiplier, note, source, greyArea, isVoucherTrick, valuePerPointInr } or null.
function bestRuleForCard(card, category, merchant) {
  const candidates = [];
  for (const r of card.categoryMultipliers || []) {
    const cats = r.categories || [];
    if (cats.length > 0 && !cats.includes(category)) continue;
    if (!merchantMatches(r.merchantsLike, merchant)) continue;
    candidates.push({
      multiplier: r.multiplier || 1,
      note: r.note || null,
      source: r.source || null,
      greyArea: false,
      isVoucherTrick: false,
      valuePerPointInr: r.valuePerPointInr || card.baseEarn?.valuePerPointInr || 0
    });
  }
  for (const v of card.voucherTricks || []) {
    if (v.category && v.category !== category) continue;
    if (!merchantMatches(v.merchantsLike, merchant)) continue;
    candidates.push({
      multiplier: v.multiplier || 1,
      note: v.trick || null,
      source: v.source || null,
      greyArea: !!v.greyArea,
      isVoucherTrick: true,
      valueEstimate: v.valueEstimate || null,
      valuePerPointInr: v.valuePerPointInr || card.baseEarn?.valuePerPointInr || 0
    });
  }
  if (candidates.length === 0) {
    // Fall back to base earn — only if category isn't excluded.
    const excluded = (card.exclusions || []).includes(category);
    if (excluded) return null;
    return {
      multiplier: 1,
      note: null,
      source: null,
      greyArea: false,
      isVoucherTrick: false,
      valuePerPointInr: card.baseEarn?.valuePerPointInr || 0
    };
  }
  // Pick the highest INR-value rule (multiplier × valuePerPoint).
  candidates.sort((a, b) => (b.multiplier * b.valuePerPointInr) - (a.multiplier * a.valuePerPointInr));
  return candidates[0];
}

// INR value of points earned on `amount` under `rule` for `card`.
function inrValue(amount, card, rule) {
  if (!rule) return 0;
  const pointsPer100 = card.baseEarn?.pointsPer100 || 0;
  const points = (amount / 100) * pointsPer100 * (rule.multiplier || 1);
  return points * (rule.valuePerPointInr || 0);
}

// Plain base earn (no special rule), respecting exclusions.
function baseInrValue(amount, card, category) {
  if ((card.exclusions || []).includes(category)) return 0;
  const pointsPer100 = card.baseEarn?.pointsPer100 || 0;
  const v = card.baseEarn?.valuePerPointInr || 0;
  return (amount / 100) * pointsPer100 * v;
}

/**
 * Main entry point. Returns null when no actionable suggestion exists.
 *
 * @param {object} expense - { amount, category, merchant }
 * @param {object} user    - profile from db.getUser
 * @param {object} [opts]  - { allowGreyArea?: boolean, minUpsideInr?: number }
 * @returns {null | {
 *   bestCard: string, bestMultiplier: number, bestRuleNote: string|null,
 *   bestValueInr: number, baselineValueInr: number, upsideInr: number,
 *   greyArea: boolean, source: string|null, isVoucherTrick: boolean
 * }}
 */
function suggestForExpense(expense, user, opts = {}) {
  if (!expense || !expense.amount || !expense.category) return null;
  const allowGreyArea = !!opts.allowGreyArea;
  const minUpside = typeof opts.minUpsideInr === 'number' ? opts.minUpsideInr : MIN_UPSIDE_INR;

  const owned = matchUserCards(user);
  if (owned.length === 0) return null;

  let best = null;
  let baselineValue = 0; // best plain base-earn across owned cards (the do-nothing path)
  for (const { card } of owned) {
    const baseVal = baseInrValue(expense.amount, card, expense.category);
    if (baseVal > baselineValue) baselineValue = baseVal;

    let rule = bestRuleForCard(card, expense.category, expense.merchant);
    if (rule && rule.greyArea && !allowGreyArea) {
      rule = bestSafeRuleForCard(card, expense.category, expense.merchant);
    }
    if (!rule) continue;
    const val = inrValue(expense.amount, card, rule);
    if (!best || val > best.value) best = { card, rule, value: val };
  }

  if (!best) return null;

  // Category-only opportunities: skip when no special rule beats vanilla base earn.
  if (best.rule.multiplier === 1 && !best.rule.note) return null;

  const upside = best.value - baselineValue;
  if (upside < minUpside) return null;

  return {
    bestCard: best.card.displayName,
    bestMultiplier: best.rule.multiplier,
    bestRuleNote: best.rule.note,
    bestValueInr: Math.round(best.value),
    baselineValueInr: Math.round(baselineValue),
    upsideInr: Math.round(upside),
    greyArea: !!best.rule.greyArea,
    source: best.rule.source || null,
    isVoucherTrick: !!best.rule.isVoucherTrick
  };
}

function bestSafeRuleForCard(card, category, merchant) {
  // Same as bestRuleForCard but excludes voucher tricks flagged greyArea.
  const candidates = [];
  for (const r of card.categoryMultipliers || []) {
    const cats = r.categories || [];
    if (cats.length > 0 && !cats.includes(category)) continue;
    if (!merchantMatches(r.merchantsLike, merchant)) continue;
    candidates.push({
      multiplier: r.multiplier || 1, note: r.note || null, source: r.source || null,
      greyArea: false, isVoucherTrick: false,
      valuePerPointInr: r.valuePerPointInr || card.baseEarn?.valuePerPointInr || 0
    });
  }
  for (const v of card.voucherTricks || []) {
    if (v.greyArea) continue;
    if (v.category && v.category !== category) continue;
    if (!merchantMatches(v.merchantsLike, merchant)) continue;
    candidates.push({
      multiplier: v.multiplier || 1, note: v.trick || null, source: v.source || null,
      greyArea: false, isVoucherTrick: true,
      valuePerPointInr: v.valuePerPointInr || card.baseEarn?.valuePerPointInr || 0
    });
  }
  if (candidates.length === 0) {
    const excluded = (card.exclusions || []).includes(category);
    if (excluded) return null;
    return {
      multiplier: 1, note: null, source: null, greyArea: false, isVoucherTrick: false,
      valuePerPointInr: card.baseEarn?.valuePerPointInr || 0
    };
  }
  candidates.sort((a, b) => (b.multiplier * b.valuePerPointInr) - (a.multiplier * a.valuePerPointInr));
  return candidates[0];
}

module.exports = {
  suggestForExpense,
  matchUserCards,
  loadKB,
  _resetKB,
  _setKB,
  MIN_UPSIDE_INR
};

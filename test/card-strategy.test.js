// Tests for the card-strategy engine. Uses an in-memory KB fixture so we don't
// depend on the live card-strategies.json content.

const { suggestForExpense, matchUserCards, _setKB, _resetKB } = require('../card-strategy');

const FIXTURE = {
  cards: {
    amex_platinum_charge: {
      displayName: 'Amex Plat',
      aliases: ['AMEX PLAT', 'AMEX PLATINUM', 'AMEX'],
      baseEarn: { pointsPer100: 1, currency: 'MR', valuePerPointInr: 0.5 },
      categoryMultipliers: [
        { categories: ['Travel'], multiplier: 5, note: '5x via FHR portal', source: 'https://example.com/fhr' }
      ],
      voucherTricks: [
        { trick: 'Load Amazon Pay via Smartbuy alt route', category: 'Shopping', multiplier: 3, valuePerPointInr: 0.5, greyArea: false, source: 'https://r/.../amazon' },
        { trick: 'NoBroker rent loop', category: 'Rent', multiplier: 5, valuePerPointInr: 0.5, greyArea: true, source: 'https://r/.../rent' }
      ],
      exclusions: ['Utilities', 'Fuel']
    },
    hsbc_premier: {
      displayName: 'HSBC Premier',
      aliases: ['HSBC', 'HSBC PREMIER'],
      baseEarn: { pointsPer100: 2, currency: 'HSBC', valuePerPointInr: 0.25 },
      categoryMultipliers: [
        { categories: ['Food & Dining'], multiplier: 10, note: '10x via TasteCard', source: 'https://example.com/taste' }
      ],
      exclusions: []
    },
    axis_magnus: {
      displayName: 'Axis Magnus',
      aliases: ['AXIS MAGNUS', 'MAGNUS'],
      baseEarn: { pointsPer100: 12, currency: 'EDGE', valuePerPointInr: 0.2 },
      categoryMultipliers: [],
      exclusions: ['Rent', 'Insurance']
    }
  }
};

beforeEach(() => {
  _resetKB();
  _setKB(FIXTURE);
});

describe('matchUserCards', () => {
  test('returns empty when user has no cards', () => {
    expect(matchUserCards({})).toEqual([]);
    expect(matchUserCards({ statementDates: {} })).toEqual([]);
  });

  test('matches via alias on uppercased keys', () => {
    const user = { statementDates: { 'AMEX': 18, 'HSBC': 5 } };
    const matched = matchUserCards(user);
    const ids = matched.map(m => m.id).sort();
    expect(ids).toEqual(['amex_platinum_charge', 'hsbc_premier']);
  });

  test('handles partial / messy keys', () => {
    const user = { statementDates: { 'HSBC PREMIER MC': 5 } };
    const matched = matchUserCards(user);
    expect(matched.find(m => m.id === 'hsbc_premier')).toBeTruthy();
  });
});

describe('suggestForExpense — basic routing', () => {
  test('returns null when expense has no amount', () => {
    expect(suggestForExpense({ category: 'Travel' }, { statementDates: { 'AMEX': 18 } })).toBeNull();
  });

  test('returns null when user owns no cards in KB', () => {
    expect(suggestForExpense({ amount: 5000, category: 'Travel' }, { statementDates: { 'RANDOM_CARD': 5 } })).toBeNull();
  });

  test('routes Food & Dining to HSBC TasteCard 10x', () => {
    const user = { statementDates: { 'AMEX': 18, 'HSBC': 5, 'AXIS MAGNUS': 25 } };
    const tip = suggestForExpense({ amount: 2000, category: 'Food & Dining', merchant: 'Toit' }, user);
    expect(tip).not.toBeNull();
    expect(tip.bestCard).toBe('HSBC Premier');
    expect(tip.bestMultiplier).toBe(10);
    expect(tip.upsideInr).toBeGreaterThan(0);
  });

  test('routes Travel to Amex 5x via FHR', () => {
    const user = { statementDates: { 'AMEX': 18, 'HSBC': 5 } };
    const tip = suggestForExpense({ amount: 10000, category: 'Travel', merchant: 'Marriott' }, user);
    expect(tip.bestCard).toBe('Amex Plat');
    expect(tip.bestMultiplier).toBe(5);
    expect(tip.bestRuleNote).toMatch(/FHR/);
  });

  test('routes Shopping/Amazon to voucher trick (3x)', () => {
    const user = { statementDates: { 'AMEX': 18, 'HSBC': 5 } };
    const tip = suggestForExpense({ amount: 5000, category: 'Shopping', merchant: 'Amazon' }, user);
    expect(tip.bestCard).toBe('Amex Plat');
    expect(tip.bestMultiplier).toBe(3);
    expect(tip.isVoucherTrick).toBe(true);
  });
});

describe('suggestForExpense — noise control', () => {
  test('returns null when no special rule matches (avoids "use any card" noise)', () => {
    const user = { statementDates: { 'AMEX': 18 } };
    // Personal Care has no rule for Amex in fixture → base earn only → null
    const tip = suggestForExpense({ amount: 500, category: 'Personal Care' }, user);
    expect(tip).toBeNull();
  });

  test('returns null when upside is below threshold', () => {
    const user = { statementDates: { 'AMEX': 18, 'HSBC': 5 } };
    // Tiny dining expense — 10x of small amount won't clear MIN_UPSIDE_INR
    const tip = suggestForExpense({ amount: 100, category: 'Food & Dining' }, user);
    expect(tip).toBeNull();
  });

  test('respects custom minUpsideInr threshold', () => {
    const user = { statementDates: { 'HSBC': 5, 'AMEX': 18 } };
    const tip = suggestForExpense({ amount: 500, category: 'Food & Dining' }, user, { minUpsideInr: 5 });
    expect(tip).not.toBeNull();
  });
});

describe('suggestForExpense — grey-area gating', () => {
  test('skips grey-area trick by default', () => {
    const user = { statementDates: { 'AMEX': 18 } };
    const tip = suggestForExpense({ amount: 30000, category: 'Rent' }, user);
    expect(tip).toBeNull();
  });

  test('surfaces grey-area trick when explicitly allowed', () => {
    const user = { statementDates: { 'AMEX': 18 } };
    const tip = suggestForExpense({ amount: 30000, category: 'Rent' }, user, { allowGreyArea: true });
    expect(tip).not.toBeNull();
    expect(tip.greyArea).toBe(true);
    expect(tip.bestRuleNote).toMatch(/NoBroker/);
    // Baseline for Amex on Rent = 0 (Amex doesn't exclude Rent in fixture, so base earn applies).
    // Best = NoBroker 5x. Upside = best − baseline > 0.
    expect(tip.upsideInr).toBeGreaterThan(0);
  });
});

describe('suggestForExpense — exclusions', () => {
  test('excluded categories yield null when no other card has a rule', () => {
    const user = { statementDates: { 'AXIS MAGNUS': 25 } };
    const tip = suggestForExpense({ amount: 5000, category: 'Rent' }, user);
    expect(tip).toBeNull();
  });
});

describe('suggestForExpense — real KB smoke test', () => {
  beforeEach(() => { _resetKB(); }); // fall through to live KB load

  test('loads card-strategies.json without throwing', () => {
    const { loadKB } = require('../card-strategy');
    const kb = loadKB();
    expect(kb).toBeTruthy();
    expect(kb.cards).toBeTruthy();
    expect(Object.keys(kb.cards).length).toBeGreaterThanOrEqual(5);
  });

  test('Amex + HSBC + Magnus user buying e-voucher gets a tip', () => {
    const user = { statementDates: { 'AMEX': 18, 'HSBC PREMIER': 5, 'AXIS MAGNUS': 25 } };
    const tip = suggestForExpense({ amount: 10000, category: 'Shopping', merchant: 'Amazon e-voucher' }, user);
    expect(tip).not.toBeNull();
    expect(tip.bestMultiplier).toBeGreaterThan(1);
  });

  test('Travel via Amex FHR routes to Amex 5x', () => {
    const user = { statementDates: { 'AMEX PLAT': 18, 'HSBC PREMIER': 5 } };
    const tip = suggestForExpense({ amount: 50000, category: 'Travel', merchant: 'FHR Marriott Goa' }, user);
    expect(tip).not.toBeNull();
    expect(tip.bestCard).toMatch(/Amex/);
  });

  test('Rent excluded for all three cards → null', () => {
    const user = { statementDates: { 'HSBC': 5, 'AXIS MAGNUS': 25, 'AXIS RESERVE': 8 } };
    const tip = suggestForExpense({ amount: 30000, category: 'Rent' }, user);
    expect(tip).toBeNull();
  });
});

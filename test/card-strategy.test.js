// Tests for the card-strategy engine. Uses an in-memory KB fixture so we don't
// depend on the live card-strategies.json content.

const { suggestForExpense, matchUserCards, extractCardHint, _setKB, _resetKB } = require('../card-strategy');

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
      baseEarn: { pointsPer100: 6, currency: 'EDGE', valuePerPointInr: 0.2 },
      categoryMultipliers: [
        {
          categories: ['Food & Dining', 'Travel', 'Shopping'],
          multiplier: 17.5,
          capPerMonth: 150000,
          capType: 'threshold',
          note: '17.5x kicks in only on incremental spends ABOVE Rs.1.5L/month',
          source: 'https://example.com/magnus'
        }
      ],
      exclusions: ['Rent', 'Utilities']
    },
    axis_atlas: {
      displayName: 'Axis Atlas',
      aliases: ['ATLAS', 'AXIS ATLAS'],
      baseEarn: { pointsPer100: 2, currency: 'EDGE Miles', valuePerPointInr: 0.5 },
      categoryMultipliers: [
        {
          categories: ['Travel'],
          multiplier: 5,
          capPerMonth: 200000,
          capType: 'limit',
          note: '5x on travel up to Rs.2L/month',
          source: 'https://example.com/atlas'
        }
      ],
      exclusions: ['Rent']
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

describe('extractCardHint', () => {
  const user = { statementDates: { 'AMEX': 18, 'HSBC PREMIER': 5, 'AXIS MAGNUS': 25 } };

  test('finds card name in free-text message', () => {
    expect(extractCardHint('2000 amex toit dinner', user)).toBe('AMEX');
    expect(extractCardHint('paid 30k via axis magnus', user)).toBe('AXIS MAGNUS');
    expect(extractCardHint('hsbc premier 1000 zomato', user)).toBe('HSBC PREMIER');
  });

  test('returns null when no card mentioned', () => {
    expect(extractCardHint('just had lunch 500', user)).toBeNull();
  });

  test('returns null when user has no cards', () => {
    expect(extractCardHint('amex 1000', { statementDates: {} })).toBeNull();
  });
});

describe('suggestForExpense — basic routing', () => {
  test('returns null when expense has no amount', async () => {
    const tip = await suggestForExpense({ category: 'Travel' }, { statementDates: { 'AMEX': 18 } });
    expect(tip).toBeNull();
  });

  test('returns null when user owns no cards in KB', async () => {
    const tip = await suggestForExpense({ amount: 5000, category: 'Travel' }, { statementDates: { 'RANDOM_CARD': 5 } });
    expect(tip).toBeNull();
  });

  test('routes Food & Dining to HSBC TasteCard 10x', async () => {
    const user = { statementDates: { 'AMEX': 18, 'HSBC': 5 } };
    const tip = await suggestForExpense({ amount: 2000, category: 'Food & Dining', merchant: 'Toit' }, user);
    expect(tip).not.toBeNull();
    expect(tip.bestCard).toBe('HSBC Premier');
    expect(tip.bestMultiplier).toBe(10);
  });

  test('routes Travel to Amex 5x via FHR', async () => {
    const user = { statementDates: { 'AMEX': 18, 'HSBC': 5 } };
    const tip = await suggestForExpense({ amount: 10000, category: 'Travel', merchant: 'Marriott' }, user);
    expect(tip.bestCard).toBe('Amex Plat');
    expect(tip.bestMultiplier).toBe(5);
  });
});

describe('suggestForExpense — cap-aware scoring', () => {
  test('threshold-cap (Magnus): small spend with zero MTD does NOT route to Magnus', async () => {
    const user = { statementDates: { 'AXIS MAGNUS': 25, 'HSBC': 5 } };
    const tip = await suggestForExpense(
      { amount: 2000, category: 'Food & Dining', merchant: 'Toit' },
      user,
      { mtdByCard: { 'AXIS MAGNUS': 0, 'HSBC': 0 } }
    );
    // Should route to HSBC 10x dining since Magnus 17.5x doesn't kick in below 1.5L MTD.
    expect(tip).not.toBeNull();
    expect(tip.bestCard).toBe('HSBC Premier');
  });

  test('threshold-cap (Magnus): MTD above 1.5L unlocks 17.5x', async () => {
    const user = { statementDates: { 'AXIS MAGNUS': 25, 'HSBC': 5 } };
    const tip = await suggestForExpense(
      { amount: 5000, category: 'Food & Dining', merchant: 'Toit' },
      user,
      { mtdByCard: { 'AXIS MAGNUS': 200000, 'HSBC': 0 } }
    );
    expect(tip.bestCard).toBe('Axis Magnus');
    expect(tip.bestMultiplier).toBe(17.5);
  });

  test('threshold-cap (Magnus): partial — spend straddles threshold', async () => {
    const user = { statementDates: { 'AXIS MAGNUS': 25 } };
    // MTD 100k, spend 100k → 50k at base, 50k at 17.5x.
    const tipPartial = await suggestForExpense(
      { amount: 100000, category: 'Food & Dining' },
      user,
      { mtdByCard: { 'AXIS MAGNUS': 100000 } }
    );
    // Compare to a "fully accelerated" world where MTD already at 1.5L
    const tipFull = await suggestForExpense(
      { amount: 100000, category: 'Food & Dining' },
      user,
      { mtdByCard: { 'AXIS MAGNUS': 150000 } }
    );
    expect(tipFull.bestValueInr).toBeGreaterThan(tipPartial.bestValueInr);
  });

  test('limit-cap (Atlas): full multiplier when within cap', async () => {
    const user = { statementDates: { 'ATLAS': 8 } };
    const tip = await suggestForExpense(
      { amount: 50000, category: 'Travel', merchant: 'airlines' },
      user,
      { mtdByCard: { 'ATLAS': 0 } }
    );
    expect(tip.bestCard).toBe('Axis Atlas');
    expect(tip.bestMultiplier).toBe(5);
  });

  test('limit-cap (Atlas): once cap is exhausted, multiplier collapses to base', async () => {
    const user = { statementDates: { 'ATLAS': 8, 'AMEX': 18 } };
    // Atlas already maxed for the month → 5x doesn't apply on this travel spend.
    const tipMaxed = await suggestForExpense(
      { amount: 50000, category: 'Travel', merchant: 'airlines' },
      user,
      { mtdByCard: { 'ATLAS': 200000, 'AMEX': 0 } }
    );
    const tipFresh = await suggestForExpense(
      { amount: 50000, category: 'Travel', merchant: 'airlines' },
      user,
      { mtdByCard: { 'ATLAS': 0, 'AMEX': 0 } }
    );
    expect(tipFresh.bestValueInr).toBeGreaterThan(tipMaxed.bestValueInr);
  });

  test('mtdLookup async function is supported', async () => {
    const user = { statementDates: { 'AXIS MAGNUS': 25, 'HSBC': 5 } };
    const lookup = jest.fn(async (key) => key === 'AXIS MAGNUS' ? 200000 : 0);
    const tip = await suggestForExpense(
      { amount: 5000, category: 'Food & Dining' },
      user,
      { mtdLookup: lookup }
    );
    expect(lookup).toHaveBeenCalled();
    expect(tip.bestCard).toBe('Axis Magnus');
  });
});

describe('suggestForExpense — noise control', () => {
  test('returns null when no special rule matches', async () => {
    const user = { statementDates: { 'AMEX': 18 } };
    const tip = await suggestForExpense({ amount: 500, category: 'Personal Care' }, user);
    expect(tip).toBeNull();
  });

  test('returns null when upside is below threshold', async () => {
    const user = { statementDates: { 'AMEX': 18, 'HSBC': 5 } };
    const tip = await suggestForExpense({ amount: 100, category: 'Food & Dining' }, user);
    expect(tip).toBeNull();
  });
});

describe('suggestForExpense — grey-area gating', () => {
  test('skips grey-area trick by default', async () => {
    const user = { statementDates: { 'AMEX': 18 } };
    const tip = await suggestForExpense({ amount: 30000, category: 'Rent' }, user);
    expect(tip).toBeNull();
  });

  test('surfaces grey-area trick when explicitly allowed', async () => {
    const user = { statementDates: { 'AMEX': 18 } };
    const tip = await suggestForExpense({ amount: 30000, category: 'Rent' }, user, { allowGreyArea: true });
    expect(tip).not.toBeNull();
    expect(tip.greyArea).toBe(true);
    expect(tip.bestRuleNote).toMatch(/NoBroker/);
  });
});

describe('suggestForExpense — exclusions', () => {
  test('excluded categories yield null when no other card has a rule', async () => {
    const user = { statementDates: { 'AXIS MAGNUS': 25 } };
    const tip = await suggestForExpense({ amount: 5000, category: 'Rent' }, user);
    expect(tip).toBeNull();
  });
});

describe('suggestForExpense — real KB smoke test', () => {
  beforeEach(() => { _resetKB(); });

  test('loads card-strategies.json without throwing', () => {
    const { loadKB } = require('../card-strategy');
    const kb = loadKB();
    expect(kb).toBeTruthy();
    expect(kb.cards).toBeTruthy();
    expect(Object.keys(kb.cards).length).toBeGreaterThanOrEqual(5);
  });

  test('Magnus 17.5x does NOT fire on small dining spend with zero MTD', async () => {
    const user = { statementDates: { 'AMEX': 18, 'HSBC PREMIER': 5, 'AXIS MAGNUS': 25 } };
    const tip = await suggestForExpense(
      { amount: 2000, category: 'Food & Dining', merchant: 'Toit' },
      user,
      { mtdByCard: { 'AMEX': 0, 'HSBC PREMIER': 0, 'AXIS MAGNUS': 0 } }
    );
    if (tip) expect(tip.bestCard).not.toBe('Axis Magnus');
  });

  test('Travel via FHR routes to Amex on real KB', async () => {
    const user = { statementDates: { 'AMEX PLAT': 18, 'HSBC PREMIER': 5 } };
    const tip = await suggestForExpense(
      { amount: 50000, category: 'Travel', merchant: 'FHR Marriott Goa' },
      user,
      { mtdByCard: { 'AMEX PLAT': 0, 'HSBC PREMIER': 0 } }
    );
    expect(tip).not.toBeNull();
    expect(tip.bestCard).toMatch(/Amex/);
  });

  test('Rent excluded for all three cards → null', async () => {
    const user = { statementDates: { 'HSBC': 5, 'AXIS MAGNUS': 25, 'AXIS RESERVE': 8 } };
    const tip = await suggestForExpense({ amount: 30000, category: 'Rent' }, user);
    expect(tip).toBeNull();
  });
});

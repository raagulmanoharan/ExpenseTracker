// Tests for analytics — uses mocked db helpers + the real card-strategies.json
// KB. No Anthropic / Supabase calls.

const { getRewardsReport, getMissingRewards, getMilestoneProgress, walkCycle } = require('../analytics');

// User with the same 4 cards the real user has.
const USER = { statementDates: { 'AXIS ATLAS': 8, 'HDFC SWIGGY': 5, 'ICICI AMAZON': 18, 'AMEX PLAT TRAVEL': 11 } };

function expensesFixture() {
  return [
    // Atlas was used for an obvious Atlas-fit (Travel)
    { id: '1', date: '2026-04-01', amount: 50000, category: 'Travel', merchant: 'IndiGo flight', card: 'AXIS ATLAS' },
    // Swiggy was used for Swiggy — correct
    { id: '2', date: '2026-04-02', amount: 600, category: 'Food Delivery', merchant: 'Swiggy', card: 'HDFC SWIGGY' },
    // Amazon was bought on Atlas — should have used ICICI Amazon
    { id: '3', date: '2026-04-05', amount: 8000, category: 'Shopping', merchant: 'Amazon', card: 'AXIS ATLAS' },
    // Untagged row — analytics ignores
    { id: '4', date: '2026-04-06', amount: 1000, category: 'Food & Dining', merchant: 'Toit', card: null },
    // ICICI Amazon used for Amazon — correct
    { id: '5', date: '2026-04-08', amount: 3000, category: 'Shopping', merchant: 'Amazon.in', card: 'ICICI AMAZON' }
  ];
}

const mockDb = (rows) => ({
  listExpensesInRange: async () => rows.map(r => ({ ...r })),
  getUser: async () => USER
});

describe('walkCycle', () => {
  test('computes actualValue and bestValue per row', () => {
    const w = walkCycle(expensesFixture().filter(e => e.card), USER);
    expect(w).toHaveLength(4);
    const flight = w.find(x => x.id === '1');
    expect(flight.actualCard).toBe('AXIS ATLAS');
    expect(flight.bestCard).toBe('AXIS ATLAS');
    expect(flight.actualValue).toBeGreaterThan(0);
    expect(flight.gap).toBe(0);

    const amazonOnAtlas = w.find(x => x.id === '3');
    expect(amazonOnAtlas.actualCard).toBe('AXIS ATLAS');
    expect(amazonOnAtlas.bestCard).toBe('ICICI AMAZON');
    expect(amazonOnAtlas.gap).toBeGreaterThan(0);
  });
});

describe('getRewardsReport', () => {
  test('aggregates per-card spend + actual + theoretical', async () => {
    const r = await getRewardsReport('whatsapp:+91X', {
      cycleStart: '2026-04-01', cycleEnd: '2026-04-30',
      db: mockDb(expensesFixture()), user: USER
    });
    expect(r.taggedTxnCount).toBe(4);
    expect(r.untaggedTxnCount).toBe(1);
    expect(r.cards).toHaveLength(3);
    const atlas = r.cards.find(c => c.card === 'AXIS ATLAS');
    expect(atlas.totalSpend).toBeGreaterThan(0);
    expect(atlas.actualValue).toBeGreaterThan(0);
    expect(r.totals.totalSpend).toBeGreaterThan(0);
    // Theoretical >= actual always
    expect(r.totals.theoreticalValue).toBeGreaterThanOrEqual(r.totals.actualValue);
  });

  test('handles user with no tagged expenses gracefully', async () => {
    const r = await getRewardsReport('whatsapp:+91X', {
      cycleStart: '2026-04-01', cycleEnd: '2026-04-30',
      db: mockDb([]), user: USER
    });
    expect(r.taggedTxnCount).toBe(0);
    expect(r.cards).toEqual([]);
  });
});

describe('getMissingRewards', () => {
  test('flags Amazon-on-Atlas as a miss', async () => {
    const r = await getMissingRewards('whatsapp:+91X', {
      cycleStart: '2026-04-01', cycleEnd: '2026-04-30',
      db: mockDb(expensesFixture()), user: USER
    });
    expect(r.top.length).toBeGreaterThanOrEqual(1);
    const amazonMiss = r.top.find(t => t.merchant === 'Amazon');
    expect(amazonMiss).toBeTruthy();
    expect(amazonMiss.usedCard).toBe('AXIS ATLAS');
    expect(amazonMiss.shouldHaveUsed).toBe('ICICI AMAZON');
    expect(amazonMiss.missedInr).toBeGreaterThan(0);
  });

  test('returns empty when all transactions used optimal card', async () => {
    const r = await getMissingRewards('whatsapp:+91X', {
      cycleStart: '2026-04-01', cycleEnd: '2026-04-30',
      db: mockDb(expensesFixture().filter(e => e.id !== '3')), // remove the misallocated Amazon
      user: USER
    });
    expect(r.top.find(t => t.merchant === 'Amazon')).toBeUndefined();
  });

  test('respects limit option', async () => {
    const many = Array.from({ length: 20 }).map((_, i) => ({
      id: 'x' + i, date: '2026-04-' + String((i % 28) + 1).padStart(2, '0'),
      amount: 5000 + i * 100, category: 'Shopping', merchant: 'Amazon', card: 'AXIS ATLAS'
    }));
    const r = await getMissingRewards('whatsapp:+91X', {
      cycleStart: '2026-04-01', cycleEnd: '2026-04-30',
      db: mockDb(many), user: USER, limit: 3
    });
    expect(r.top).toHaveLength(3);
  });
});

describe('getMilestoneProgress', () => {
  test('reports YTD progress for milestone-having cards (Plat Travel + Atlas)', async () => {
    const r = await getMilestoneProgress('whatsapp:+91X', {
      db: mockDb(expensesFixture()), user: USER
    });
    expect(r.cards.length).toBeGreaterThan(0);
    // Plat Travel is in fixture KB with 1.9L/4L/7L tiers — should appear if owned
    const platTravel = r.cards.find(c => c.cardUserKey === 'AMEX PLAT TRAVEL');
    if (platTravel) {
      expect(platTravel.tiers.length).toBeGreaterThan(0);
      expect(platTravel.tiers[0].progressPct).toBeGreaterThanOrEqual(0);
    }
  });

  test('cards without milestones are omitted', async () => {
    const userJustSwiggy = { statementDates: { 'HDFC SWIGGY': 5 } };
    const r = await getMilestoneProgress('whatsapp:+91X', {
      db: mockDb([]), user: userJustSwiggy
    });
    expect(r.cards).toEqual([]);
  });
});

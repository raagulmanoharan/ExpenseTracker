// Pure-function tests for forecasting helpers + getDayOfWeekProfile.

const { computeEwma, computeDowFactors, projectRemainingCycle } = require('../utils');
const { getDayOfWeekProfile } = require('../analytics');

describe('computeEwma', () => {
  test('empty input returns 0', () => {
    expect(computeEwma([], 7)).toBe(0);
    expect(computeEwma(null, 7)).toBe(0);
  });

  test('single value returns the value', () => {
    expect(computeEwma([100], 7)).toBe(100);
  });

  test('weights recent values more (rising trend)', () => {
    // First half all zero, second half all 100 → EWMA should be > simple avg (50)
    const values = Array(10).fill(0).concat(Array(10).fill(100));
    const ewma = computeEwma(values, 7);
    expect(ewma).toBeGreaterThan(50);
  });

  test('weights recent values more (declining trend)', () => {
    // First half all 100, second half all 0 → EWMA should be < simple avg (50)
    const values = Array(10).fill(100).concat(Array(10).fill(0));
    const ewma = computeEwma(values, 7);
    expect(ewma).toBeLessThan(50);
  });

  test('constant series returns the constant', () => {
    expect(computeEwma([42, 42, 42, 42, 42, 42, 42], 7)).toBeCloseTo(42, 2);
  });

  test('shorter half-life weights latest values even more heavily', () => {
    const values = [0, 0, 0, 0, 0, 0, 0, 100];
    const ewmaShort = computeEwma(values, 1);
    const ewmaLong = computeEwma(values, 30);
    expect(ewmaShort).toBeGreaterThan(ewmaLong);
  });
});

describe('computeDowFactors', () => {
  test('empty history returns neutral factors', () => {
    const r = computeDowFactors([]);
    expect(r.factors).toEqual([1, 1, 1, 1, 1, 1, 1]);
  });

  test('uniform spending returns all 1.0 factors', () => {
    const history = [];
    // 4 weeks, 100 per day
    for (let i = 0; i < 28; i++) {
      const d = new Date('2026-01-01');
      d.setDate(d.getDate() + i);
      history.push({ date: d, amount: 100 });
    }
    const r = computeDowFactors(history);
    for (const f of r.factors) expect(f).toBeCloseTo(1, 1);
  });

  test('saturday-heavy spending shows >1 factor on Saturday', () => {
    const history = [];
    for (let i = 0; i < 28; i++) {
      const d = new Date('2026-01-01'); // Jan 1 2026 is a Thursday
      d.setDate(d.getDate() + i);
      const amount = d.getDay() === 6 ? 500 : 50; // Saturdays heavy
      history.push({ date: d, amount });
    }
    const r = computeDowFactors(history);
    expect(r.factors[6]).toBeGreaterThan(2); // Saturday
    expect(r.factors[1]).toBeLessThan(1);    // Monday
  });

  test('skips invalid dates gracefully', () => {
    const r = computeDowFactors([
      { date: 'not-a-date', amount: 100 },
      { date: '2026-01-01', amount: 200 }
    ]);
    expect(r.factors).toEqual([1, 1, 1, 1, 1, 1, 1]); // not enough data → neutral
  });
});

describe('projectRemainingCycle', () => {
  test('returns 0 when from > to', () => {
    expect(projectRemainingCycle(new Date('2026-04-30'), new Date('2026-04-01'), 100, [1, 1, 1, 1, 1, 1, 1])).toBe(0);
  });

  test('with neutral factors, returns days * dailyRate', () => {
    const v = projectRemainingCycle(new Date('2026-04-01'), new Date('2026-04-10'), 100, [1, 1, 1, 1, 1, 1, 1]);
    expect(v).toBeCloseTo(10 * 100, 0); // 10 days × 100
  });

  test('amplifies projection with factor > 1 days', () => {
    const factors = [1, 1, 1, 1, 1, 1, 2]; // Saturday at 2x
    const v = projectRemainingCycle(new Date('2026-04-01'), new Date('2026-04-14'), 100, factors);
    // 14 days, 2 are Saturdays → 12*1 + 2*2 = 16 day-equivalents × 100 = 1600
    expect(v).toBeCloseTo(1600, 0);
  });
});

describe('getDayOfWeekProfile (analytics)', () => {
  function mockDb(rows) {
    return { listExpensesInRange: async () => rows };
  }

  test('empty history returns sampleSize 0', async () => {
    const r = await getDayOfWeekProfile('whatsapp:+91X', { db: mockDb([]) });
    expect(r.sampleSize).toBe(0);
    expect(r.days).toEqual([]);
  });

  test('aggregates by date, then groups by DOW', async () => {
    const rows = [
      { date: '2026-04-04', amount: 100 }, // Saturday
      { date: '2026-04-04', amount: 200 }, // Saturday — same day, sums to 300
      { date: '2026-04-06', amount: 50 },  // Monday
      { date: '2026-04-13', amount: 80 }   // Monday
    ];
    const r = await getDayOfWeekProfile('whatsapp:+91X', { db: mockDb(rows) });
    expect(r.sampleSize).toBe(3); // 3 unique dates
    const sat = r.days[6];
    const mon = r.days[1];
    expect(sat.total).toBeCloseTo(300, 0);
    expect(mon.total).toBeCloseTo(130, 0);
    expect(sat.observationDays).toBe(1);
    expect(mon.observationDays).toBe(2);
    expect(r.topDay.name).toBe('Sat');
  });

  test('factor reflects relative spend vs global avg', async () => {
    const rows = [];
    // 4 saturdays at 500 each, 4 mondays at 50 each
    const dates = [
      ['2026-04-04', 500], ['2026-04-11', 500], ['2026-04-18', 500], ['2026-04-25', 500],
      ['2026-04-06', 50], ['2026-04-13', 50], ['2026-04-20', 50], ['2026-04-27', 50]
    ];
    for (const [d, a] of dates) rows.push({ date: d, amount: a });
    const r = await getDayOfWeekProfile('whatsapp:+91X', { db: mockDb(rows) });
    expect(r.days[6].factor).toBeGreaterThan(1.5);
    expect(r.days[1].factor).toBeLessThan(0.5);
  });
});

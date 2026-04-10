const {
  CATEGORIES, isCommitted, getMonthName, parseIndianDate, safeParseJSON, getCategoryEmoji
} = require('../constants');

describe('CATEGORIES', () => {
  test('has 17 categories', () => {
    expect(CATEGORIES).toHaveLength(17);
  });

  test('includes expected categories', () => {
    expect(CATEGORIES).toContain('Food & Dining');
    expect(CATEGORIES).toContain('Other');
    expect(CATEGORIES).toContain('Credit Card Payment');
  });
});

describe('isCommitted', () => {
  test('returns true for committed categories', () => {
    expect(isCommitted('Rent')).toBe(true);
    expect(isCommitted('Loan EMI')).toBe(true);
    expect(isCommitted('Investments')).toBe(true);
    expect(isCommitted('Family Transfer')).toBe(true);
    expect(isCommitted('Utilities')).toBe(true);
    expect(isCommitted('Subscriptions')).toBe(true);
    expect(isCommitted('Credit Card Payment')).toBe(true);
  });

  test('returns false for discretionary categories', () => {
    expect(isCommitted('Food & Dining')).toBe(false);
    expect(isCommitted('Shopping')).toBe(false);
    expect(isCommitted('Entertainment')).toBe(false);
    expect(isCommitted('Other')).toBe(false);
  });

  test('returns false for unknown categories', () => {
    expect(isCommitted('Nonexistent')).toBe(false);
    expect(isCommitted('')).toBe(false);
  });
});

describe('parseIndianDate', () => {
  test('parses DD/MM/YYYY format', () => {
    const d = parseIndianDate('15/03/2026');
    expect(d.getDate()).toBe(15);
    expect(d.getMonth()).toBe(2); // March = 2
    expect(d.getFullYear()).toBe(2026);
  });

  test('parses single-digit day/month', () => {
    const d = parseIndianDate('5/1/2026');
    expect(d.getDate()).toBe(5);
    expect(d.getMonth()).toBe(0); // January
  });

  test('returns null for invalid format', () => {
    expect(parseIndianDate('2026-03-15')).toBeNull();
    expect(parseIndianDate('hello')).toBeNull();
    expect(parseIndianDate('')).toBeNull();
  });
});

describe('safeParseJSON', () => {
  test('parses valid JSON', () => {
    expect(safeParseJSON('{"type":"expense","amount":100}')).toEqual({ type: 'expense', amount: 100 });
  });

  test('parses JSON wrapped in markdown code fences', () => {
    const input = '```json\n{"type":"expense"}\n```';
    expect(safeParseJSON(input)).toEqual({ type: 'expense' });
  });

  test('handles whitespace', () => {
    expect(safeParseJSON('  {"ok":true}  ')).toEqual({ ok: true });
  });

  test('returns unknown for completely invalid input', () => {
    expect(safeParseJSON('not json at all')).toEqual({ type: 'unknown' });
  });

  test('returns unknown for empty string', () => {
    expect(safeParseJSON('')).toEqual({ type: 'unknown' });
  });

  test('parses arrays', () => {
    expect(safeParseJSON('[1,2,3]')).toEqual([1, 2, 3]);
  });
});

describe('getCategoryEmoji', () => {
  test('returns correct emoji for known categories', () => {
    expect(getCategoryEmoji('Food & Dining')).toBe('🍽️');
    expect(getCategoryEmoji('Transport')).toBe('🚗');
    expect(getCategoryEmoji('Rent')).toBe('🏠');
  });

  test('returns default emoji for unknown category', () => {
    expect(getCategoryEmoji('Nonexistent')).toBe('💸');
  });
});

describe('getMonthName', () => {
  test('returns a non-empty string', () => {
    const name = getMonthName();
    expect(typeof name).toBe('string');
    expect(name.length).toBeGreaterThan(0);
  });
});

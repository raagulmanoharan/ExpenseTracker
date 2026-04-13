// Test household functions — pure functions only (no DB mocking needed)

const { isSharedCategory, CATEGORIES } = require('../constants');
const { generateHouseholdId } = require('../utils');

describe('isSharedCategory', () => {
  test('returns false when no shared categories', () => {
    expect(isSharedCategory('Groceries', null)).toBe(false);
    expect(isSharedCategory('Groceries', [])).toBe(false);
  });

  test('returns true for categories in shared list', () => {
    const shared = ['Groceries', 'Rent', 'Utilities'];
    expect(isSharedCategory('Groceries', shared)).toBe(true);
    expect(isSharedCategory('Rent', shared)).toBe(true);
    expect(isSharedCategory('Utilities', shared)).toBe(true);
  });

  test('returns false for categories not in shared list', () => {
    const shared = ['Groceries', 'Rent'];
    expect(isSharedCategory('Shopping', shared)).toBe(false);
    expect(isSharedCategory('Entertainment', shared)).toBe(false);
  });
});

describe('generateHouseholdId', () => {
  test('starts with hh_', () => {
    const id = generateHouseholdId();
    expect(id).toMatch(/^hh_/);
  });

  test('is 7 characters long (hh_ + 4 chars)', () => {
    const id = generateHouseholdId();
    expect(id).toHaveLength(7);
  });

  test('contains only lowercase alphanumeric after prefix', () => {
    const id = generateHouseholdId();
    expect(id.substring(3)).toMatch(/^[a-z0-9]{4}$/);
  });

  test('generates unique IDs', () => {
    const ids = new Set();
    for (let i = 0; i < 100; i++) ids.add(generateHouseholdId());
    expect(ids.size).toBeGreaterThan(90);
  });
});

describe('CATEGORIES has expected shared-eligible items', () => {
  test('contains categories commonly shared in a household', () => {
    expect(CATEGORIES).toContain('Groceries');
    expect(CATEGORIES).toContain('Rent');
    expect(CATEGORIES).toContain('Utilities');
    expect(CATEGORIES).toContain('Food & Dining');
  });
});

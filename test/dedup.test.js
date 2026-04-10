const { deduplicateTransactions } = require('../pdf-parser');

// Mock the Anthropic client — not needed for dedup but required by the module
jest.mock('@anthropic-ai/sdk', () => {
  return jest.fn().mockImplementation(() => ({ messages: { create: jest.fn() } }));
});

describe('deduplicateTransactions', () => {
  const existingRows = [
    ['15/03/2026', '10:00 AM', '250', 'Food Delivery', 'Swiggy', '', ''],
    ['16/03/2026', '02:30 PM', '1200', 'Shopping', 'Amazon', '', ''],
  ];

  test('identifies new transactions', () => {
    const parsed = [
      { date: '2026-03-17', amount: 500, merchant: 'Uber', category: 'Transport' },
    ];
    const { toAdd, duplicates } = deduplicateTransactions(parsed, existingRows);
    expect(toAdd).toHaveLength(1);
    expect(duplicates).toHaveLength(0);
  });

  test('identifies duplicate by amount and date', () => {
    const parsed = [
      { date: '2026-03-15', amount: 250, merchant: 'Swiggy', category: 'Food Delivery' },
    ];
    const { toAdd, duplicates } = deduplicateTransactions(parsed, existingRows);
    expect(toAdd).toHaveLength(0);
    expect(duplicates).toHaveLength(1);
  });

  test('allows same amount on different dates', () => {
    const parsed = [
      { date: '2026-03-20', amount: 250, merchant: 'Zomato', category: 'Food Delivery' },
    ];
    const { toAdd, duplicates } = deduplicateTransactions(parsed, existingRows);
    expect(toAdd).toHaveLength(1);
    expect(duplicates).toHaveLength(0);
  });

  test('catches within-batch duplicates', () => {
    const parsed = [
      { date: '2026-03-20', amount: 300, merchant: 'Uber', category: 'Transport' },
      { date: '2026-03-20', amount: 300, merchant: 'Uber Duplicate', category: 'Transport' },
    ];
    const { toAdd, duplicates } = deduplicateTransactions(parsed, existingRows);
    expect(toAdd).toHaveLength(1);
    expect(duplicates).toHaveLength(1);
  });

  test('handles empty existing rows', () => {
    const parsed = [
      { date: '2026-03-17', amount: 500, merchant: 'Uber', category: 'Transport' },
    ];
    const { toAdd, duplicates } = deduplicateTransactions(parsed, []);
    expect(toAdd).toHaveLength(1);
    expect(duplicates).toHaveLength(0);
  });

  test('handles empty parsed array', () => {
    const { toAdd, duplicates } = deduplicateTransactions([], existingRows);
    expect(toAdd).toHaveLength(0);
    expect(duplicates).toHaveLength(0);
  });

  test('exact same date is duplicate', () => {
    const parsed = [
      { date: '2026-03-15', amount: 1200, merchant: 'Amazon', category: 'Shopping' },
    ];
    const { toAdd, duplicates } = deduplicateTransactions(parsed, existingRows);
    // Note: +-1 day tolerance can be affected by UTC vs local timezone parsing
    expect(duplicates).toHaveLength(1);
  });
});

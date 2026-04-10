// Test pure functions from sheets.js that don't need Google Sheets API
// We mock the Google API to prevent real network calls during require()

jest.mock('googleapis', () => ({
  google: {
    auth: { GoogleAuth: jest.fn() },
    sheets: jest.fn(() => ({}))
  }
}));

// Must set env vars before requiring sheets.js
process.env.GOOGLE_SERVICE_ACCOUNT_JSON = '{"type":"service_account","project_id":"test"}';
process.env.GOOGLE_SHEET_ID = 'test-sheet-id';

const {
  parseSalaryInput, parseStatementInput, getDaysUntilStatement,
  getBillingCycleAdvice, getSalaryCycleBounds, computeUserCycleBounds
} = require('../sheets');

describe('parseSalaryInput', () => {
  test('parses numeric day', () => {
    expect(parseSalaryInput('26')).toEqual({ type: 'fixed', day: 26 });
    expect(parseSalaryInput('1')).toEqual({ type: 'fixed', day: 1 });
    expect(parseSalaryInput('31')).toEqual({ type: 'fixed', day: 31 });
  });

  test('parses day with suffix', () => {
    expect(parseSalaryInput('26th')).toEqual({ type: 'fixed', day: 26 });
    expect(parseSalaryInput('1st')).toEqual({ type: 'fixed', day: 1 });
  });

  test('parses "last"', () => {
    expect(parseSalaryInput('last')).toEqual({ type: 'last', day: null });
    expect(parseSalaryInput('end of month')).toEqual({ type: 'last', day: null });
    expect(parseSalaryInput('eom')).toEqual({ type: 'last', day: null });
  });

  test('parses "last working day"', () => {
    expect(parseSalaryInput('last working day')).toEqual({ type: 'last_working', day: null });
    expect(parseSalaryInput('lwd')).toEqual({ type: 'last_working', day: null });
  });

  test('returns null for invalid input', () => {
    expect(parseSalaryInput('hello')).toBeNull();
    expect(parseSalaryInput('0')).toBeNull();
    expect(parseSalaryInput('32')).toBeNull();
  });
});

describe('parseStatementInput', () => {
  test('parses "HSBC 5"', () => {
    expect(parseStatementInput('HSBC 5')).toEqual({ HSBC: 5 });
  });

  test('parses multiple cards', () => {
    const result = parseStatementInput('HSBC 5, AMEX 12');
    expect(result).toEqual({ HSBC: 5, AMEX: 12 });
  });

  test('parses single number as _single', () => {
    expect(parseStatementInput('5')).toEqual({ _single: 5 });
  });

  test('handles colon separator', () => {
    expect(parseStatementInput('HSBC: 5')).toEqual({ HSBC: 5 });
  });

  test('returns empty for invalid input', () => {
    expect(parseStatementInput('hello')).toEqual({});
  });
});

describe('getDaysUntilStatement', () => {
  test('returns days when statement is later this month', () => {
    const now = new Date();
    const futureDay = now.getDate() + 5;
    if (futureDay <= 28) { // avoid month boundary complexity
      expect(getDaysUntilStatement(futureDay)).toBe(5);
    }
  });

  test('wraps around to next month', () => {
    const result = getDaysUntilStatement(1);
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThanOrEqual(31);
  });
});

describe('getBillingCycleAdvice', () => {
  test('returns sorted advice for multiple cards', () => {
    const advice = getBillingCycleAdvice({ HSBC: 15, AMEX: 25 });
    expect(advice).toHaveLength(2);
    // Should be sorted by interestFreeDays descending
    expect(advice[0].interestFreeDays).toBeGreaterThanOrEqual(advice[1].interestFreeDays);
  });

  test('returns null for empty dates', () => {
    expect(getBillingCycleAdvice({})).toBeNull();
    expect(getBillingCycleAdvice(null)).toBeNull();
  });

  test('each result has expected fields', () => {
    const advice = getBillingCycleAdvice({ HSBC: 10 });
    expect(advice[0]).toHaveProperty('card', 'HSBC');
    expect(advice[0]).toHaveProperty('statementDay', 10);
    expect(advice[0]).toHaveProperty('daysUntilStatement');
    expect(advice[0]).toHaveProperty('interestFreeDays');
  });
});

describe('getSalaryCycleBounds', () => {
  test('returns cycleStart and cycleEnd', () => {
    const result = getSalaryCycleBounds();
    expect(result).toHaveProperty('cycleStart');
    expect(result).toHaveProperty('cycleEnd');
    expect(result.cycleStart).toBeInstanceOf(Date);
    expect(result.cycleEnd).toBeInstanceOf(Date);
    expect(result.cycleEnd > result.cycleStart).toBe(true);
  });

  test('accepts a reference date', () => {
    const ref = new Date('2026-05-15');
    const result = getSalaryCycleBounds(ref);
    expect(result.cycleStart <= ref).toBe(true);
    expect(result.cycleEnd >= ref).toBe(true);
  });
});

describe('computeUserCycleBounds', () => {
  test('fixed salary type — mid cycle', () => {
    const today = new Date(2026, 3, 15); // April 15
    const result = computeUserCycleBounds(today, { salaryType: 'fixed', salaryDay: 26 });
    expect(result.cycleStart.getDate()).toBe(26);
    expect(result.cycleStart.getMonth()).toBe(2); // March 26
    expect(result.cycleEnd.getDate()).toBe(25);
    expect(result.cycleEnd.getMonth()).toBe(3); // April 25
  });

  test('fixed salary type — after pay day', () => {
    const today = new Date(2026, 3, 28); // April 28
    const result = computeUserCycleBounds(today, { salaryType: 'fixed', salaryDay: 26 });
    expect(result.cycleStart.getDate()).toBe(26);
    expect(result.cycleStart.getMonth()).toBe(3); // April 26
  });

  test('last day of month type', () => {
    const today = new Date(2026, 3, 15); // April 15
    const result = computeUserCycleBounds(today, { salaryType: 'last' });
    expect(result.cycleStart).toBeInstanceOf(Date);
    expect(result.cycleEnd).toBeInstanceOf(Date);
    expect(result.cycleEnd > result.cycleStart).toBe(true);
  });

  test('last working day type', () => {
    const today = new Date(2026, 3, 15); // April 15
    const result = computeUserCycleBounds(today, { salaryType: 'last_working' });
    expect(result.cycleStart).toBeInstanceOf(Date);
    expect(result.cycleEnd > result.cycleStart).toBe(true);
    // Cycle start should be a weekday
    const dayOfWeek = result.cycleStart.getDay();
    expect(dayOfWeek).toBeGreaterThan(0);
    expect(dayOfWeek).toBeLessThan(6);
  });

  test('unknown type falls back to calendar month', () => {
    const today = new Date(2026, 3, 15);
    const result = computeUserCycleBounds(today, { salaryType: 'unknown' });
    expect(result.cycleStart.getDate()).toBe(1);
    expect(result.cycleStart.getMonth()).toBe(3); // April 1
  });
});

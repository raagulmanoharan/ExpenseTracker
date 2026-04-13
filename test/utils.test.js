// Test pure computation functions from utils.js (extracted from sheets.js)
// No Google Sheets or Supabase mocking needed — these are pure functions.

const {
  parseSalaryInput, parseStatementInput, getDaysUntilStatement,
  getBillingCycleAdvice, getSalaryCycleBounds, computeUserCycleBounds,
  isWithinSessionWindow
} = require('../utils');

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

  test('rejects bank SMS with "debited"', () => {
    expect(parseStatementInput('ICICI Bank Acct XX999 debited for Rs 163.00 on 12-Apr-26')).toEqual({});
  });

  test('rejects bank SMS with "credited"', () => {
    expect(parseStatementInput('Your a/c XX123 credited with Rs 50000.00')).toEqual({});
  });

  test('rejects bank SMS with "transaction"', () => {
    expect(parseStatementInput('Transaction of Rs 500 on your card ending 1234')).toEqual({});
  });

  test('rejects bank SMS with UPI keywords', () => {
    expect(parseStatementInput('UPI txn of Rs 250 to MERCHANT ref 123456')).toEqual({});
  });

  test('rejects messages with Rs amount pattern', () => {
    expect(parseStatementInput('Paid Rs 1500 via NEFT')).toEqual({});
  });

  test('rejects messages with "balance"', () => {
    expect(parseStatementInput('Your balance is Rs 25000. Last txn Rs 163')).toEqual({});
  });

  test('still parses valid statement input after rejection checks', () => {
    expect(parseStatementInput('HSBC 5')).toEqual({ HSBC: 5 });
    expect(parseStatementInput('AMEX 12, AXIS 18')).toEqual({ AMEX: 12, AXIS: 18 });
    expect(parseStatementInput('5')).toEqual({ _single: 5 });
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

describe('isWithinSessionWindow', () => {
  test('returns false when user is null', () => {
    expect(isWithinSessionWindow(null)).toBe(false);
  });

  test('returns false when lastMessageAt is null', () => {
    expect(isWithinSessionWindow({ lastMessageAt: null })).toBe(false);
  });

  test('returns true when last message was 1 hour ago', () => {
    const oneHourAgo = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
    expect(isWithinSessionWindow({ lastMessageAt: oneHourAgo })).toBe(true);
  });

  test('returns true when last message was 23 hours ago', () => {
    const twentyThreeHoursAgo = new Date(Date.now() - 23 * 60 * 60 * 1000).toISOString();
    expect(isWithinSessionWindow({ lastMessageAt: twentyThreeHoursAgo })).toBe(true);
  });

  test('returns false when last message was 25 hours ago', () => {
    const twentyFiveHoursAgo = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    expect(isWithinSessionWindow({ lastMessageAt: twentyFiveHoursAgo })).toBe(false);
  });

  test('returns false when lastMessageAt is empty string', () => {
    expect(isWithinSessionWindow({ lastMessageAt: '' })).toBe(false);
  });
});

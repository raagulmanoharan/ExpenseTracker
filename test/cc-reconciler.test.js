// Tests for the CC statement reconciler. Uses mock db helpers — no Supabase or
// Anthropic calls. Focus is on the decision logic (insert / update / conflict).

const { reconcile, findMatches, decide } = require('../cc-statement-reconciler');

function makeDb({ existing = [] } = {}) {
  const inserted = [];
  const updated = [];
  const stmtsInserted = [];
  const stmtsUpdated = [];
  return {
    state: { inserted, updated, stmtsInserted, stmtsUpdated },
    listExpensesInRange: async () => existing.map(r => ({ ...r })),
    updateExpense: async (id, patch) => { updated.push({ id, patch }); },
    insertExpense: async (row) => { inserted.push(row); return { id: 'new-' + (inserted.length) }; },
    insertCcStatement: async (row) => { stmtsInserted.push(row); return { id: 'stmt-1' }; },
    updateCcStatement: async (id, patch) => { stmtsUpdated.push({ id, patch }); }
  };
}

describe('findMatches', () => {
  test('matches by amount within Rs.1 tolerance', () => {
    const txn = { date: '2026-04-15', amount: 1000 };
    const rows = [
      { id: 1, date: '2026-04-15', amount: 1000.5 },
      { id: 2, date: '2026-04-15', amount: 1002 },
      { id: 3, date: '2026-04-15', amount: 999.99 }
    ];
    const m = findMatches(txn, rows);
    expect(m.map(r => r.id).sort()).toEqual([1, 3]);
  });

  test('matches by date within ±2 days', () => {
    const txn = { date: '2026-04-15', amount: 1000 };
    const rows = [
      { id: 1, date: '2026-04-13', amount: 1000 },
      { id: 2, date: '2026-04-17', amount: 1000 },
      { id: 3, date: '2026-04-18', amount: 1000 }
    ];
    const m = findMatches(txn, rows);
    expect(m.map(r => r.id).sort()).toEqual([1, 2]);
  });
});

describe('decide', () => {
  test('no matches → insert', () => {
    expect(decide([], 'AMEX', { date: '2026-04-15', amount: 1000 }).action).toBe('insert');
  });

  test('1 untagged match → update', () => {
    const d = decide([{ id: 1, date: '2026-04-15', amount: 1000, card: null }], 'AMEX', { date: '2026-04-15', amount: 1000 });
    expect(d.action).toBe('update');
    expect(d.row.id).toBe(1);
  });

  test('1 match same card → update (idempotent re-run)', () => {
    const d = decide([{ id: 1, card: 'AMEX' }], 'AMEX', { date: '2026-04-15', amount: 1000 });
    expect(d.action).toBe('update');
  });

  test('1 match different card → conflict', () => {
    const d = decide([{ id: 1, card: 'HSBC' }], 'AMEX', {});
    expect(d.action).toBe('conflict');
    expect(d.reason).toBe('card_mismatch');
  });

  test('multiple untagged matches → conflict', () => {
    const d = decide([{ id: 1, card: null }, { id: 2, card: null }], 'AMEX', {});
    expect(d.action).toBe('conflict');
  });

  test('multiple matches, one already tagged with same card → update that one', () => {
    const d = decide([{ id: 1, card: 'AMEX' }, { id: 2, card: 'HSBC' }], 'AMEX', {});
    expect(d.action).toBe('update');
    expect(d.row.id).toBe(1);
  });
});

describe('reconcile — end-to-end', () => {
  const baseStmt = {
    cardUserKey: 'AMEX PLAT TRAVEL',
    card: 'AMEX PLATINUM TRAVEL',
    periodStart: '2026-04-01',
    periodEnd: '2026-04-30',
    statementDate: '2026-05-02',
    totalSpend: 50000,
    totalCredits: 0,
    closingBalance: 50000,
    transactions: []
  };

  test('refunds increment refunds counter and skip', async () => {
    const stmt = { ...baseStmt, transactions: [
      { date: '2026-04-12', amount: 500, isRefund: true, merchant: 'Refund' }
    ] };
    const db = makeDb();
    const r = await reconcile(stmt, 'whatsapp:+91X', db);
    expect(r.summary.refunds).toBe(1);
    expect(db.state.inserted).toHaveLength(0);
  });

  test('new txn (no existing match) → insert tagged with card + statement_id', async () => {
    const stmt = { ...baseStmt, transactions: [
      { date: '2026-04-15', amount: 1500, merchant: 'Tanishq', category: 'Shopping' }
    ] };
    const db = makeDb({ existing: [] });
    const r = await reconcile(stmt, 'whatsapp:+91X', db);
    expect(r.summary.newRows).toBe(1);
    expect(db.state.inserted[0]).toMatchObject({
      amount: 1500, merchant: 'Tanishq', card: 'AMEX PLAT TRAVEL', statement_id: 'stmt-1'
    });
  });

  test('untagged existing match → update with card + statement_id', async () => {
    const stmt = { ...baseStmt, transactions: [
      { date: '2026-04-15', amount: 1500, merchant: 'Tanishq', category: 'Shopping' }
    ] };
    const db = makeDb({ existing: [
      { id: 'exp-1', date: '2026-04-15', amount: 1500, card: null, merchant: 'Tanishq', category: 'Shopping' }
    ] });
    const r = await reconcile(stmt, 'whatsapp:+91X', db);
    expect(r.summary.tagged).toBe(1);
    expect(r.summary.newRows).toBe(0);
    expect(db.state.updated[0].patch).toMatchObject({ card: 'AMEX PLAT TRAVEL', statement_id: 'stmt-1' });
  });

  test('date off by 1 day → fixes date when allowDateFix=true', async () => {
    const stmt = { ...baseStmt, transactions: [
      { date: '2026-04-15', amount: 1500, merchant: 'Tanishq', category: 'Shopping' }
    ] };
    const db = makeDb({ existing: [
      { id: 'exp-1', date: '2026-04-14', amount: 1500, card: null }
    ] });
    const r = await reconcile(stmt, 'whatsapp:+91X', db);
    expect(r.summary.dateFixed).toBe(1);
    expect(db.state.updated[0].patch.date).toBe('2026-04-15');
  });

  test('existing tagged with different card → conflict, no write', async () => {
    const stmt = { ...baseStmt, transactions: [
      { date: '2026-04-15', amount: 1500, merchant: 'Tanishq', category: 'Shopping' }
    ] };
    const db = makeDb({ existing: [
      { id: 'exp-1', date: '2026-04-15', amount: 1500, card: 'HSBC PREMIER' }
    ] });
    const r = await reconcile(stmt, 'whatsapp:+91X', db);
    expect(r.summary.conflicts).toBe(1);
    expect(db.state.updated).toHaveLength(0);
    expect(r.log.conflicts[0].reason).toBe('card_mismatch');
  });

  test('cardUserKey missing → fully skipped, no writes', async () => {
    const stmt = { ...baseStmt, cardUserKey: null, transactions: [
      { date: '2026-04-15', amount: 1500 }
    ] };
    const db = makeDb();
    const r = await reconcile(stmt, 'whatsapp:+91X', db);
    expect(r.statementId).toBeNull();
    expect(db.state.stmtsInserted).toHaveLength(0);
    expect(r.log.conflicts[0].reason).toBe('card_not_resolved');
  });

  test('dry-run → parses + decides but no writes', async () => {
    const stmt = { ...baseStmt, transactions: [
      { date: '2026-04-15', amount: 1500, merchant: 'Tanishq', category: 'Shopping' }
    ] };
    const db = makeDb({ existing: [] });
    const r = await reconcile(stmt, 'whatsapp:+91X', db, { dryRun: true });
    expect(r.summary.newRows).toBe(1);
    expect(db.state.inserted).toHaveLength(0);
    expect(db.state.stmtsInserted).toHaveLength(0);
  });

  test('upgrades category from Other when statement provides better one', async () => {
    const stmt = { ...baseStmt, transactions: [
      { date: '2026-04-15', amount: 1500, merchant: 'Tanishq', category: 'Shopping' }
    ] };
    const db = makeDb({ existing: [
      { id: 'exp-1', date: '2026-04-15', amount: 1500, card: null, category: 'Other' }
    ] });
    await reconcile(stmt, 'whatsapp:+91X', db);
    expect(db.state.updated[0].patch.category).toBe('Shopping');
  });
});

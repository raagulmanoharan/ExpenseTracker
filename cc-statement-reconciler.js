// ─── CC statement reconciler ────────────────────────────────────────────────
//
// Takes a parsed CC statement (from cc-statement-parser.js) and reconciles its
// transactions against existing expenses for the user. Reconciliation is
// auto-merge with conflict flagging:
//
//   For each parsed transaction:
//     1. Find existing expenses matching by amount (±Rs.1) within ±2 days of
//        the txn date for this phone (any card or null card).
//     2. If 0 matches → INSERT as new expense, tagged with statement.card +
//        statement_id, dated to the txn date.
//     3. If 1 match where card IS NULL or matches the statement card →
//        UPDATE: set card, statement_id, fix date if off (record original_date
//        in note), keep merchant/category/note from the existing row by
//        default unless it's "Other"/empty.
//     4. If 1 match where card is set to a DIFFERENT card → CONFLICT. Skip,
//        log to reconcile_log.conflicts. Do not write anything.
//     5. If 2+ matches → ambiguous; pick the closest-by-date match if untagged,
//        else CONFLICT.
//
// Refunds (isRefund=true) — for now we just record them in the conflict/log
// stream. They aren't expenses; tracking them properly is PR B work.

const AMOUNT_EPS_INR = 1;
const DATE_WINDOW_DAYS = 2;

function daysBetween(a, b) {
  const ms = Math.abs(new Date(a).getTime() - new Date(b).getTime());
  return Math.round(ms / (1000 * 60 * 60 * 24));
}

/**
 * @param {object} parsedStmt - output of parseCcStatement()
 * @param {string} phone      - user's phone (PK on expenses)
 * @param {object} db         - injected db helpers for testability:
 *   {
 *     listExpensesInRange(phone, fromDate, toDate)   => [{id, date, amount, card, statement_id, merchant, category, note, raw_message}]
 *     updateExpense(id, patch)                       => Promise<void>
 *     insertExpense(row)                             => Promise<{id}>
 *     insertCcStatement(row)                         => Promise<{id}>
 *   }
 * @param {object} [opts] - { dryRun?: bool, allowDateFix?: bool }
 * @returns {Promise<{statementId, summary, log}>}
 */
async function reconcile(parsedStmt, phone, db, opts = {}) {
  const dryRun = !!opts.dryRun;
  const allowDateFix = opts.allowDateFix !== false; // default true

  if (!parsedStmt.cardUserKey) {
    return {
      statementId: null,
      summary: { tagged: 0, dateFixed: 0, newRows: 0, conflicts: 0, refunds: 0, skipped: parsedStmt.transactions?.length || 0 },
      log: { conflicts: [{ reason: 'card_not_resolved', card: parsedStmt.card }] }
    };
  }

  // 1. Window for candidate-matching: stretch txn-date range by ±DATE_WINDOW_DAYS.
  const periodStart = parsedStmt.periodStart;
  const periodEnd = parsedStmt.periodEnd;
  const windowStart = shiftDate(periodStart, -DATE_WINDOW_DAYS);
  const windowEnd = shiftDate(periodEnd, DATE_WINDOW_DAYS);
  const existing = await db.listExpensesInRange(phone, windowStart, windowEnd);

  // 2. Insert (or stage) the cc_statements row first, so we have an id for FKs.
  let statementId = null;
  if (!dryRun) {
    const stmtRow = await db.insertCcStatement({
      phone,
      card: parsedStmt.cardUserKey,
      period_start: periodStart,
      period_end: periodEnd,
      statement_date: parsedStmt.statementDate || null,
      total_spend: parsedStmt.totalSpend || null,
      total_credits: parsedStmt.totalCredits || null,
      closing_balance: parsedStmt.closingBalance || null,
      txn_count: (parsedStmt.transactions || []).length,
      source: opts.source || 'unknown',
      source_path: opts.sourcePath || null
    });
    statementId = stmtRow.id;
  }

  // 3. Walk each transaction.
  const summary = { tagged: 0, dateFixed: 0, newRows: 0, conflicts: 0, refunds: 0 };
  const log = { conflicts: [], dateFixes: [], newRows: [], tagged: [] };

  for (const txn of parsedStmt.transactions || []) {
    if (txn.isRefund) {
      summary.refunds++;
      continue;
    }
    const matches = findMatches(txn, existing);
    const decision = decide(matches, parsedStmt.cardUserKey, txn);

    if (decision.action === 'insert') {
      if (!dryRun) {
        await db.insertExpense({
          phone,
          date: txn.date,
          amount: Number(txn.amount),
          category: txn.category || 'Other',
          merchant: txn.merchant || null,
          note: txn.note || null,
          raw_message: '[cc-statement-import]',
          card: parsedStmt.cardUserKey,
          statement_id: statementId
        });
      }
      summary.newRows++;
      log.newRows.push({ date: txn.date, amount: txn.amount, merchant: txn.merchant });
    } else if (decision.action === 'update') {
      const patch = {};
      if (!decision.row.card) patch.card = parsedStmt.cardUserKey;
      if (!decision.row.statement_id) patch.statement_id = statementId;
      if (allowDateFix && decision.row.date !== txn.date) {
        patch.date = txn.date;
        log.dateFixes.push({ id: decision.row.id, from: decision.row.date, to: txn.date });
        summary.dateFixed++;
      }
      // Upgrade category/merchant only if existing is "Other"/empty (statement is more authoritative).
      if (txn.category && txn.category !== 'Other' && (decision.row.category === 'Other' || !decision.row.category)) {
        patch.category = txn.category;
      }
      if (txn.merchant && !decision.row.merchant) patch.merchant = txn.merchant;

      if (Object.keys(patch).length > 0 && !dryRun) {
        await db.updateExpense(decision.row.id, patch);
      }
      if (patch.card) {
        summary.tagged++;
        log.tagged.push({ id: decision.row.id, date: decision.row.date, amount: decision.row.amount, card: parsedStmt.cardUserKey });
      }
    } else if (decision.action === 'conflict') {
      summary.conflicts++;
      log.conflicts.push({
        reason: decision.reason,
        txn: { date: txn.date, amount: txn.amount, merchant: txn.merchant },
        existing: decision.rows?.map(r => ({ id: r.id, date: r.date, amount: r.amount, card: r.card }))
      });
    }
  }

  // 4. Persist the reconcile log on the cc_statements row.
  if (!dryRun && statementId) {
    await db.updateCcStatement(statementId, { reconcile_log: { summary, ...log } });
  }

  return { statementId, summary, log };
}

function findMatches(txn, existingRows) {
  const target = Number(txn.amount);
  return existingRows.filter(r => {
    const amt = Number(r.amount);
    if (Math.abs(amt - target) > AMOUNT_EPS_INR) return false;
    return daysBetween(r.date, txn.date) <= DATE_WINDOW_DAYS;
  });
}

function decide(matches, statementCard, txn) {
  if (matches.length === 0) return { action: 'insert' };

  if (matches.length === 1) {
    const row = matches[0];
    if (!row.card || row.card === statementCard) return { action: 'update', row };
    return { action: 'conflict', reason: 'card_mismatch', rows: matches };
  }

  // 2+ matches — pick the closest-by-date untagged row.
  const untagged = matches.filter(r => !r.card);
  if (untagged.length === 1) return { action: 'update', row: untagged[0] };
  if (untagged.length === 0) {
    // All tagged. If any matches the statement card, treat as already-resolved.
    const sameCard = matches.find(r => r.card === statementCard);
    if (sameCard) return { action: 'update', row: sameCard };
    return { action: 'conflict', reason: 'multiple_tagged_other_cards', rows: matches };
  }
  return { action: 'conflict', reason: 'multiple_untagged_matches', rows: matches };
}

function shiftDate(yyyyMmDd, deltaDays) {
  const d = new Date(yyyyMmDd);
  d.setDate(d.getDate() + deltaDays);
  return d.toISOString().split('T')[0];
}

module.exports = { reconcile, findMatches, decide };

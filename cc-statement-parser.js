// ─── Credit-card statement parser ───────────────────────────────────────────
//
// Parses a credit-card statement PDF into:
//   { card, periodStart, periodEnd, statementDate, totalSpend, totalCredits,
//     closingBalance, transactions: [{ date, amount, merchant, category, ... }] }
//
// Distinct from pdf-parser.js (bank statements) because:
//   - The PDF is for ONE card; engine needs to identify which one (regex on
//     issuer + variant against KB aliases + user's saved aliases).
//   - Extracts statement-level metadata (period, total, closing balance) for
//     the cc_statements row.
//   - Handles refunds/payments differently — they aren't expenses, but they
//     reduce the period's net spend.

const axios = require('axios');
const { client, callWithRetry } = require('./anthropic-client');
const { CATEGORIES, safeParseJSON } = require('./constants');
const { matchUserCards, loadKB } = require('./card-strategy');

// xlsx is a runtime dep — required lazily so unit tests don't pull it in.
let _xlsx = null;
function xlsxLib() { return _xlsx || (_xlsx = require('xlsx')); }

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const XLS_MIME = 'application/vnd.ms-excel';

function buildSystemPrompt(user) {
  const cards = user?.statementDates ? Object.keys(user.statementDates) : [];
  const cardContext = cards.length > 0
    ? '\nThe user has these cards on file: ' + cards.join(', ') + '. The statement is for ONE of these — identify which.'
    : '';

  return `You are a credit-card statement parser for India. Extract transactions AND statement metadata from the PDF.
${cardContext}
RETURN A SINGLE JSON OBJECT with these fields:

{
  "card": "<best-guess card name from header (uppercased, normalized like 'AMEX PLAT TRAVEL', 'AXIS ATLAS', 'HDFC SWIGGY')>",
  "cardLast4": "<last 4 digits of card number or null>",
  "periodStart": "YYYY-MM-DD",
  "periodEnd": "YYYY-MM-DD",
  "statementDate": "YYYY-MM-DD",
  "totalSpend": <number — total debit amount in this cycle>,
  "totalCredits": <number — refunds + payments received>,
  "closingBalance": <number — closing/total amount due>,
  "transactions": [
    {
      "date": "YYYY-MM-DD",
      "amount": <positive number — purchase amount in INR>,
      "merchant": "<clean merchant name>",
      "category": "<one of: ${CATEGORIES.join(', ')}>",
      "isRefund": <bool — true if this is a refund/credit, false if debit>,
      "note": "<optional short note>",
      "confidence": <0-100>
    }
  ]
}

RULES:
- Capture EVERY debit (purchase) and refund/credit. Skip only EMI conversion fees, late-payment fees, finance charges, GST line items — those aren't user expenses.
- Skip the "Payment Received" / "Thank You for Your Payment" line — that's the user paying their own bill.
- date format: YYYY-MM-DD (Indian DD/MM/YYYY → swap)
- amount is always positive; use isRefund=true for credits
- For the "card" field, look at the statement header. Match against the user's saved cards listed above when possible. Common header strings: "American Express® Platinum Travel", "Axis Bank ATLAS Credit Card Statement", "HDFC Bank Swiggy Credit Card", "Amazon Pay ICICI Bank Credit Card".
- If the statement doesn't clearly identify the card (rare), set card to null — caller will prompt.
- For category, use clean Indian context (Swiggy = Food Delivery, MakeMyTrip = Travel, Tanishq = Shopping, etc).

Return ONLY the JSON object. No prose, no markdown fences.`;
}

/**
 * Convert an XLSX/XLS workbook to a single text representation Claude can parse.
 * Concatenates each sheet as CSV with a header line.
 */
function xlsxBufferToText(buffer) {
  const wb = xlsxLib().read(buffer, { type: 'buffer' });
  const parts = [];
  for (const name of wb.SheetNames) {
    const sheet = wb.Sheets[name];
    const csv = xlsxLib().utils.sheet_to_csv(sheet, { rawNumbers: false });
    if (csv.trim().length === 0) continue;
    parts.push(`### Sheet: ${name}\n${csv}`);
  }
  return parts.join('\n\n');
}

/**
 * Parse a CC statement (PDF or XLSX/XLS).
 * @param {object} input - one of:
 *   { pdfBuffer: Buffer }                  — local PDF
 *   { xlsxBuffer: Buffer }                 — local XLSX/XLS
 *   { mediaUrl: string, mediaType?: string, twilioAuth?: {username, password} }
 *     — WhatsApp media, mediaType selects PDF vs XLSX path
 * @param {object} user
 */
async function parseCcStatement(input, user) {
  let format = null;     // 'pdf' | 'xlsx'
  let base64PDF = null;
  let xlsxText = null;

  if (input.pdfBuffer) {
    format = 'pdf';
    base64PDF = Buffer.from(input.pdfBuffer).toString('base64');
  } else if (input.xlsxBuffer) {
    format = 'xlsx';
    xlsxText = xlsxBufferToText(input.xlsxBuffer);
  } else if (input.mediaUrl) {
    const auth = input.twilioAuth || {
      username: process.env.TWILIO_ACCOUNT_SID,
      password: process.env.TWILIO_AUTH_TOKEN
    };
    const res = await axios.get(input.mediaUrl, { responseType: 'arraybuffer', auth });
    const buf = Buffer.from(res.data);
    const mt = (input.mediaType || '').toLowerCase();
    if (mt === XLSX_MIME || mt === XLS_MIME) {
      format = 'xlsx';
      xlsxText = xlsxBufferToText(buf);
    } else {
      format = 'pdf';
      base64PDF = buf.toString('base64');
    }
  } else {
    throw new Error('parseCcStatement: pdfBuffer, xlsxBuffer, or mediaUrl required');
  }

  const userContent = format === 'pdf'
    ? [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64PDF } },
        { type: 'text', text: 'Parse this credit-card statement. Return ONLY the JSON object specified.' }
      ]
    : [
        { type: 'text', text: 'Parse this credit-card statement (exported as a spreadsheet — multiple sheets concatenated below as CSV). Return ONLY the JSON object specified.\n\n' + xlsxText }
      ];

  const response = await callWithRetry(() => client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 8000,
    system: buildSystemPrompt(user),
    messages: [{ role: 'user', content: userContent }]
  }));

  const raw = response.content[0].text.trim();
  const parsed = safeParseJSON(raw);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('parseCcStatement: model returned invalid JSON');
  }

  // Resolve the parsed card name to a user-key the engine recognizes.
  parsed.cardUserKey = resolveCardKey(parsed.card, user);
  parsed.transactions = (parsed.transactions || []).filter(t => t && t.amount && t.date);
  return parsed;
}

/**
 * Map the LLM's parsed card name to one of the user's saved statementDates keys.
 * Returns the user-key (e.g. "AMEX PLAT TRAVEL") if we can match, else null.
 */
function resolveCardKey(parsedCardName, user) {
  if (!parsedCardName) return null;
  const userKeys = Object.keys((user && user.statementDates) || {});
  if (userKeys.length === 0) return null;

  const norm = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const target = norm(parsedCardName);

  // Exact-or-substring match against user keys.
  for (const k of userKeys) {
    const nk = norm(k);
    if (nk === target || nk.includes(target) || target.includes(nk)) return k;
  }

  // Fall back via KB aliases — find the KB card whose aliases match the parsed
  // name, then map that KB card back to the user's key via matchUserCards.
  const kb = loadKB();
  for (const [, card] of Object.entries(kb.cards || {})) {
    const aliases = (card.aliases || []).map(norm);
    if (aliases.some(a => a === target || a.includes(target) || target.includes(a))) {
      const owned = matchUserCards(user);
      const hit = owned.find(o => o.card === card);
      if (hit) return hit.userKey;
    }
  }
  return null;
}

module.exports = { parseCcStatement, resolveCardKey, xlsxBufferToText, XLSX_MIME, XLS_MIME };

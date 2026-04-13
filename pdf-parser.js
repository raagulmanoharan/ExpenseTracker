const axios = require('axios');
const { client, callWithRetry } = require('./anthropic-client');
const { CATEGORIES, safeParseJSON, parseIndianDate } = require('./constants');

function buildPdfSystemPrompt(user) {
  const cards = user?.statementDates ? Object.keys(user.statementDates) : [];
  const cardContext = cards.length > 0
    ? '\nThe user has these cards: ' + cards.join(', ') + '. Log ALL debit transactions. Skip refunds, cashbacks, credits.\n'
    : '';

  return `You are a bank statement parser for someone based in India.
Extract ALL debit/outflow transactions from the statement and return ONLY a JSON array.
${cardContext}
RULES:
- Log EVERY rupee that goes out — merchant spends, UPI transfers, family support, EMIs, SIPs, investments, insurance
- Only skip: credits, refunds, cashbacks, salary inflows, interest earned, payment reversals, and self-transfers between the user's own accounts
- Use these categories:
  - "Family Transfer" — money sent to parents, relatives (NEFT/IMPS/UPI to family members)
  - "Investments" — SIPs, mutual funds, stocks, Zerodha, Groww, PPF, NPS, FDs
  - "Loan EMI" — home loan, personal loan, car loan EMIs
  - "Credit Card Payment" — CRED, BillDesk, or bank app credit card bill payments. These are pass-through payments — still log them but use this category.
  - "Family Transfer" — UPI transfers where recipient looks like a person name (MANOHARAN R, ADITHEE S etc), or explicitly mentions parents/family
  - "Utilities" — electricity, water, internet, mobile recharge, insurance premiums
  - All other categories for lifestyle spends
- amount is a plain positive number (no ₹, no commas)
- date format: YYYY-MM-DD
- merchant: clean, properly capitalised name (e.g. "HDFC Mutual Fund", "LIC", "Swiggy", "Amazon")
- category: pick from: ${CATEGORIES.join(', ')}
- confidence: 0-100

Return format — ONLY valid JSON, nothing else:
[
  {
    "date": "YYYY-MM-DD",
    "amount": 250,
    "merchant": "Swiggy",
    "category": "Food Delivery",
    "note": "optional short note or null",
    "confidence": 90
  }
]

If no transactions found, return: []`;
}

async function parsePDFStatement(mediaUrl, user) {
  const pdfResponse = await axios.get(mediaUrl, {
    responseType: 'arraybuffer',
    auth: {
      username: process.env.TWILIO_ACCOUNT_SID,
      password: process.env.TWILIO_AUTH_TOKEN
    }
  });

  const base64PDF = Buffer.from(pdfResponse.data).toString('base64');

  const response = await callWithRetry(() => client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4000,
    system: buildPdfSystemPrompt(user),
    messages: [{
      role: 'user',
      content: [
        {
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: base64PDF }
        },
        {
          type: 'text',
          text: 'Extract all outflow transactions. Return ONLY a JSON array, no explanation.'
        }
      ]
    }]
  }));

  const raw = response.content[0].text.trim();
  const parsed = safeParseJSON(raw);
  return Array.isArray(parsed) ? parsed : [];
}

// Match by exact amount + date within ±1 day
function deduplicateTransactions(parsed, existingRows) {
  const toAdd = [];
  const duplicates = [];
  // Track what we've already added within this batch to catch same-batch dupes
  const batchSeen = [];

  for (const tx of parsed) {
    const txDate = new Date(tx.date);

    // Check against existing sheet rows
    const inSheet = existingRows.some(row => {
      if (!row[0] || !row[2]) return false;
      const rowAmt = parseFloat(row[2]);
      const rowDate = parseIndianDate(row[0]);
      if (!rowDate || isNaN(rowAmt)) return false;
      const sameAmount = Math.abs(rowAmt - tx.amount) < 0.5;
      const daysDiff = Math.abs((rowDate - txDate) / (1000 * 60 * 60 * 24));
      return sameAmount && daysDiff <= 1;
    });

    // Check against already-queued transactions in this same batch
    const inBatch = batchSeen.some(prev => {
      const prevDate = new Date(prev.date);
      const sameAmount = Math.abs(prev.amount - tx.amount) < 0.5;
      const daysDiff = Math.abs((prevDate - txDate) / (1000 * 60 * 60 * 24));
      return sameAmount && daysDiff <= 1;
    });

    if (inSheet || inBatch) {
      duplicates.push(tx);
    } else {
      toAdd.push(tx);
      batchSeen.push(tx);
    }
  }

  return { toAdd, duplicates };
}

module.exports = { parsePDFStatement, deduplicateTransactions };

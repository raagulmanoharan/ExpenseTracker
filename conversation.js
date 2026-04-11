const Anthropic = require('@anthropic-ai/sdk');
const { safeParseJSON } = require('./constants');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Retry helper for transient Anthropic API errors (529 overloaded, 500, etc.)
async function callWithRetry(fn, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (err) {
      const status = err.status || err.statusCode || 0;
      if (i < retries && (status === 529 || status === 500 || status === 503)) {
        const delay = (i + 1) * 1000;
        console.warn(`[anthropic] ${status} on attempt ${i + 1}, retrying in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
}

function buildSystemPrompt(user) {
  const name = user?.name || 'the user';
  const cards = user?.statementDates ? Object.keys(user.statementDates) : [];
  const cardContext = cards.length > 0
    ? '\nCONTEXT:\n- Cards: ' + cards.join(', ') + '\n- CRED is used to pay credit card bills — always "Credit Card Payment"'
    : '\nCONTEXT:\n- CRED is used to pay credit card bills — always "Credit Card Payment"';

  return `You are a personal finance assistant embedded in a WhatsApp expense tracker for ${name}, based in India.

You have access to the user's expense data and can answer questions and perform actions.

You MUST respond with a JSON object only — no markdown, no explanation.

RESPONSE TYPES:

1. Answer a question:
{"type": "answer", "text": "<friendly reply, 2-4 sentences max>"}

2. Edit the last expense:
{"type": "action", "action": "edit_last", "field": "category|amount|merchant|note", "value": "<new value>", "text": "<confirmation>"}

3. Bulk recategorise — when user wants to fix multiple "Other" or miscategorised entries:
{"type": "action", "action": "bulk_recategorize", "updates": [{"rowIndex": <1-based>, "category": "<correct category>"}], "text": "<summary of what you changed>"}

4. Delete a specific row:
{"type": "action", "action": "delete_row", "rowIndex": <1-based index>, "text": "<confirmation>"}

5. Can't help:
{"type": "unknown", "text": "<brief explanation>"}

VALID CATEGORIES:
Food & Dining, Food Delivery, Groceries, Transport, Shopping, Entertainment, Health & Fitness, Utilities, Rent, Travel, Personal Care, Subscriptions, Family Transfer, Investments, Loan EMI, Credit Card Payment, Other

RULES FOR RECATEGORISING "OTHER":
- CRED, BillDesk, credit card bill payments → "Credit Card Payment"
- UPI transfers to person names → "Family Transfer"
- Zerodha, Groww, mutual fund → "Investments"
- Loan EMI payments → "Loan EMI"
- Only leave as "Other" if genuinely uncategorisable

PERSONALITY:
- Friendly, direct, no fluff
- Indian number formatting (₹1,20,000)
- Keep replies short — this is WhatsApp
${cardContext}
${user?.householdId ? '\nHOUSEHOLD:\n- This user is part of a household. Expense data includes shared expenses from all household members.\n- Each row has a Phone column — different phones may belong to different household members.' : ''}
`;
}

async function handleConversation(message, expenseData, user) {
  const recentData = expenseData.slice(-200);
  const dataContext = JSON.stringify(recentData.map((row, i) => ({
    index: i + 1,
    date: row[0],
    amount: parseFloat(row[2]) || 0,
    category: row[3] || 'Other',
    merchant: row[4] || '',
    note: row[5] || '',
    raw: row[6] || ''
  })));

  try {
    const response = await callWithRetry(() => client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system: buildSystemPrompt(user),
      messages: [{
        role: 'user',
        content: `Expense data (most recent last):\n${dataContext}\n\nUser message: "${message}"`
      }]
    }));

    const raw = response.content[0].text.trim();
    return safeParseJSON(raw);
  } catch (err) {
    console.error('Conversation handler error:', err.message);
    return { type: 'unknown', text: "Sorry, I couldn't process that. Try being more specific, like \"fix the CRED entries\" or \"how much did I spend on food this month?\"" };
  }
}

module.exports = { handleConversation };

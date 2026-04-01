const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const CATEGORIES = [
  'Food & Dining', 'Food Delivery', 'Groceries', 'Transport', 'Shopping',
  'Entertainment', 'Health & Fitness', 'Utilities', 'Rent', 'Travel',
  'Personal Care', 'Subscriptions', 'Family Transfer', 'Investments', 'Loan EMI',
  'Credit Card Payment', 'Other'
];

const SYSTEM_PROMPT = `You are a smart expense parser for a WhatsApp expense tracker called Moolah, used by someone in India.
Parse messages, receipts, bank SMS screenshots and return ONLY a JSON object — no markdown, no explanation.

CATEGORIES:
${CATEGORIES.map((c, i) => `${i + 1}. ${c}`).join('\n')}

Special categories:
- "Family Transfer" — money sent to parents, relatives. UPI transfers where recipient looks like a person name (MANOHARAN R, ADITHEE S)
- "Investments" — SIPs, mutual funds, stocks, Zerodha, Groww
- "Loan EMI" — home/personal/car loan EMIs
- "Credit Card Payment" — CRED, BillDesk, bank app credit card bill payments

RESPONSE FORMAT:

Expense: {"type":"expense","amount":<number>,"category":"<cat>","merchant":"<name or null>","note":"<short note or null>","confidence":<0-100>}
Monthly summary: {"type":"summary_monthly"}
Weekly summary: {"type":"summary_weekly"}
Suggest budgets: {"type":"suggest_budgets"}
Undo: {"type":"undo"}

Salary update ("salary 26", "salary last", "salary last working day"):
{"type":"set_salary","raw":"<original text>"}

Statement date update ("statement HSBC 5", "HSBC statement 5th", "set statement amex 12"):
{"type":"set_statement","raw":"<original text>"}

Add/update card ("add card AMEX 12", "my axis statement is 18"):
{"type":"set_statement","raw":"<original text>"}

Purchase timing query ("when should I buy", "best time to use my card", "which card for big purchase"):
{"type":"purchase_timing"}

Unknown: {"type":"unknown"}

RULES:
- amount is a plain number, no Rs or commas
- confidence = your honest confidence in the category (0-100)
- For bank SMS: extract debit amount only
- Return ONLY valid JSON`;

async function parseExpense(message) {
  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 300,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: message }]
  });
  return safeParseJSON(response.content[0].text);
}

async function parseExpenseFromImage(mediaUrl, mediaType, caption) {
  const imageResponse = await axios.get(mediaUrl, {
    responseType: 'arraybuffer',
    auth: { username: process.env.TWILIO_ACCOUNT_SID, password: process.env.TWILIO_AUTH_TOKEN }
  });
  const base64Image = Buffer.from(imageResponse.data).toString('base64');
  const resolvedType = resolveMediaType(mediaType);
  const prompt = caption ? `Expense image. User note: "${caption}". Extract expense.` : 'Receipt or bank SMS. Extract the expense.';

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 300,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: resolvedType, data: base64Image } },
      { type: 'text', text: prompt }
    ]}]
  });
  return safeParseJSON(response.content[0].text);
}

function resolveMediaType(t) {
  const map = { 'image/jpg': 'image/jpeg', 'image/jpeg': 'image/jpeg', 'image/png': 'image/png', 'image/gif': 'image/gif', 'image/webp': 'image/webp' };
  return map[t] || 'image/jpeg';
}

function safeParseJSON(text) {
  try { return JSON.parse(text.trim()); }
  catch { return JSON.parse(text.trim().replace(/```json|```/g, '').trim()); }
}

module.exports = { parseExpense, parseExpenseFromImage, CATEGORIES };

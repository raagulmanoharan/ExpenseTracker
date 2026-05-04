#!/usr/bin/env node
// Smoke-test the card rewards optimizer end-to-end without touching the DB.
//
// Usage:
//   node scripts/test-card-tip.js                          # interactive REPL
//   node scripts/test-card-tip.js "2000 toit dinner"       # one-shot, parser path
//   node scripts/test-card-tip.js --raw 50000 Travel "FHR Marriott"  # skip parser
//   node scripts/test-card-tip.js --phone whatsapp:+91XXXX "..."     # use real cards
//   node scripts/test-card-tip.js --grey "..."             # allow grey-area tricks
//
// Defaults: uses a sample user with { AMEX: 18, HSBC PREMIER: 5, AXIS MAGNUS: 25 }
// Pass --phone to load YOUR profile from Supabase (read-only — no writes).

try { require('dotenv').config(); } catch (_) { /* optional in dev */ }

const readline = require('readline');
const { suggestForExpense } = require('../card-strategy');

const args = process.argv.slice(2);
const opts = { phone: null, allowGreyArea: false, raw: false };
const positional = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--phone') { opts.phone = args[++i]; continue; }
  if (a === '--grey') { opts.allowGreyArea = true; continue; }
  if (a === '--raw') { opts.raw = true; continue; }
  if (a === '-h' || a === '--help') { printHelp(); process.exit(0); }
  positional.push(a);
}

function printHelp() {
  console.log(`
Smoke-test the card rewards optimizer (no DB writes).

  node scripts/test-card-tip.js                                # REPL
  node scripts/test-card-tip.js "2000 toit dinner"             # parser path
  node scripts/test-card-tip.js --raw 50000 Travel "FHR Goa"   # skip parser
  node scripts/test-card-tip.js --phone whatsapp:+91XXXX ...   # YOUR cards
  node scripts/test-card-tip.js --grey ...                     # allow grey-area
`);
}

async function loadUser() {
  if (!opts.phone) {
    return { statementDates: { 'AMEX': 18, 'HSBC PREMIER': 5, 'AXIS MAGNUS': 25 } };
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing — cannot load --phone profile.');
    process.exit(1);
  }
  const { getUser } = require('../db');
  const u = await getUser(opts.phone);
  if (!u) {
    console.error(`No profile found for ${opts.phone}.`);
    process.exit(1);
  }
  return u;
}

function fmt(tip) {
  if (!tip) return '  💤 no card tip (no special rule fires, or upside < ₹50)';
  const grey = tip.greyArea ? '  ⚠️ grey-area' : '';
  return [
    `  💳 ${tip.bestCard} — ${tip.bestMultiplier}x`,
    tip.bestRuleNote ? `     note: ${tip.bestRuleNote}` : null,
    `     best ₹${tip.bestValueInr} · baseline ₹${tip.baselineValueInr} · upside ₹${tip.upsideInr}${grey}`,
    tip.source ? `     source: ${tip.source}` : null
  ].filter(Boolean).join('\n');
}

async function evaluate(user, expense, label) {
  const header = label ? `\n→ ${label}` : '\n→';
  console.log(header);
  console.log(`   ₹${expense.amount} · ${expense.category}${expense.merchant ? ' · ' + expense.merchant : ''}`);
  const tip = suggestForExpense(expense, user, { allowGreyArea: opts.allowGreyArea });
  console.log(fmt(tip));
}

async function evaluateMessage(user, message) {
  const { parseExpense } = require('../parser');
  let parsed;
  try { parsed = await parseExpense(message); }
  catch (e) {
    console.log('  ❌ parser failed: ' + e.message);
    return;
  }
  if (!parsed || parsed.type !== 'expense') {
    console.log(`  ⏭️  not an expense (parsed as: ${parsed?.type || 'null'}) — skipping`);
    return;
  }
  await evaluate(user, parsed, message);
}

async function runOneShot(user) {
  if (opts.raw) {
    const [amount, category, merchant] = positional;
    if (!amount || !category) {
      console.error('Usage: --raw <amount> <category> [merchant]');
      process.exit(1);
    }
    await evaluate(user, { amount: Number(amount), category, merchant: merchant || null });
    return;
  }
  await evaluateMessage(user, positional.join(' '));
}

async function runRepl(user) {
  const cards = Object.keys(user.statementDates || {});
  console.log(`Loaded user with cards: ${cards.length ? cards.join(', ') : '(none)'}`);
  console.log('Type a free-form expense message (e.g. "2000 toit dinner") or use:');
  console.log('  raw <amount> <category> [merchant]   — skip parser');
  console.log('  quit                                 — exit\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
  rl.prompt();
  rl.on('line', async (line) => {
    const t = line.trim();
    if (!t) return rl.prompt();
    if (t === 'quit' || t === 'exit') return rl.close();
    if (t.startsWith('raw ')) {
      const parts = t.slice(4).match(/(\S+)\s+(\S+(?:\s\S+)*?)(?:\s+(.+))?$/);
      if (!parts) { console.log('  raw <amount> <category> [merchant]'); return rl.prompt(); }
      await evaluate(user, { amount: Number(parts[1]), category: parts[2], merchant: parts[3] || null });
    } else {
      await evaluateMessage(user, t);
    }
    rl.prompt();
  });
  rl.on('close', () => { console.log('\nbye 👋'); process.exit(0); });
}

(async () => {
  const user = await loadUser();
  if (positional.length === 0 && !opts.raw) {
    await runRepl(user);
  } else {
    await runOneShot(user);
  }
})().catch(e => { console.error(e); process.exit(1); });

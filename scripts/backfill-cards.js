#!/usr/bin/env node
// Backfill expenses.card from raw_message for past expenses, and optionally
// remove specific test rows. Safe to run multiple times — idempotent.
//
// Usage (from Render shell or anywhere with Supabase env vars set):
//   node scripts/backfill-cards.js --phone whatsapp:+91XXXXXXXXXX
//   node scripts/backfill-cards.js --phone whatsapp:+91XXXXXXXXXX --dry-run
//   node scripts/backfill-cards.js --phone whatsapp:+91XXXXXXXXXX --remove-tests
//
// --dry-run     : print what WOULD change, no writes
// --remove-tests: also delete the 2 known test rows (₹50000 Goa flight + ₹600 swiggy biryani
//                 logged today). Matches by exact amount + raw_message phrase to avoid
//                 nuking real expenses.
//
// Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in env.

try { require('dotenv').config(); } catch (_) {}

const { createClient } = require('@supabase/supabase-js');
const { extractCardHint } = require('../card-strategy');

const args = process.argv.slice(2);
const opts = { phone: null, dryRun: false, removeTests: false };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--phone') opts.phone = args[++i];
  else if (a === '--dry-run') opts.dryRun = true;
  else if (a === '--remove-tests') opts.removeTests = true;
  else if (a === '-h' || a === '--help') { printHelp(); process.exit(0); }
}

function printHelp() {
  console.log(`
Backfill expenses.card from raw_message.

  --phone <whatsapp:+91XXXX>   required
  --dry-run                    don't write, just print changes
  --remove-tests               also delete the 2 known test expenses
`);
}

if (!opts.phone) {
  console.error('--phone is required');
  process.exit(1);
}
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required in env');
  process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

(async () => {
  // 1. Load user profile so extractCardHint knows the alias set.
  const { data: user, error: userErr } = await supabase
    .from('users')
    .select('phone, statement_dates')
    .eq('phone', opts.phone)
    .single();
  if (userErr || !user) {
    console.error('User not found:', userErr?.message || 'no row');
    process.exit(1);
  }
  const userObj = { statementDates: user.statement_dates || {} };
  console.log('Cards on file:', Object.keys(userObj.statementDates).join(', ') || '(none)');

  // 2. Optional: remove the two known test rows.
  if (opts.removeTests) {
    console.log('\n--- Removing test entries ---');
    const candidates = await findTestRows(opts.phone);
    if (candidates.length === 0) {
      console.log('No matching test rows found.');
    } else {
      for (const row of candidates) {
        console.log(`  ${opts.dryRun ? 'WOULD DELETE' : 'DELETING'} ${row.id}: ₹${row.amount} ${row.category} "${row.raw_message?.slice(0, 60)}..."`);
        if (!opts.dryRun) {
          const { error } = await supabase.from('expenses').delete().eq('id', row.id);
          if (error) console.error('   delete failed:', error.message);
        }
      }
    }
  }

  // 3. Backfill card column for rows where it's NULL.
  console.log('\n--- Backfilling expenses.card ---');
  const { data: rows, error: rowsErr } = await supabase
    .from('expenses')
    .select('id, amount, category, merchant, raw_message, card')
    .eq('phone', opts.phone)
    .is('card', null)
    .not('raw_message', 'is', null);
  if (rowsErr) {
    console.error('Failed to fetch rows:', rowsErr.message);
    process.exit(1);
  }
  console.log(`${rows.length} rows with NULL card and non-null raw_message`);

  let updated = 0;
  let skipped = 0;
  const tagCounts = {};
  for (const row of rows) {
    const hint = extractCardHint(row.raw_message, userObj);
    if (!hint) { skipped++; continue; }
    tagCounts[hint] = (tagCounts[hint] || 0) + 1;
    if (opts.dryRun) {
      updated++;
      continue;
    }
    const { error } = await supabase.from('expenses').update({ card: hint }).eq('id', row.id);
    if (error) {
      console.error(`  failed to update ${row.id}: ${error.message}`);
    } else {
      updated++;
    }
  }
  console.log(`\n${opts.dryRun ? '[dry run] Would update' : 'Updated'} ${updated} rows · skipped ${skipped} (no card alias matched)`);
  if (Object.keys(tagCounts).length) {
    console.log('Distribution:');
    for (const [card, n] of Object.entries(tagCounts).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${card}: ${n}`);
    }
  }
})().catch(e => { console.error(e); process.exit(1); });

async function findTestRows(phone) {
  // Match conservatively: today's date, exact amount, raw message phrase.
  const today = new Date().toISOString().split('T')[0];
  const { data, error } = await supabase
    .from('expenses')
    .select('id, amount, category, raw_message')
    .eq('phone', phone)
    .eq('date', today);
  if (error) {
    console.error('  scan failed:', error.message);
    return [];
  }
  return (data || []).filter(r => {
    const raw = (r.raw_message || '').toLowerCase();
    if (Number(r.amount) === 50000 && raw.includes('flight to goa')) return true;
    if (Number(r.amount) === 600 && raw.includes('swiggy biryani')) return true;
    return false;
  });
}

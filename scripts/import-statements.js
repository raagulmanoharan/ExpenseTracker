#!/usr/bin/env node
// Bulk import credit-card statement PDFs from local ./Statements/ or the
// Supabase Storage bucket cc-statements. Parses each PDF, reconciles its
// transactions against existing expenses, and prints a per-statement summary.
//
// Usage:
//   node scripts/import-statements.js --source local --phone whatsapp:+91XXXX
//   node scripts/import-statements.js --source supabase --phone whatsapp:+91XXXX
//   node scripts/import-statements.js --source supabase --phone whatsapp:+91XXXX --dry-run
//   node scripts/import-statements.js --source local --phone whatsapp:+91XXXX --file Statements/amex_jan.pdf
//
// Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY + ANTHROPIC_API_KEY in env.
//
// Idempotent: re-importing the same statement (same phone+card+period) reuses
// the existing cc_statements row and re-runs reconciliation.

try { require('dotenv').config(); } catch (_) {}

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { parseCcStatement } = require('../cc-statement-parser');
const { reconcile } = require('../cc-statement-reconciler');

const args = process.argv.slice(2);
const opts = { source: 'local', phone: null, dryRun: false, file: null };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--source') opts.source = args[++i];
  else if (a === '--phone') opts.phone = args[++i];
  else if (a === '--dry-run') opts.dryRun = true;
  else if (a === '--file') opts.file = args[++i];
  else if (a === '-h' || a === '--help') { printHelp(); process.exit(0); }
}

function printHelp() {
  console.log(`
Bulk import CC statements.

  --source local|supabase    where to read PDFs from (default: local)
  --phone <whatsapp:+91XXX>  required
  --file <path>              optional, process a single file
  --dry-run                  parse + reconcile but don't write
`);
}

if (!opts.phone) { console.error('--phone is required'); process.exit(1); }

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const dbHelpers = {
  listExpensesInRange: async (phone, from, to) => {
    const { data, error } = await supabase
      .from('expenses')
      .select('id, date, amount, card, statement_id, merchant, category, note, raw_message')
      .eq('phone', phone).gte('date', from).lte('date', to);
    if (error) throw error;
    return data || [];
  },
  updateExpense: async (id, patch) => {
    const { error } = await supabase.from('expenses').update(patch).eq('id', id);
    if (error) throw error;
  },
  insertExpense: async (row) => {
    const { data, error } = await supabase.from('expenses').insert(row).select('id').single();
    if (error) throw error;
    return data;
  },
  insertCcStatement: async (row) => {
    const existing = await supabase
      .from('cc_statements').select('id')
      .eq('phone', row.phone).eq('card', row.card)
      .eq('period_start', row.period_start).eq('period_end', row.period_end)
      .maybeSingle();
    if (existing.data) return existing.data;
    const { data, error } = await supabase.from('cc_statements').insert(row).select('id').single();
    if (error) throw error;
    return data;
  },
  updateCcStatement: async (id, patch) => {
    const { error } = await supabase.from('cc_statements').update(patch).eq('id', id);
    if (error) throw error;
  }
};

async function loadUser(phone) {
  const { data, error } = await supabase
    .from('users').select('phone, statement_dates, salary_type, salary_day')
    .eq('phone', phone).single();
  if (error) throw new Error('loadUser: ' + error.message);
  return { statementDates: data.statement_dates || {}, salaryType: data.salary_type, salaryDay: data.salary_day };
}

async function listLocalPdfs(filter) {
  const dir = path.join(__dirname, '..', 'Statements');
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir)
    .filter(f => /\.pdf$/i.test(f))
    .map(f => ({ name: f, path: path.join(dir, f) }));
  if (filter) return files.filter(f => f.path.endsWith(filter) || f.name === path.basename(filter));
  return files;
}

async function listSupabasePdfs() {
  const { data, error } = await supabase.storage.from('cc-statements').list(opts.phone, {
    limit: 100, sortBy: { column: 'created_at', order: 'desc' }
  });
  if (error) throw new Error('list bucket: ' + error.message);
  return (data || []).filter(o => /\.pdf$/i.test(o.name));
}

async function readSupabasePdf(name) {
  const fullPath = `${opts.phone}/${name}`;
  const { data, error } = await supabase.storage.from('cc-statements').download(fullPath);
  if (error) throw new Error('download: ' + error.message);
  return Buffer.from(await data.arrayBuffer());
}

async function importOne({ pdfBuffer, sourcePath }, user) {
  console.log(`\n→ ${sourcePath}`);
  const parsed = await parseCcStatement({ pdfBuffer }, user);
  console.log(`   card: ${parsed.card || '?'} → resolved to ${parsed.cardUserKey || 'UNRESOLVED'}`);
  console.log(`   period: ${parsed.periodStart} → ${parsed.periodEnd}`);
  console.log(`   transactions: ${parsed.transactions?.length || 0} (totalSpend ₹${parsed.totalSpend || '?'})`);

  if (!parsed.cardUserKey) {
    console.log(`   ⚠️ Couldn't map "${parsed.card}" to your registered cards. Register it first via WhatsApp:`);
    console.log(`      statement <card name> <day>`);
    return;
  }

  const result = await reconcile(parsed, opts.phone, dbHelpers, {
    dryRun: opts.dryRun, source: opts.source, sourcePath
  });
  const s = result.summary;
  console.log(`   ${opts.dryRun ? '[dry] ' : ''}tagged: ${s.tagged} · dateFixed: ${s.dateFixed} · newRows: ${s.newRows} · refunds: ${s.refunds} · conflicts: ${s.conflicts}`);
  if (s.conflicts > 0 && result.log.conflicts.length) {
    for (const c of result.log.conflicts.slice(0, 5)) {
      console.log(`     ⚠️ ${c.reason}: ${c.txn?.date} ₹${c.txn?.amount} ${c.txn?.merchant || ''}`);
    }
    if (result.log.conflicts.length > 5) console.log(`     ... and ${result.log.conflicts.length - 5} more`);
  }
}

(async () => {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required');
    process.exit(1);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY required (statements parsed via Claude vision)');
    process.exit(1);
  }

  const user = await loadUser(opts.phone);
  console.log(`User: ${opts.phone} · cards on file: ${Object.keys(user.statementDates).join(', ') || '(none)'}`);

  let queue = [];
  if (opts.source === 'local') {
    const items = await listLocalPdfs(opts.file);
    queue = items.map(it => async () => importOne({
      pdfBuffer: fs.readFileSync(it.path),
      sourcePath: `local:${it.name}`
    }, user));
    console.log(`Found ${items.length} local PDF(s) in ./Statements/`);
  } else if (opts.source === 'supabase') {
    const items = await listSupabasePdfs();
    queue = items.map(it => async () => importOne({
      pdfBuffer: await readSupabasePdf(it.name),
      sourcePath: `supabase:${opts.phone}/${it.name}`
    }, user));
    console.log(`Found ${items.length} PDF(s) in cc-statements/${opts.phone}/`);
  } else {
    console.error('--source must be local or supabase');
    process.exit(1);
  }

  for (const job of queue) {
    try { await job(); }
    catch (e) { console.error('   ✖ ' + (e.message || e)); }
  }

  console.log('\nDone.');
})().catch(e => { console.error(e); process.exit(1); });

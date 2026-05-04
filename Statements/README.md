# Drop credit card statement PDFs here for import.
#
# This is a LOCAL workspace — PDFs in this folder are gitignored so your
# financial data never leaves your machine via git. For a remote workflow,
# upload to the Supabase Storage bucket `cc-statements` instead.
#
# Run the importer:
#   node scripts/import-statements.js --source local --phone whatsapp:+91XXXX
#
# Or pull from Supabase:
#   node scripts/import-statements.js --source supabase --phone whatsapp:+91XXXX
#
# See CLAUDE.md ("CC statement import") for the full reconciliation flow.

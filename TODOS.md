# TODOS

## P2 — Notification Budget / DND Mode
**What:** Cap proactive messages at 2/day (outside direct replies). Add "quiet mode" and "notifications off" WhatsApp commands.
**Why:** 8 cron jobs can send 5+ messages daily — that's alert fatigue, not coaching. Users will mute the bot entirely.
**Effort:** S (human: ~1 day / CC: ~15 min)
**Depends on:** Nothing
**Context:** Daily nudge, overspend check, smart nudge, evening check-in, morning follow-up, lapse nudge, pre-statement nudge all fire independently. Need a central notification tracker that enforces a daily cap and respects quiet hours.

## P2 — Sheets API Caching Layer
**What:** Cache user data and category rules in-memory for 5 minutes. Write-through on updates.
**Why:** Phase 2 features add 3-4 more Sheets reads per webhook (streak, CategoryRules, daily limit). Without caching, total API calls per webhook could hit 15-20. Google Sheets allows 300 req/min — fine for 1 user but no headroom.
**Effort:** S (human: ~1 day / CC: ~15 min)
**Depends on:** Phase 2 feature rollout
**Context:** Currently ~10 API calls per webhook. Each call takes ~200-2000ms. Caching user profile and category rules cuts reads by ~50%.

## P3 — Database Migration (when user count > 5)
**What:** Migrate from Google Sheets to a real database (SQLite/Postgres). Add proper transactions, indexing, and concurrent write safety.
**Why:** Google Sheets has no ACID transactions. Concurrent appends from multiple server instances can create duplicate entries. getAllRows() fetches the entire sheet into memory on every call, becoming a multi-second operation at 50K+ rows. Google Sheets API has a 60 req/min/user quota.
**Effort:** L (human: ~2 weeks / CC: ~2 hours)
**Depends on:** User count exceeding ~5 active users, or expense rows exceeding ~10K
**Context:** Currently single-instance on Render free tier. Phase 2 features (recurring detection, month-over-month comparison) require increasingly complex queries over growing data. Google Sheets makes every query O(n) over full history with no indexing. Promise chain per user serializes within one process but doesn't help across multiple instances.

## P3 — PDF Parsing Cost Controls
**What:** Add page limit or cost estimation before parsing large bank statements. Consider truncating PDFs > 20 pages or showing estimated API cost before proceeding.
**Why:** A 50-page bank statement sent to Claude can cost $1-5 per parse (input tokens for base64 PDF). No guardrails exist. One careless PDF upload could cost more than a month of normal usage.
**Effort:** S (human: ~1 day / CC: ~15 min)
**Depends on:** Nothing
**Context:** Current parsePDFStatement sends the full base64 PDF with max_tokens: 4000. Most statements are <10 pages (~$0.50), but there's no enforcement. Could show "This PDF is X pages, estimated cost ~$Y. Proceed?" or silently truncate beyond 20 pages.

## P3 — CSV/PDF Export for Tax Season
**What:** "export march" or "export FY2025" generates a downloadable expense summary.
**Why:** Once-a-year use case but critical during tax filing. Users need structured data for CA/tax software.
**Effort:** S (human: ~1 day / CC: ~15 min)
**Depends on:** Nothing
**Context:** Data already exists in Google Sheets — can generate CSV directly from Sheets API. Challenge is delivery via WhatsApp (file size limits, format). Could email instead.

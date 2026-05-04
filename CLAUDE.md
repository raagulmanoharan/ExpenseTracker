# Budgy (ExpenseTracker)

WhatsApp expense tracker using Twilio + Claude AI + Supabase.

## Architecture

### How it works
Users send WhatsApp messages (text, photos, PDFs) to a Twilio number. The Express
webhook at `/webhook` receives them, parses expenses via Claude AI, and stores data
in Supabase PostgreSQL. Scheduled nudges remind users to log and provide spending insights.

**Message flow**: Every message goes through Claude first (parser.js). Claude classifies
the intent (expense, summary, undo, salary, statement, purchase timing, or unknown).
Unknown intent falls through to the conversational handler (conversation.js) where Claude
reads the user's expense data and answers naturally. All user-facing responses are
composed by Claude via `composeResponse()` (responder.js) with static fallbacks.

No multi-turn state machines for settings. If the user wants to set salary, they say
"salary 26" — one shot. No forced prompts. No trapping.

### File map
| File | Purpose |
|------|---------|
| `server.js` | Express webhook handler. Twilio signature validation, onboarding flow, PDF/image/text routing, all user-facing commands (summary, undo, budgets, purchase timing). |
| `scheduler.js` | **Heartbeat engine.** Single cron (`*/30 * * * *`). 9 nudge types, each with `cadenceHours`, IST time window, priority, and async `check()`. State persists to `.heartbeat-state.json`. |
| `db.js` | Supabase data layer. CRUD, summaries, cycle analysis, household queries, **spending insights** (materialized view queries). Uses `rowToArray()` for backward compat with summary helpers. |
| `utils.js` | Pure computation functions: salary cycle bounds, summary helpers, input parsing, session window, household ID generation. No DB access. |
| `responder.js` | Claude response composer (Haiku). All user-facing messages go through `composeResponse(actionType, context, user)` with static fallbacks on failure. Includes progressive setup prompts. |
| `anthropic-client.js` | Shared Anthropic client + retry logic. Used by parser, conversation, pdf-parser, responder. |
| `messaging.js` | Singleton Twilio client. All WhatsApp sends go through `sendWhatsAppTo` / `sendWhatsAppBroadcast`. |
| `conversation.js` | Claude AI conversational handler. Grounded in **compact spending insights** (materialized views) instead of raw rows. Falls back to raw rows when views unavailable. Handles edit/delete/recategorize actions. |
| `parser.js` | Claude AI intent classifier + expense parser. Text -> structured intent (expense, summary, salary, statement, purchase timing, unknown). Includes prompt injection guardrails. |
| `pdf-parser.js` | Bank statement PDF parser via Claude vision. Deduplicates against existing rows before import. |
| `insights.js` | **Spending insights engine.** Tier 2: weekly narrative generation via Claude Haiku + Voyage AI embeddings stored in pgvector for semantic search. Tier 3: graphology spending graph with Louvain community detection + degree centrality. Called by scheduler (daily) and conversation fallback (search). |
| `card-strategy.js` | **Credit-card rewards optimizer.** `suggestForExpense({amount, category, merchant}, user)` returns the best owned card + multiplier + INR upside, or null when no special rule fires / upside is below threshold. Reads `card-strategies.json`. Called from server.js after every logged expense. |
| `card-strategies.json` | Per-card knowledge base: aliases, base earn, category multipliers, voucher tricks, milestones, exclusions, transfer partners. Each trick cited (TechnoFino, CardExpert, LiveFromALounge, Reddit). Update this file (not the engine) when issuers devalue or new tricks emerge. |
| `constants.js` | Shared: CATEGORIES, BASE_CATEGORIES, `getVisibleCategories()`, `isCommitted()`, `isSharedCategory()`, `parseIndianDate()`, `safeParseJSON()`, `getCategoryEmoji()`. |

### Heartbeat nudge system
The heartbeat ticks every 30 minutes. On each tick:
1. **Broadcast checks** run first (overspend alert, Friday digest) — computed per household group, sent to each member
2. **Per-user checks** — for each user, the single most overdue nudge (scored by `overdueHours * priority`) is evaluated. Only one nudge fires per user per tick.
3. Checks return a message string (send it) or null (not actionable, mark as checked).
4. State (`nudgeId:phone -> lastSentTimestamp`) persists to `.heartbeat-state.json`.

9 nudge types: `smart_nudge` (projection-based spending insight, priority 10), `pre_statement` (CC timing advice, 9), `overspend_alert` (baseline comparison, 9), `morning_followup` (yesterday blank, 8), `lapse_nudge` (3 days silent, 7), `evening_checkin` (today blank, 5), `daily_nudge` (generic reminder, 3, **skips if user logged today**), `friday_digest` (weekly summary + chart, 10, Friday only), `household_discovery` (suggest household feature, 2, after 2+ weeks solo usage).

### Key patterns
- **Claude routes everything**: parser.js classifies intent, conversation.js handles data questions. No regex-based routing. Regex is only used for structured extraction AFTER Claude has classified the intent.
- **Salary cycle bounds**: Configurable per user (fixed day, last day, last working day). Summary functions (`getMonthlySummary`, `getBudgetStatus`, `getCyclePaceAnalysis`) fetch user config from DB and pass to `getSalaryCycleBounds()`. Falls back to `PAY_DATES_2026` when no config set.
- **Progressive setup (non-blocking)**: After 3rd expense, Budgy asks about credit cards (yes/no). After CC setup or 5th expense, asks about salary date. These are woven into expense confirmations, never blocking. `pendingSetup` Map tracks soft state, auto-expires after 1h. `setupHintsSent` prevents re-asking.
- **Prompt injection guardrails**: parser.js and conversation.js treat user messages as DATA, not INSTRUCTIONS. Injection attempts return graceful deflections.
- **composeResponse for everything**: All user-facing messages go through `responder.js`. Claude Haiku composes contextual replies. Static fallbacks on failure.
- **Projection-based pace analysis**: `dailyRate * totalCycleDays = projectedTotal`. Comparison requires 3+ categories and Rs.2000+ in previous cycle.
- **Response-sent guard**: `sendResponse()` in webhook prevents double TwiML sends on async paths (PDF processing, chart sending).
- **Onboarding**: New users get name prompt -> profile creation. Existing users without profiles get silent auto-creation.

### Card rewards optimizer
After every logged expense, `card-strategy.js` evaluates the user's owned cards against a static knowledge base (`card-strategies.json`) and may append a one-line forward-looking tip ("next time use *X* at 5x → ~₹Y more").

- **Auto-suggest, opportunity-only**: only fires when (a) the category has a known multiplier on at least one owned card, (b) `upsideInr ≥ 50` vs the best owned card's vanilla base earn. Otherwise silent.
- **Forward-looking framing**: tip is always "next time", never "you should have", because Budgy can't always determine which card was used.
- **Card-per-expense tracking**: `expenses.card` (nullable TEXT) stores the card name when extractable from the user's message. `extractCardHint(message, user)` regex-matches owned-card aliases. Empty when not specified — no prompt-on-every-expense friction.
- **Cap-aware scoring**: each rule supports `capPerMonth` + `capType`. `limit` (default) — multiplier applies up to cap, base above. `threshold` (e.g. Magnus 17.5x) — multiplier only applies on spend ABOVE the cap. Engine fetches per-card MTD via `db.getMonthlySpendByCard` (current salary cycle) and prorates accordingly. Without MTD data, threshold rules are conservatively held off (no false 17.5x on a Rs.2k dinner).
- **Card matching**: KB cards have `aliases[]` (uppercased, normalized). Engine matches them against `user.statementDates` keys with substring containment in either direction. Edit aliases when a new variant slips through.
- **Grey-area gating**: voucher tricks flagged `greyArea: true` (rent loops, MCC abuse) are off by default. Pass `{ allowGreyArea: true }` to opt in (no UI toggle yet).
- **Updating the KB**: edit `card-strategies.json` directly. Every multiplier, exclusion, and trick cites a source — add the source URL alongside any new entry. Issuer devaluations are the main reason this file ages; check TechnoFino + LiveFromALounge before changing numbers.
- **Smoke testing**: `npm run test:card-tip` for an interactive REPL or one-shot evaluation. Use `--phone whatsapp:+91XXXX` to load real cards + real MTD from Supabase without writing anything.
- **Tests**: `test/card-strategy.test.js` covers fixture-based routing, cap-aware scoring (threshold + limit), `extractCardHint`, grey-area gating, and a real-KB smoke test.

### Household system
Two or more users can form a household via share codes. Each user messages Budgy 1:1, but summaries and nudges reflect combined household spending for shared categories.

- **HouseholdId**: Short code (e.g. `hh_a7k3`) stored on each member's user profile.
- **SharedCategories**: JSON array on each member. Categories in this list are shared; others are personal.
- **Cross-notifications**: When a member logs a shared-category expense, other members receive a notification.
- **Summaries**: Show all your own expenses + other members' shared-category expenses.
- **Commands**: `create household`, `join <code>`, `leave household`, `my household`, `add shared: <category>`, `remove shared: <category>`, `set shared categories`.
- **Helper functions**: `getHouseholdRows(phone)` fetches the right rows; `getHouseholdMembers(phone)` returns member objects.

### Spending insights (knowledge graph foundation)
Materialized views pre-compute spending patterns for grounded AI conversations. Instead of
sending 200 raw rows (~20K tokens) to Claude, `getSpendingContext()` returns compact
insights (~500-800 tokens): category profiles, merchant patterns, day-of-week behaviour,
and cycle trends. `conversation.js` uses these when available, falls back to raw rows.

- **mv_category_profiles**: 90-day spending per category (total, avg, top merchant, frequency)
- **mv_merchant_profiles**: top merchants by spend (visit count, avg spend)
- **mv_dow_patterns**: spending patterns by day of week
- **mv_cycle_trends**: month-over-month category totals for trend detection
- **Refresh**: `refresh_spending_insights()` function, schedule via pg_cron every 6h
- **spending_narratives**: pgvector-enabled table storing embedded weekly summaries + graph insights. `match_narratives()` RPC for vector similarity search.
- **Narrative pipeline**: `insights.js` generates weekly narratives via Claude Haiku, embeds via Voyage AI `voyage-finance-2` (1024 dims), stores in pgvector. Semantic search retrieves relevant narratives for conversation grounding.
- **Graph analysis**: `graphology` builds in-memory spending graph (merchant/category/day-of-week nodes), runs Louvain community detection + degree centrality to discover spending clusters and patterns.
- **Scheduler integration**: Heartbeat generates insights daily per user (fire-and-forget, `_insights` state key). Conversations fetch narratives via `searchNarratives()` in parallel with materialized view context.
- **getHouseholdRows**: Uses SQL `IN` filtering (phone + category) instead of JS filter. No more full-table scan.

### Data model (Supabase PostgreSQL)
- **expenses**: id (UUID), phone (FK), date, time, amount, category, merchant, note, raw_message, created_at
- **users**: phone (PK), name, salary_type, salary_day, cards (JSONB), statement_dates (JSONB), joined, expense_count, last_message_at, household_id, shared_categories (JSONB)
- **budgets**: phone (FK), category, monthly_budget (UNIQUE per phone+category)
- **spending_narratives**: id (UUID), phone (FK), narrative_type, period_start, period_end, content, embedding (vector(1024)), metadata (JSONB), created_at, updated_at

### Environment variables
`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM`, `ANTHROPIC_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `WEBHOOK_URL` (optional, for signature validation), `PORT` (default 3000), `VOYAGE_API_KEY` (optional, for spending narrative embeddings — falls back to date-based retrieval without it).

### Testing
Run: `npm test` (jest --forceExit). Tests across 5 suites.
- `test/constants.test.js` — utility functions
- `test/utils.test.js` — salary parsing, cycle bounds, billing advice, statement input rejection
- `test/dedup.test.js` — PDF transaction deduplication
- `test/heartbeat.test.js` — nudge registry, overdue scoring, state persistence
- `test/household.test.js` — household helpers (isSharedCategory, generateHouseholdId)
- `test/card-strategy.test.js` — card rewards engine (alias matching, multiplier routing, noise control, grey-area gating, real-KB smoke)

### Git repo
https://github.com/raagulmanoharan/ExpenseTracker

## Skill routing

When the user's request matches an available skill, ALWAYS invoke it using the Skill
tool as your FIRST action. Do NOT answer directly, do NOT use other tools first.
The skill has specialized workflows that produce better results than ad-hoc answers.

Key routing rules:
- Product ideas, "is this worth building", brainstorming → invoke office-hours
- Bugs, errors, "why is this broken", 500 errors → invoke investigate
- Ship, deploy, push, create PR → invoke ship
- QA, test the site, find bugs → invoke qa
- Code review, check my diff → invoke review
- Update docs after shipping → invoke document-release
- Weekly retro → invoke retro
- Design system, brand → invoke design-consultation
- Visual audit, design polish → invoke design-review
- Architecture review → invoke plan-eng-review
- Save progress, checkpoint, resume → invoke checkpoint
- Code quality, health check → invoke health

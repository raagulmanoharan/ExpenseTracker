# Budgy (ExpenseTracker)

WhatsApp expense tracker using Twilio + Claude AI + Google Sheets.

## Architecture

### How it works
Users send WhatsApp messages (text, photos, PDFs) to a Twilio number. The Express
webhook at `/webhook` receives them, parses expenses via Claude AI, and stores rows
in Google Sheets. Scheduled nudges remind users to log and provide spending insights.

### File map
| File | Purpose |
|------|---------|
| `server.js` | Express webhook handler. Twilio signature validation, onboarding flow, PDF/image/text routing, all user-facing commands (summary, undo, budgets, purchase timing). |
| `scheduler.js` | **Heartbeat engine.** Single cron (`*/30 * * * *`) replaces 8 independent jobs. Each nudge is a declarative config with `cadenceHours`, IST time window, priority, and async `check()`. State persists to `.heartbeat-state.json`. |
| `sheets.js` | Google Sheets CRUD. Auth singleton, row cache (5s TTL), salary cycle computation (`computeUserCycleBounds`), projection-based pace analysis (`getCyclePaceAnalysis`), user profiles (Users tab), budgets (Budgets tab). All expense rows have a Phone column for multi-user isolation. |
| `messaging.js` | Singleton Twilio client. All WhatsApp sends go through `sendWhatsAppTo` / `sendWhatsAppBroadcast`. |
| `conversation.js` | Claude AI conversational fallback. Builds dynamic system prompt from user profile (name, card dates). Handles questions about spending data. |
| `parser.js` | Claude AI expense parser. Text -> `{amount, category, merchant, note, confidence}`. Low confidence triggers category picker. |
| `pdf-parser.js` | Bank statement PDF parser via Claude vision. Deduplicates against existing rows before import. |
| `constants.js` | Shared: CATEGORIES, COMMITTED_CATEGORIES, `isCommitted()`, `parseIndianDate()`, `safeParseJSON()`, `getCategoryEmoji()`. |

### Heartbeat nudge system
The heartbeat ticks every 30 minutes. On each tick:
1. **Broadcast checks** run first (overspend alert, Friday digest) — sent once to all users
2. **Per-user checks** — for each user, the single most overdue nudge (scored by `overdueHours * priority`) is evaluated. Only one nudge fires per user per tick.
3. Checks return a message string (send it) or null (not actionable, mark as checked).
4. State (`nudgeId:phone -> lastSentTimestamp`) persists to `.heartbeat-state.json`.

8 nudge types: `smart_nudge` (projection-based spending insight, priority 10), `pre_statement` (CC timing advice, 9), `overspend_alert` (baseline comparison, 9), `morning_followup` (yesterday blank, 8), `lapse_nudge` (3 days silent, 7), `evening_checkin` (today blank, 5), `daily_nudge` (generic reminder, 3), `friday_digest` (weekly summary + chart, 10, Friday only).

### Key patterns
- **Salary cycle bounds**: Configurable per user (fixed day, last day, last working day). Falls back to hardcoded `PAY_DATES_2026` array.
- **Projection-based pace analysis**: `dailyRate * totalCycleDays = projectedTotal`. Comparison requires 3+ categories and Rs.2000+ in previous cycle.
- **Response-sent guard**: `sendResponse()` in webhook prevents double TwiML sends on async paths (PDF processing, chart sending).
- **Row cache**: `getAllRows()` caches for 5 seconds, invalidated on writes. Phone-filtered when called with a phone param.
- **Onboarding**: New users get name prompt -> profile creation. Existing users without profiles get silent auto-creation.

### Data model (Google Sheets)
- **Expenses tab**: Date, Time, Amount, Category, Merchant, Note, Raw Message, Phone (A:H)
- **Users tab**: Phone, Name, SalaryType, SalaryDay, StatementDates (JSON), ExpenseCount, CreatedAt
- **Budgets tab**: Category, Monthly Budget

### Environment variables
`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM`, `ANTHROPIC_API_KEY`, `GOOGLE_SHEET_ID`, `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_PRIVATE_KEY`, `WEBHOOK_URL` (optional, for signature validation), `PORT` (default 3000).

### Testing
Run: `npm test` (jest --forceExit). 69 tests across 4 suites.
- `test/constants.test.js` — utility functions
- `test/sheets-pure.test.js` — salary parsing, cycle bounds, billing advice
- `test/dedup.test.js` — PDF transaction deduplication
- `test/heartbeat.test.js` — nudge registry, overdue scoring, state persistence

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

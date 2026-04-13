require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const { CATEGORIES, getCategoryEmoji, getMonthName, getVisibleCategories } = require('./constants');
const { parseExpense, parseExpenseFromImage } = require('./parser');
const { parsePDFStatement, deduplicateTransactions } = require('./pdf-parser');
const {
  initSheet, appendExpense, batchAppendExpenses, getAllRows,
  getMonthlySummary, getWeeklySummary, getOverspendAlerts,
  getBudgets, suggestBudgets, getBudgetStatus,
  checkAnomaly, undoLast, buildDiscretionarySplit, editLastExpense, deleteExpenseById, bulkRecategorize,
  initUsersSheet, getUser, createUser, updateUser, incrementExpenseCount,
  updateLastMessageAt,
  parseSalaryInput, parseStatementInput, getBillingCycleAdvice,
  getHouseholdRows, getHouseholdMembers, createHousehold, joinHousehold, leaveHousehold, updateSharedCategories,
  getRecentExpensesWithIds, getExpensesForExport,
  getSpendingContext
} = require('./db');
const { scheduleHeartbeat, buildWeeklyDigest } = require('./scheduler');
const { sendWhatsAppTo, sendWhatsAppImageTo, sendWhatsAppInteractive } = require('./messaging');
const { handleConversation } = require('./conversation');
const { composeResponse } = require('./responder');
const { searchNarratives } = require('./insights');

const app = express();
app.use(express.urlencoded({ extended: false, verify: (req, res, buf) => { req.rawBody = buf.toString(); } }));
app.use(express.json());

const MessagingResponse = twilio.twiml.MessagingResponse;

// ─── State ────────────────────────────────────────────────────────────────────
const pendingCategory = new Map(); // low-confidence expense awaiting category pick
const pendingImport = new Map();   // PDF transactions awaiting confirmation
const pendingOnboarding = new Map(); // new users being onboarded
const pendingHouseholdSetup = new Map(); // awaiting shared category selection
const pendingSharedCategoryReset = new Map(); // awaiting full shared category reset
const pendingSetup = new Map();    // progressive CC/salary setup: { stage, askedAt }
const setupHintsSent = new Map();  // phone → Set('cc', 'salary') — tracks what's been asked

// ─── Health ───────────────────────────────────────────────────────────────────
const startedAt = new Date();
app.get('/health', (req, res) => {
  const mem = process.memoryUsage();
  res.json({
    status: 'ok',
    time: new Date().toISOString(),
    uptime: Math.round(process.uptime()) + 's',
    started: startedAt.toISOString(),
    memory: {
      rss: Math.round(mem.rss / 1024 / 1024) + 'MB',
      heap: Math.round(mem.heapUsed / 1024 / 1024) + '/' + Math.round(mem.heapTotal / 1024 / 1024) + 'MB'
    },
    node: process.version
  });
});

// ─── Twilio signature validation ─────────────────────────────────────────────
function validateTwilioSignature(req, res, next) {
  if (process.env.NODE_ENV === 'test') return next();
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) return next(); // skip if not configured
  const signature = req.headers['x-twilio-signature'] || '';
  const url = (process.env.WEBHOOK_URL || `${req.protocol}://${req.get('host')}`) + req.originalUrl;
  const valid = twilio.validateRequest(authToken, signature, url, req.body);
  if (!valid) {
    console.warn(`[${new Date().toISOString()}] [WARN] [twilio] Invalid signature from ${req.ip}`);
    return res.status(403).end();
  }
  next();
}

// ─── Webhook ──────────────────────────────────────────────────────────────────
app.post('/webhook', validateTwilioSignature, async (req, res) => {
  const twiml = new MessagingResponse();
  const rawMsg = (req.body.Body || '').trim();
  const incomingMsg = rawMsg.length > 2000 ? rawMsg.substring(0, 2000) : rawMsg;
  const from = req.body.From || 'unknown';
  const numMedia = parseInt(req.body.NumMedia || '0');
  const mediaUrl = req.body.MediaUrl0;
  const mediaType = (req.body.MediaContentType0 || '').toLowerCase();
  const buttonPayload = (req.body.ButtonPayload || '').trim();
  const buttonText = (req.body.ButtonText || '').trim();
  const lower = incomingMsg.toLowerCase().trim();
  let responseSent = false;

  function sendResponse() {
    if (responseSent) return;
    responseSent = true;
    res.type('text/xml').send(twiml.toString());
  }

  console.log(`[${new Date().toISOString()}] ${from} | ${mediaType || 'text'} | "${incomingMsg.substring(0, 100)}"`);

  let user = null;
  try {

    // ── 0. New user detection — onboarding ────────────────────────────────
    user = await getUser(from);

    // Track last message time for WhatsApp 24h session window
    if (user) {
      updateLastMessageAt(from).catch(err =>
        console.error('[webhook] Failed to update LastMessageAt:', err.message)
      );
    }

    if (!user) {
      // Check if they already have expense data (existing user, just no profile yet)
      const existingRows = await getAllRows(from);
      if (existingRows.length > 0) {
        // Silently create profile — they're already using the app
        await createUser(from, 'User');
        user = await getUser(from);
        // Fall through to normal handling
      } else if (pendingOnboarding.has(from)) {
        const name = incomingMsg.trim();
        if (name.length > 0 && name.length < 50) {
          await createUser(from, name);
          pendingOnboarding.delete(from);
          const welcome = await composeResponse('onboarding_name_received', { name }, null);
          twiml.message(welcome);
        } else {
          twiml.message("What's your name? (just your first name is fine)");
        }
        return sendResponse();
      } else {
        pendingOnboarding.set(from, true);
        const greeting = await composeResponse('onboarding_welcome', {}, null);
        twiml.message(greeting);
        return sendResponse();
      }
    }

    // ── 0b. Household setup — shared category selection + invite ──────────
    if (pendingHouseholdSetup.has(from)) {
      const setup = pendingHouseholdSetup.get(from);

      if (setup.stage === 'invite') {
        // Stage 2: waiting for phone number to invite
        if (buttonPayload === 'hh_done' || /^(done|skip|no|nah|cancel)$/i.test(lower)) {
          pendingHouseholdSetup.delete(from);
          twiml.message('All set! They can join anytime with "join ' + setup.householdId + '".');
          return sendResponse();
        }
        // "Invite someone" button — prompt for number
        if (buttonPayload === 'hh_invite') {
          twiml.message('Send their phone number (e.g. 8220615883).');
          return sendResponse();
        }
        // Parse phone number — accept 10 digits, +91..., 91...
        const digits = incomingMsg.replace(/[\s\-\(\)]/g, '').replace(/^\+/, '');
        let invitePhone;
        if (/^91\d{10}$/.test(digits)) invitePhone = 'whatsapp:+' + digits;
        else if (/^\d{10}$/.test(digits)) invitePhone = 'whatsapp:+91' + digits;
        else {
          twiml.message('Couldn\'t parse that. Send a 10-digit mobile number, or "done" to skip.');
          return sendResponse();
        }
        if (invitePhone === from) {
          twiml.message('That\'s your own number! Send the other person\'s number, or "done" to skip.');
          return sendResponse();
        }
        // Send invite via WhatsApp — interactive with Join/Decline buttons
        const userName = (user && user.name) || 'Someone';
        const sharedList = setup.sharedCategories.join(', ');
        const fallbackInvite = '👋 ' + userName + ' invited you to track expenses together on Budgy!\n\n' +
          'Send *join ' + setup.householdId + '* to accept.\n\nShared categories: ' + sharedList;
        sendWhatsAppInteractive(invitePhone, 'household_invite_msg',
          { '1': userName, '2': setup.householdId, '3': sharedList }, fallbackInvite
        ).catch(err => console.error('[household] invite send failed:', err.message));
        pendingHouseholdSetup.delete(from);
        twiml.message(
          '✅ *Invite sent!*\n\n' +
          '🔑 Code: *' + setup.householdId + '*\n' +
          '📂 Shared: ' + setup.sharedCategories.join(', ') + '\n\n' +
          'They\'ll get a WhatsApp message to join. You can also share the code directly.'
        );
        return sendResponse();
      }

      // Stage 1: waiting for shared category picks
      const picks = incomingMsg.split(/[,\s]+/).map(n => parseInt(n)).filter(n => !isNaN(n) && n >= 1 && n <= CATEGORIES.length);
      if (picks.length > 0) {
        const sharedCategories = [...new Set(picks.map(i => CATEGORIES[i - 1]))];
        await updateUser(from, { householdId: setup.householdId, sharedCategories });
        pendingHouseholdSetup.set(from, { ...setup, sharedCategories, stage: 'invite' });
        const catList = sharedCategories.join(', ');
        const fallbackMsg = '✅ *Household created!*\n\n📂 *Shared categories:* ' + catList +
          '\n\nWant to invite someone? Send their phone number (e.g. 8220615883), or *done* to skip.';
        // Send interactive buttons, respond with empty TwiML
        sendWhatsAppInteractive(from, 'household_invite_step', { '1': catList }, fallbackMsg).catch(() => {});
      } else if (incomingMsg.toLowerCase() === 'cancel') {
        pendingHouseholdSetup.delete(from);
        twiml.message('Household setup cancelled.');
      } else {
        twiml.message('Reply with numbers like *1,3,5,8,9* to pick shared categories. Or "cancel" to abort.');
      }
      return sendResponse();
    }

    // ── 0d. Shared category reset — full re-pick ─────────────────────────
    if (pendingSharedCategoryReset.has(from)) {
      const picks = incomingMsg.split(/[,\s]+/).map(n => parseInt(n)).filter(n => !isNaN(n) && n >= 1 && n <= CATEGORIES.length);
      if (picks.length > 0) {
        const sharedCategories = [...new Set(picks.map(i => CATEGORIES[i - 1]))];
        await updateSharedCategories(from, sharedCategories);
        pendingSharedCategoryReset.delete(from);
        twiml.message('✅ Shared categories updated: ' + sharedCategories.join(', '));
      } else if (incomingMsg.toLowerCase() === 'cancel') {
        pendingSharedCategoryReset.delete(from);
        twiml.message('Cancelled.');
      } else {
        twiml.message('Reply with numbers like *1,3,5,8,9*. Or "cancel".');
      }
      return sendResponse();
    }

    // ── 0e. Household commands ───────────────────────────────────────────
    if (/\b(create|add|start|setup|set\s*up)\s+(a\s+)?(household|family)\b/i.test(lower)) {
      const existing = await getUser(from);
      if (existing && existing.householdId) {
        const members = await getHouseholdMembers(from);
        const names = members.map(m => m.name || 'Unknown').join(', ');
        twiml.message('You\'re already in a household (*' + existing.householdId + '*) with: ' + names + '\n\nSend "leave household" first if you want to create a new one.');
        return sendResponse();
      }
      const result = await createHousehold(from, []);
      pendingHouseholdSetup.set(from, { householdId: result.householdId });
      const catList = CATEGORIES.map((c, i) => (i + 1) + '. ' + c).join('\n');
      twiml.message(
        '🏠 Setting up your household...\n\n' +
        'Which categories should be *shared* with your family? Reply with numbers:\n\n' +
        catList + '\n\n' +
        'e.g. *1,2,3,8,9,15*'
      );
      return sendResponse();
    }

    // Handle join button payload (join_hh_xxxx) or text "join hh_xxxx"
    const joinPayload = buttonPayload.startsWith('join_') ? buttonPayload.replace('join_', '') : null;
    if (joinPayload === 'hh_decline' || buttonPayload === 'hh_decline') {
      twiml.message('No worries! You can always join later by sending "join <code>".');
      return sendResponse();
    }
    if (joinPayload || lower.startsWith('join ')) {
      const code = joinPayload || lower.replace('join ', '').trim();
      if (!code.startsWith('hh_')) {
        // Not a household code — fall through to normal parsing
      } else {
        const existing = await getUser(from);
        if (existing && existing.householdId) {
          twiml.message('You\'re already in a household (*' + existing.householdId + '*). Send "leave household" first.');
          return sendResponse();
        }
        const result = await joinHousehold(from, code);
        if (result.error === 'not_found') {
          twiml.message('❌ Household code "' + code + '" not found. Check with your family for the right code.');
          return sendResponse();
        }
        const sharedList = (result.sharedCategories || []).join(', ') || 'none set';
        twiml.message(
          '✅ *Joined household!*\n\n' +
          '👨‍👩‍👧 Members: ' + result.members.join(', ') + ' & you\n' +
          '📂 Shared categories: ' + sharedList + '\n\n' +
          'Your summaries now include shared household expenses.'
        );
        // Notify existing members
        const members = await getHouseholdMembers(from);
        const joiner = await getUser(from);
        const joinerName = (joiner && joiner.name) || 'Someone';
        for (const member of members) {
          if (member.phone === from) continue;
          sendWhatsAppTo(member.phone, '👋 *' + joinerName + '* joined your household!').catch(() => {});
        }
        return sendResponse();
      }
    }

    if (lower === 'leave household' || lower === 'leave family') {
      const existing = await getUser(from);
      if (!existing || !existing.householdId) {
        twiml.message('You\'re not in a household.');
        return sendResponse();
      }
      const members = await getHouseholdMembers(from);
      const leaverName = (existing.name) || 'Someone';
      await leaveHousehold(from);
      twiml.message('👋 You\'ve left the household. Your summaries now show only your expenses.');
      // Notify remaining members
      for (const member of members) {
        if (member.phone === from) continue;
        sendWhatsAppTo(member.phone, '👋 *' + leaverName + '* left the household.').catch(() => {});
      }
      return sendResponse();
    }

    if (lower === 'my household' || lower === 'my family') {
      const existing = await getUser(from);
      if (!existing || !existing.householdId) {
        twiml.message('You\'re not in a household yet.\n\nSend "create household" to start one, or "join <code>" to join an existing one.');
        return sendResponse();
      }
      const members = await getHouseholdMembers(from);
      const names = members.map(m => (m.name || 'Unknown') + (m.phone === from ? ' (you)' : '')).join('\n  ');
      const sharedList = (existing.sharedCategories || []).join(', ') || 'none';
      twiml.message(
        '🏠 *Your Household*\n\n' +
        '🔑 Code: *' + existing.householdId + '*\n' +
        '👥 Members:\n  ' + names + '\n\n' +
        '📂 Shared categories:\n  ' + sharedList + '\n\n' +
        'Commands: "add shared: Category", "remove shared: Category", "set shared categories", "leave household"'
      );
      return sendResponse();
    }

    if (lower.startsWith('add shared:') || lower.startsWith('add shared ')) {
      const input = incomingMsg.replace(/^add shared[:\s]+/i, '').trim();
      const existing = await getUser(from);
      if (!existing || !existing.householdId) {
        twiml.message('You\'re not in a household. Send "create household" first.');
        return sendResponse();
      }
      const match = CATEGORIES.find(c => c.toLowerCase().includes(input.toLowerCase()));
      if (!match) {
        twiml.message('Category not found. Available: ' + CATEGORIES.join(', '));
        return sendResponse();
      }
      const current = existing.sharedCategories || [];
      if (current.includes(match)) {
        twiml.message(match + ' is already shared.');
        return sendResponse();
      }
      await updateSharedCategories(from, [...current, match]);
      twiml.message('✅ *' + match + '* is now a shared category.');
      return sendResponse();
    }

    if (lower.startsWith('remove shared:') || lower.startsWith('remove shared ')) {
      const input = incomingMsg.replace(/^remove shared[:\s]+/i, '').trim();
      const existing = await getUser(from);
      if (!existing || !existing.householdId) {
        twiml.message('You\'re not in a household.');
        return sendResponse();
      }
      const match = CATEGORIES.find(c => c.toLowerCase().includes(input.toLowerCase()));
      if (!match) {
        twiml.message('Category not found. Available: ' + CATEGORIES.join(', '));
        return sendResponse();
      }
      const current = existing.sharedCategories || [];
      if (!current.includes(match)) {
        twiml.message(match + ' is already personal.');
        return sendResponse();
      }
      await updateSharedCategories(from, current.filter(c => c !== match));
      twiml.message('✅ *' + match + '* is now a personal category.');
      return sendResponse();
    }

    if (lower === 'set shared categories' || lower === 'shared categories') {
      const existing = await getUser(from);
      if (!existing || !existing.householdId) {
        twiml.message('You\'re not in a household. Send "create household" first.');
        return sendResponse();
      }
      pendingSharedCategoryReset.set(from, true);
      const catList = CATEGORIES.map((c, i) => (i + 1) + '. ' + c).join('\n');
      twiml.message('Pick shared categories (reply with numbers):\n\n' + catList + '\n\ne.g. *1,2,3,8,9,15*');
      return sendResponse();
    }

    // ── 0f. Progressive setup — soft CC/salary prompts ─────────────────
    if (pendingSetup.has(from)) {
      const setup = pendingSetup.get(from);
      const elapsed = Date.now() - (setup.askedAt ? setup.askedAt.getTime() : 0);
      const expired = elapsed > 60 * 60 * 1000; // 1h timeout

      if (!expired && setup.stage === 'cc_asked') {
        const isYes = buttonPayload === 'cc_yes' || /^(yes|yeah|yep|yea|ya|sure|i do|i have|yup|haan|ha)\b/i.test(lower);
        const isNo = buttonPayload === 'cc_no' || /^(no|nope|nah|don't|i don't|not really|nahi)\b/i.test(lower);
        const isLater = buttonPayload === 'cc_later';
        if (isYes) {
          // Check if they included card details in the same message
          const parsed = parseStatementInput(incomingMsg);
          if (parsed && !parsed._single && Object.keys(parsed).length > 0) {
            // They gave details — save them
            const userForStmt = await getUser(from);
            const dates = Object.assign({}, (userForStmt && userForStmt.statementDates) || {}, parsed);
            await updateUser(from, { statementDates: dates });
            pendingSetup.delete(from);
            const summary = Object.entries(dates).map(e => e[0] + ': ' + e[1] + 'th').join(', ');
            const hints = setupHintsSent.get(from) || new Set();
            hints.add('cc');
            setupHintsSent.set(from, hints);
            // Ask about salary next if not set
            if (!userForStmt || !userForStmt.salaryType) {
              const reply = await composeResponse('setup_salary_ask', { statementConfirmation: 'Saved! Statement dates — ' + summary + '.' }, user);
              pendingSetup.set(from, { stage: 'salary_asked', askedAt: new Date() });
              hints.add('salary');
              twiml.message(reply);
              return sendResponse();
            }
            twiml.message('Saved! Statement dates — ' + summary + '. I can now help you time big purchases.');
            return sendResponse();
          }
          // They said yes but no details — explain and ask
          pendingSetup.set(from, { stage: 'cc_details', askedAt: new Date() });
          const reply = await composeResponse('setup_cc_explain', {}, user);
          twiml.message(reply);
          return sendResponse();
        } else if (isNo) {
          pendingSetup.delete(from);
          const hints = setupHintsSent.get(from) || new Set();
          hints.add('cc');
          setupHintsSent.set(from, hints);
          // Ask about salary if not set
          if (!user.salaryType) {
            pendingSetup.set(from, { stage: 'salary_asked', askedAt: new Date() });
            hints.add('salary');
            const reply = await composeResponse('setup_cc_skipped', {}, user);
            twiml.message(reply);
            return sendResponse();
          }
          // Both done
          pendingSetup.delete(from);
          // Fall through to normal processing
        }
        if (isLater) {
          pendingSetup.delete(from);
          // Don't mark hint as sent — will ask again later
        }
        // Neither yes nor no nor later — clear state, process normally
        if (pendingSetup.has(from) && pendingSetup.get(from).stage === 'cc_asked') pendingSetup.delete(from);
      } else if (!expired && setup.stage === 'salary_asked') {
        // Handle salary button payloads
        if (buttonPayload === 'salary_last') {
          await updateUser(from, { salaryType: 'last', salaryDay: null });
          pendingSetup.delete(from);
          twiml.message(await composeResponse('salary_set', { label: 'end of month' }, user));
          return sendResponse();
        } else if (buttonPayload === 'salary_last_working') {
          await updateUser(from, { salaryType: 'last_working', salaryDay: null });
          pendingSetup.delete(from);
          twiml.message(await composeResponse('salary_set', { label: 'last working day' }, user));
          return sendResponse();
        } else if (buttonPayload === 'salary_fixed') {
          pendingSetup.set(from, { stage: 'salary_day', askedAt: new Date() });
          twiml.message('Which date? Just send the number (e.g. *26*).');
          return sendResponse();
        }
        // No button — fall through (parser handles "salary 26" naturally)
        pendingSetup.delete(from);
      } else if (!expired && setup.stage === 'salary_day') {
        // User told us they have a fixed date, now sending the day number
        const day = parseInt(incomingMsg);
        if (!isNaN(day) && day >= 1 && day <= 31) {
          await updateUser(from, { salaryType: 'fixed', salaryDay: day });
          pendingSetup.delete(from);
          twiml.message(await composeResponse('salary_set', { label: 'the ' + day + 'th' }, user));
          return sendResponse();
        }
        // Didn't parse — clear and fall through
        pendingSetup.delete(from);
      } else if (!expired && setup.stage === 'cc_details') {
        // User should be providing card details
        const parsed = parseStatementInput(incomingMsg);
        if (parsed && Object.keys(parsed).filter(k => k !== '_single').length > 0) {
          const userForStmt = await getUser(from);
          const dates = Object.assign({}, (userForStmt && userForStmt.statementDates) || {}, parsed);
          await updateUser(from, { statementDates: dates });
          pendingSetup.delete(from);
          const summary = Object.entries(dates).map(e => e[0] + ': ' + e[1] + 'th').join(', ');
          const hints = setupHintsSent.get(from) || new Set();
          hints.add('cc');
          setupHintsSent.set(from, hints);
          if (!userForStmt || !userForStmt.salaryType) {
            pendingSetup.set(from, { stage: 'salary_asked', askedAt: new Date() });
            hints.add('salary');
            const reply = await composeResponse('setup_salary_ask', { statementConfirmation: 'Saved! Statement dates — ' + summary + '.' }, user);
            twiml.message(reply);
            return sendResponse();
          }
          twiml.message('Saved! Statement dates — ' + summary + '. I can now help you time big purchases.');
          return sendResponse();
        }
        // Didn't parse as statement dates — try to parse naturally via Claude
        // Fall through to normal processing but keep state for one more try
        pendingSetup.delete(from);
      } else {
        // Expired or salary_asked — clear state, process normally
        // (salary responses like "salary 26" are handled by the parser naturally)
        pendingSetup.delete(from);
      }
    }

    // ── 0g. Export command ────────────────────────────────────────────────
    if (lower === 'export' || lower === 'export my expenses' || lower === 'download') {
      const crypto = require('crypto');
      const token = crypto.randomUUID();
      exportTokens.set(token, { phone: from, expires: Date.now() + 10 * 60 * 1000 }); // 10 min
      const baseUrl = process.env.WEBHOOK_URL || `https://${req.get('host')}`;
      const exportUrl = baseUrl + '/export/' + token;
      twiml.message('📥 Here\'s your export link (valid for 10 minutes):\n\n' + exportUrl + '\n\nThis will download a CSV with all your expenses.');
      return sendResponse();
    }

    // ── 1. PDF import confirmation ────────────────────────────────────────
    if (pendingImport.has(from)) {
      const { toAdd } = pendingImport.get(from);
      const reply = incomingMsg.toLowerCase();
      let selected = [];

      if (reply === 'yes' || reply === 'all') {
        selected = toAdd;
      } else if (reply === 'no' || reply === 'cancel') {
        pendingImport.delete(from);
        twiml.message("👍 Import cancelled.");
        return sendResponse();
      } else {
        const picks = reply.split(/[,\s]+/).map(n => parseInt(n)).filter(n => !isNaN(n));
        if (picks.length > 0) {
          selected = picks.map(i => toAdd[i - 1]).filter(Boolean);
        } else {
          twiml.message("Reply *yes* to add all, *no* to cancel, or pick specific ones like *1,3,5*");
          return sendResponse();
        }
      }

      if (selected.length === 0) {
        pendingImport.delete(from);
        twiml.message("Nothing selected. Import cancelled.");
        return sendResponse();
      }

      await batchAppendExpenses(selected, from);
      pendingImport.delete(from);
      const monthly = await getMonthlySummary(from);
      const importReply = await composeResponse('import_complete', {
        count: selected.length,
        monthlyTotal: monthly.total,
        breakdown: monthly.breakdown,
        discretionarySplit: monthly.discretionarySplit
      }, user);
      twiml.message(importReply);
      return sendResponse();
    }

    // ── 2. Category pick (low confidence) ────────────────────────────────
    if (pendingCategory.has(from)) {
      const pending = pendingCategory.get(from);
      const visibleCats = await getVisibleCategoriesForUser(from, user);
      // Handle list picker selection (buttonPayload = "cat_food___dining") or buttonText = "Food & Dining"
      let choice = parseInt(incomingMsg);
      if (isNaN(choice) && buttonPayload.startsWith('cat_')) {
        // Match by buttonText (exact category name from list picker)
        const matchIdx = visibleCats.findIndex(c => c === buttonText);
        if (matchIdx >= 0) choice = matchIdx + 1;
      }

      if (!isNaN(choice) && choice >= 1 && choice <= visibleCats.length) {
        pending.category = visibleCats[choice - 1];
        pendingCategory.delete(from);
        await appendExpense(pending);
        const [monthly, overspend] = await Promise.all([
          getMonthlySummary(from),
          getOverspendAlerts(from)
        ]);
        const reply = await composeResponse('expense_logged', {
          amount: pending.amount, category: pending.category, merchant: pending.merchant,
          note: pending.note, monthlyTotal: monthly.total, monthlyCount: monthly.count,
          cycleLabel: monthly.cycleLabel, breakdown: monthly.breakdown,
          overspend: overspend ? overspend.alerts.map(a => a.category + ' +' + a.pct + '%').join(', ') : null
        }, user);
        twiml.message(reply);
      } else if (incomingMsg.toLowerCase() === 'cancel') {
        pendingCategory.delete(from);
        twiml.message("👍 Cancelled.");
      } else {
        const catList = visibleCats.map((c, i) => (i + 1) + '. ' + getCategoryEmoji(c) + ' ' + c).join('\n');
        twiml.message('💸 ₹' + Number(pending.amount).toLocaleString('en-IN') +
          (pending.merchant ? ' @ ' + pending.merchant : '') +
          '\nWhich category?\n\n' + catList + '\n\nReply with a number or *cancel*');
      }
      return sendResponse();
    }

    // ── 3. No content ─────────────────────────────────────────────────────
    if (!incomingMsg && numMedia === 0) {
      const helpReply = await composeResponse('help', {}, user);
      twiml.message(helpReply);
      return sendResponse();
    }

    // ── 4. PDF statement ──────────────────────────────────────────────────
    if (numMedia > 0 && mediaType === 'application/pdf') {
      twiml.message("📄 Got your statement! Analysing — give me a few seconds...");
      sendResponse();
      processPDFAsync(from, mediaUrl, user).catch(err => {
        console.error('PDF error:', err);
        sendWhatsAppTo(from, "⚠️ Couldn't read that PDF. Try a different format.");
      });
      return;
    }

    // ── 5. Image ──────────────────────────────────────────────────────────
    if (numMedia > 0 && mediaUrl) {
      const result = await parseExpenseFromImage(mediaUrl, mediaType, incomingMsg);
      const reply = await handleExpenseResult(result, incomingMsg || '[image]', from, user);
      if (reply) twiml.message(reply);
      return sendResponse();
    }

    // ── 6. Text ───────────────────────────────────────────────────────────
    const result = await parseExpense(incomingMsg);

    // Budget suggestions (after 2+ weeks of data)
    if (result.type === 'suggest_budgets') {
      const suggestion = await suggestBudgets(from);
      if (!suggestion.ready) {
        const reply = await composeResponse('suggest_budgets_not_ready', { weeksLogged: suggestion.weeksLogged }, user);
        twiml.message(reply);
      } else {
        const lines = suggestion.suggestions.map(s => {
          const tag = s.committed ? ' 🔒' : '';
          return getCategoryEmoji(s.category) + ' *' + s.category + tag + '*\n  Avg: ₹' + s.avgMonthly.toLocaleString('en-IN') + '/mo → Suggested: ₹' + s.suggested.toLocaleString('en-IN') + '/mo';
        }).join('\n\n');
        const reply = await composeResponse('suggest_budgets', { weeksLogged: suggestion.weeksLogged, suggestions: lines }, user);
        twiml.message(reply);
      }
      return sendResponse();
    }

    // Weekly summary — send chart image + text (two messages)
    if (result.type === 'summary_weekly') {
      const { text, chartUrl } = await buildWeeklyDigest(from);
      if (chartUrl) {
        twiml.message('Building your weekly chart...');
        sendResponse();
        // Send chart then text asynchronously
        setTimeout(async () => {
          try {
            await sendWhatsAppImageTo(from, chartUrl, '');
            await new Promise(function(r) { setTimeout(r, 1500); });
            await sendWhatsAppTo(from, text);
          } catch (err) { console.error('Weekly chart send failed:', err.message); }
        }, 500);
        return;
      } else {
        twiml.message(text);
        return sendResponse();
      }
    }

    const reply = await handleExpenseResult(result, incomingMsg, from, user);
    if (reply) twiml.message(reply);

  } catch (err) {
    console.error('Webhook error:', err);
    const errReply = await composeResponse('error', {}, user).catch(() => '⚠️ Something went wrong. Try again!');
    twiml.message(errReply);
  }

  sendResponse();
});

// ─── PDF async ────────────────────────────────────────────────────────────────
async function processPDFAsync(from, mediaUrl, user) {
  const [allRows, parsed] = await Promise.all([getAllRows(from), parsePDFStatement(mediaUrl, user)]);

  if (!parsed || parsed.length === 0) {
    await sendWhatsAppTo(from, "📄 Parsed the statement — no new spendable transactions found.");
    return;
  }

  const { toAdd, duplicates } = deduplicateTransactions(parsed, allRows);

  if (toAdd.length === 0) {
    const noneReply = await composeResponse('import_none', {
      total: parsed.length, duplicates: duplicates.length
    }, user);
    await sendWhatsAppTo(from, noneReply);
    return;
  }

  pendingImport.set(from, { toAdd, duplicates });

  const preview = toAdd.slice(0, 20).map((tx, i) =>
    `${i + 1}. ${tx.date} — ₹${Number(tx.amount).toLocaleString('en-IN')} ${tx.merchant || ''} (${tx.category})`
  ).join('\n');
  const more = toAdd.length > 20 ? `\n...and ${toAdd.length - 20} more` : '';
  const dupNote = duplicates.length > 0 ? `\n\n♻️ ${duplicates.length} already logged (skipped)` : '';

  await sendWhatsAppTo(from,
    `📋 *${toAdd.length} new transaction${toAdd.length > 1 ? 's' : ''}:*\n\n${preview}${more}${dupNote}\n\n` +
    `Reply:\n• *yes* — add all\n• *1,3,5* — specific ones\n• *no* — cancel`
  );
}

// ─── Handle parsed result ─────────────────────────────────────────────────────
async function handleExpenseResult(result, raw, from, user) {
  if (result.type === 'expense') {
    const { amount, category, merchant, note, confidence } = result;
    const pending = { amount, category, merchant, note, raw, phone: from };

    if (confidence < 60) {
      pendingCategory.set(from, pending);
      const visibleCats = await getVisibleCategoriesForUser(from, user);
      const catList = visibleCats.map((c, i) => (i + 1) + '. ' + getCategoryEmoji(c) + ' ' + c).join('\n');
      const expDetail = '₹' + Number(amount).toLocaleString('en-IN') + (merchant ? ' @ ' + merchant : '');
      const fallback = await composeResponse('expense_low_confidence', {
        amount, category, merchant, confidence, categoryList: catList
      }, user);
      // Send list picker (max 10 items), fall back to text
      sendWhatsAppInteractive(from, 'category_picker', { '1': expDetail }, fallback).catch(() => {});
      return null;
    }

    await appendExpense(pending);

    // Cross-notify household members for shared expenses (fire-and-forget)
    getUser(from).then(u => {
      if (!u || !u.householdId) return;
      const shared = u.sharedCategories || [];
      if (!shared.includes(category)) return;
      getHouseholdMembers(from).then(members => {
        const others = members.filter(m => m.phone !== from);
        const name = u.name || 'Someone';
        const msg = name + ' logged ₹' + Number(amount).toLocaleString('en-IN') + ' — ' + category + (merchant ? ' · ' + merchant : '');
        for (const other of others) {
          sendWhatsAppTo(other.phone, msg).catch(err =>
            console.error('[household] notify failed:', err.message)
          );
        }
      });
    }).catch(() => {});

    // Increment expense count (non-critical)
    try { await incrementExpenseCount(from); } catch (e) { /* non-critical */ }

    // Anomaly check + summary data
    const anomaly = await checkAnomaly(amount, category, from);
    const [monthly, overspend, budgetStatus] = await Promise.all([
      getMonthlySummary(from),
      getOverspendAlerts(from),
      getBudgetStatus(from)
    ]);

    // Build budget warning string if applicable
    let budgetWarning = null;
    if (budgetStatus) {
      const budgets = await getBudgets();
      if (budgets[category]) {
        const catMonthly = monthly.byCategory[category] || 0;
        const budget = budgets[category];
        const pct = Math.round((catMonthly / budget) * 100);
        if (pct >= 70) {
          const status = pct >= 100 ? '🔴 Over budget!' : '🟡 Nearing limit';
          budgetWarning = status + ' ' + category + ': ₹' + Math.round(catMonthly).toLocaleString('en-IN') + ' of ₹' + Math.round(budget).toLocaleString('en-IN') + ' (' + pct + '%)';
        }
      }
    }

    // Check if we should trigger progressive setup
    const freshUser = await getUser(from);
    const expCount = freshUser ? (freshUser.expenseCount || 0) : 0;
    const hints = setupHintsSent.get(from) || new Set();
    const hasCC = freshUser && freshUser.statementDates && Object.keys(freshUser.statementDates).length > 0;
    const hasSalary = freshUser && freshUser.salaryType;

    // After 3rd expense, ask about CC (if not set and not asked before)
    if (expCount >= 3 && !hasCC && !hints.has('cc') && !pendingSetup.has(from)) {
      hints.add('cc');
      setupHintsSent.set(from, hints);
      pendingSetup.set(from, { stage: 'cc_asked', askedAt: new Date() });
      const expConf = getCategoryEmoji(category) + ' ₹' + Number(amount).toLocaleString('en-IN') + ' — ' + category + (merchant ? ' · ' + merchant : '') + '\n' + (monthly.cycleLabel || 'This month') + ': ₹' + monthly.total;
      const fallback = await composeResponse('setup_cc_ask', { expenseConfirmation: expConf }, user);
      // Send interactive buttons — response goes async, return null to signal "already handled"
      sendWhatsAppInteractive(from, 'cc_setup_ask', { '1': expConf }, fallback).catch(() => {});
      return null;
    }

    // After CC setup or 5th expense, ask about salary (if not set and not asked before)
    if (!hasSalary && !hints.has('salary') && !pendingSetup.has(from) && (hasCC || expCount >= 5)) {
      hints.add('salary');
      setupHintsSent.set(from, hints);
      pendingSetup.set(from, { stage: 'salary_asked', askedAt: new Date() });
      const expConf = getCategoryEmoji(category) + ' ₹' + Number(amount).toLocaleString('en-IN') + ' — ' + category + (merchant ? ' · ' + merchant : '') + '\n' + (monthly.cycleLabel || 'This month') + ': ₹' + monthly.total;
      const fallback = await composeResponse('setup_salary_ask_standalone', { expenseConfirmation: expConf }, user);
      sendWhatsAppInteractive(from, 'salary_setup_ask', { '1': expConf }, fallback).catch(() => {});
      return null;
    }

    return await composeResponse('expense_logged', {
      amount, category, merchant, note,
      monthlyTotal: monthly.total, monthlyCount: monthly.count,
      cycleLabel: monthly.cycleLabel, breakdown: monthly.breakdown,
      anomaly: anomaly || null,
      budgetWarning,
      overspend: overspend ? overspend.alerts.map(a => a.category + ' +' + a.pct + '%').join(', ') : null
    }, user);

  } else if (result.type === 'summary_monthly') {
    const [monthly, budgetStatus] = await Promise.all([
      getMonthlySummary(from),
      getBudgetStatus(from)
    ]);
    return await composeResponse('summary_monthly', {
      total: monthly.total, count: monthly.count,
      cycleLabel: monthly.cycleLabel,
      breakdown: monthly.breakdown,
      discretionarySplit: monthly.discretionarySplit,
      budgetStatus: budgetStatus || null
    }, user);

  } else if (result.type === 'summary_weekly') {
    const weekly = await getWeeklySummary(from);
    return await composeResponse('summary_weekly', {
      total: weekly.total, count: weekly.count,
      breakdown: weekly.breakdown,
      discretionarySplit: weekly.discretionarySplit
    }, user);

  } else if (result.type === 'undo') {
    const undone = await undoLast(from);
    return await composeResponse('undo', {
      amount: undone.amount, category: undone.category, merchant: undone.merchant
    }, user);

  } else if (result.type === 'set_salary') {
    const parsed = parseSalaryInput(result.raw || raw);
    if (parsed) {
      await updateUser(from, { salaryType: parsed.type, salaryDay: parsed.day || 0 });
      const label = parsed.type === 'fixed' ? 'the ' + parsed.day + 'th' :
                    parsed.type === 'last' ? 'end of month' : 'last working day';
      return await composeResponse('salary_set', { label }, user);
    }
    return 'Could not parse that. Try "26", "last", or "last working day".';

  } else if (result.type === 'set_statement') {
    const parsed = parseStatementInput(result.raw || raw);
    const userForStmt = await getUser(from);
    const dates = Object.assign({}, (userForStmt && userForStmt.statementDates) || {});
    if (parsed && parsed._single !== undefined) {
      // Single number without card name — ask them to include it (one-shot, no state)
      return await composeResponse('statement_need_card', { day: parsed._single }, user);
    } else if (parsed && Object.keys(parsed).length > 0) {
      Object.assign(dates, parsed);
      await updateUser(from, { statementDates: dates });
      const summary = Object.entries(dates).map(function(e) { return e[0] + ': ' + e[1] + 'th'; }).join(', ');
      return await composeResponse('statement_set', { summary }, user);
    }
    return await composeResponse('statement_need_card', { day: null }, user);

  } else if (result.type === 'purchase_timing') {
    const userForPurchase = await getUser(from);
    const dates = (userForPurchase && userForPurchase.statementDates) || {};
    if (Object.keys(dates).length === 0) {
      return await composeResponse('statement_need_card', { day: null, forPurchaseTiming: true }, user);
    }
    const advice = getBillingCycleAdvice(dates);
    const best = advice[0];
    const lines = advice.map(function(a) {
      return '💳 ' + a.card + ': statement in ' + a.daysUntilStatement + ' days → ~' + a.interestFreeDays + ' interest-free days if you buy today';
    }).join('\n');
    return await composeResponse('purchase_timing', {
      advice: lines, bestCard: best.card, bestDays: best.interestFreeDays
    }, user);

  } else {
    // Conversational fallback — Claude reads spending context and answers naturally
    // Try compact insights from materialized views + narrative search; fall back to raw rows
    let contextData;
    try {
      const [insights, narratives] = await Promise.all([
        getSpendingContext(from),
        searchNarratives(from, raw, 3).catch(() => [])
      ]);
      // Use insights if materialized views have data; otherwise fall back
      if (insights.catProfiles && insights.catProfiles.length > 0) {
        if (narratives.length > 0) insights.narratives = narratives;
        contextData = insights;
      } else {
        contextData = await getRecentExpensesWithIds(from);
      }
    } catch {
      contextData = await getRecentExpensesWithIds(from);
    }
    const conv = await handleConversation(raw, contextData, user);

    if (conv.type === 'answer') {
      return conv.text;

    } else if (conv.type === 'action') {
      if (conv.action === 'edit_last') {
        await editLastExpense(conv.field, conv.value, from);
        return conv.text || 'Done! Last expense updated.';

      } else if (conv.action === 'bulk_recategorize') {
        if (conv.updates && conv.updates.length > 0) {
          await bulkRecategorize(conv.updates);
          return conv.text || conv.updates.length + ' entries recategorised!';
        }
        return 'No entries to update.';

      } else if (conv.action === 'delete_row') {
        const expId = conv.expenseId || conv.rowIndex;
        await deleteExpenseById(expId);
        return conv.text || 'Entry deleted.';

      } else if (conv.action === 'add_category') {
        return conv.text || 'Got it! Use that category name when logging and I will recognise it.';

      } else {
        return conv.text || await composeResponse('help', {}, user);
      }

    } else {
      return await composeResponse('help', {}, user);
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Get visible categories for a user — progressive disclosure.
 * New users see 6 base categories; as they log more categories, those appear.
 */
async function getVisibleCategoriesForUser(phone, user) {
  try {
    const rows = await getAllRows(phone);
    return getVisibleCategories(user, rows);
  } catch {
    return CATEGORIES; // fallback to full list
  }
}

// ─── CSV Export ──────────────────────────────────────────────────────────────
// Token-based export: user sends "export" → gets a short-lived link → downloads CSV
const exportTokens = new Map(); // token → { phone, expires }

app.get('/export/:token', async (req, res) => {
  const entry = exportTokens.get(req.params.token);
  if (!entry || Date.now() > entry.expires) {
    exportTokens.delete(req.params.token);
    return res.status(404).send('Link expired or invalid. Send "export" to Budgy for a new one.');
  }

  try {
    const expenses = await getExpensesForExport(entry.phone);
    const header = 'Date,Time,Amount,Category,Merchant,Note';
    const rows = expenses.map(e => {
      const esc = s => '"' + (s || '').replace(/"/g, '""') + '"';
      return [e.date, e.time || '', e.amount, esc(e.category), esc(e.merchant), esc(e.note)].join(',');
    });
    const csv = header + '\n' + rows.join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="budgy-expenses.csv"');
    res.send(csv);

    // Consume token after use
    exportTokens.delete(req.params.token);
  } catch (err) {
    console.error('Export failed:', err);
    res.status(500).send('Export failed. Try again.');
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

async function start() {
  await initSheet();
  await initUsersSheet();
  scheduleHeartbeat();
  app.listen(PORT, () => console.log(`✅ Budgy v5 (Supabase) running on port ${PORT}`));
}

start().catch(console.error);

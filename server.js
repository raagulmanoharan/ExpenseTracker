require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const { CATEGORIES, getCategoryEmoji, getMonthName } = require('./constants');
const { parseExpense, parseExpenseFromImage } = require('./parser');
const { parsePDFStatement, deduplicateTransactions } = require('./pdf-parser');
const {
  initSheet, appendExpense, batchAppendExpenses, getAllRows,
  getMonthlySummary, getWeeklySummary, getOverspendAlerts,
  getBudgets, suggestBudgets, getBudgetStatus,
  checkAnomaly, undoLast, buildDiscretionarySplit, editLastExpense, deleteRowByIndex, bulkRecategorize,
  initUsersSheet, getUser, createUser, updateUser, incrementExpenseCount,
  updateLastMessageAt,
  parseSalaryInput, parseStatementInput, getBillingCycleAdvice,
  getHouseholdRows, getHouseholdMembers, createHousehold, joinHousehold, leaveHousehold, updateSharedCategories
} = require('./sheets');
const { scheduleHeartbeat, buildWeeklyDigest } = require('./scheduler');
const { sendWhatsAppTo, sendWhatsAppImageTo } = require('./messaging');
const { handleConversation } = require('./conversation');

const app = express();
app.use(express.urlencoded({ extended: false, verify: (req, res, buf) => { req.rawBody = buf.toString(); } }));
app.use(express.json());

const MessagingResponse = twilio.twiml.MessagingResponse;

// ─── State ────────────────────────────────────────────────────────────────────
const pendingCategory = new Map(); // low-confidence expense awaiting category pick
const pendingImport = new Map();   // PDF transactions awaiting confirmation
const pendingOnboarding = new Map(); // new users being onboarded
const pendingContextual = new Map(); // contextual questions (salary, card, statement)
const pendingHouseholdSetup = new Map(); // awaiting shared category selection
const pendingSharedCategoryReset = new Map(); // awaiting full shared category reset

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
  let responseSent = false;

  function sendResponse() {
    if (responseSent) return;
    responseSent = true;
    res.type('text/xml').send(twiml.toString());
  }

  console.log(`[${new Date().toISOString()}] ${from} | ${mediaType || 'text'} | "${incomingMsg.substring(0, 100)}"`);

  try {

    // ── 0. New user detection — onboarding ────────────────────────────────
    let user = await getUser(from);

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
          twiml.message('Nice to meet you, ' + name + '!\n\nSend me any expense to get started — just type it naturally.\n\n"lunch 280 Swiggy"   "auto 80"   "groceries 1200"\n\nOr send a receipt photo or bank SMS screenshot. That\'s all!');
        } else {
          twiml.message("What's your name? (just your first name is fine)");
        }
        return sendResponse();
      } else {
        pendingOnboarding.set(from, true);
        twiml.message("Hey! I\'m Budgy — your personal expense tracker on WhatsApp.\n\nWhat\'s your name?");
        return sendResponse();
      }
    }

    // ── 0b. Contextual question replies ──────────────────────────────────
    if (pendingContextual.has(from)) {
      const ctx = pendingContextual.get(from);

      if (ctx.type === 'salary') {
        const parsed = parseSalaryInput(incomingMsg);
        if (parsed) {
          await updateUser(from, { salaryType: parsed.type, salaryDay: parsed.day || 0 });
          pendingContextual.delete(from);
          const label = parsed.type === 'fixed' ? 'the ' + parsed.day + 'th' :
                        parsed.type === 'last' ? 'end of month' : 'last working day';
          twiml.message('Got it — salary on ' + label + '. Summaries will now use your real month boundaries.');
        } else {
          twiml.message('Just reply with a number like "26", or "last" for end of month, or "last working day".');
        }
        return sendResponse();
      }

      if (ctx.type === 'statement') {
        const parsed = parseStatementInput(incomingMsg);
        const cardName = ctx.card;
        const user2 = await getUser(from);
        const dates = Object.assign({}, user2.statementDates || {});

        if (parsed && parsed._single !== undefined) {
          if (cardName) dates[cardName.toUpperCase()] = parsed._single;
          await updateUser(from, { statementDates: dates });
          pendingContextual.delete(from);
          twiml.message('Saved! ' + (cardName || 'Card') + ' statement generates on the ' + parsed._single + 'th each month. I can now help you time big purchases for max interest-free days.');
        } else if (parsed && Object.keys(parsed).length > 0) {
          Object.assign(dates, parsed);
          await updateUser(from, { statementDates: dates });
          pendingContextual.delete(from);
          const summary = Object.entries(dates).map(function(e) { return e[0] + ': ' + e[1] + 'th'; }).join(', ');
          twiml.message('Saved! Statement dates — ' + summary + '.\n\nNow I can help you time big purchases for maximum interest-free days.');
        } else {
          twiml.message('Just reply with the date number, e.g. "5" or "HSBC 5, AMEX 12".');
        }
        return sendResponse();
      }

      pendingContextual.delete(from);
    }

    // ── 0c. Household setup — shared category selection ──────────────────
    if (pendingHouseholdSetup.has(from)) {
      const { householdId } = pendingHouseholdSetup.get(from);
      const picks = incomingMsg.split(/[,\s]+/).map(n => parseInt(n)).filter(n => !isNaN(n) && n >= 1 && n <= CATEGORIES.length);
      if (picks.length > 0) {
        const sharedCategories = [...new Set(picks.map(i => CATEGORIES[i - 1]))];
        await updateUser(from, { householdId, sharedCategories });
        pendingHouseholdSetup.delete(from);
        twiml.message(
          '✅ *Household created!*\n\n' +
          '🔑 Code: *' + householdId + '*\n' +
          'Share this with your family — they just send "join ' + householdId + '" to me.\n\n' +
          '📂 *Shared categories:* ' + sharedCategories.join(', ') + '\n\n' +
          'You can change these anytime with "add shared: Category" or "remove shared: Category".'
        );
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
    const lower = incomingMsg.toLowerCase().trim();

    if (lower === 'create household' || lower === 'create family') {
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

    if (lower.startsWith('join ')) {
      const code = lower.replace('join ', '').trim();
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
      twiml.message(
        `✅ *${selected.length} transaction${selected.length > 1 ? 's' : ''} imported!*\n\n` +
        `📊 *${getMonthName()} so far: ₹${monthly.total}*\n${monthly.breakdown}` +
        monthly.discretionarySplit
      );
      return sendResponse();
    }

    // ── 2. Category pick (low confidence) ────────────────────────────────
    if (pendingCategory.has(from)) {
      const pending = pendingCategory.get(from);
      const choice = parseInt(incomingMsg);

      if (!isNaN(choice) && choice >= 1 && choice <= CATEGORIES.length) {
        pending.category = CATEGORIES[choice - 1];
        pendingCategory.delete(from);
        await appendExpense(pending);
        const monthly = await getMonthlySummary(from);
        const overspend = await getOverspendAlerts(from);
        let reply = buildLoggedReply(pending, monthly);
        if (overspend) reply += formatOverspendAlert(overspend);
        twiml.message(reply);
      } else if (incomingMsg.toLowerCase() === 'cancel') {
        pendingCategory.delete(from);
        twiml.message("👍 Cancelled.");
      } else {
        twiml.message(buildCategoryPrompt(pending));
      }
      return sendResponse();
    }

    // ── 3. No content ─────────────────────────────────────────────────────
    if (!incomingMsg && numMedia === 0) {
      twiml.message(helpText());
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
      twiml.message(reply);
      return sendResponse();
    }

    // ── 6. Text ───────────────────────────────────────────────────────────
    const result = await parseExpense(incomingMsg);

    // Budget suggestions (after 2+ weeks of data)
    if (result.type === 'suggest_budgets') {
      const suggestion = await suggestBudgets(from);
      if (!suggestion.ready) {
        twiml.message('📊 Not enough data yet — need at least 2 full weeks.\n\nYou have ' + suggestion.weeksLogged + ' complete week(s) logged. Keep going!');
      } else {
        const lines = suggestion.suggestions.map(s => {
          const tag = s.committed ? ' 🔒' : '';
          return getCategoryEmoji(s.category) + ' *' + s.category + tag + '*\n  Avg: ₹' + s.avgMonthly.toLocaleString('en-IN') + '/mo → Suggested: ₹' + s.suggested.toLocaleString('en-IN') + '/mo';
        }).join('\n\n');
        twiml.message('💡 *Budget Suggestions* (' + suggestion.weeksLogged + ' weeks of data)\nSet 10% below your run-rate — a realistic starting point.\n\n' + lines + '\n\n🔒 = committed (harder to cut)');
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
    twiml.message(reply);

  } catch (err) {
    console.error('Webhook error:', err);
    twiml.message('⚠️ Something went wrong. Try again!');
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
    await sendWhatsAppTo(from,
      `✅ All ${parsed.length} transactions already logged! ${duplicates.length} duplicate${duplicates.length > 1 ? 's' : ''} skipped.`
    );
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
      return buildCategoryPrompt(pending, confidence);
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

    // Contextual trigger: after 3rd expense, ask about card if not set
    try {
      const expCount = await incrementExpenseCount(from);
      const userForCtx = await getUser(from);
      if (expCount === 3 && userForCtx && Object.keys(userForCtx.statementDates || {}).length === 0) {
        pendingContextual.set(from, { type: 'statement', card: null });
        // Will ask after sending the logged reply — append to reply below
      }
    } catch (e) { /* non-critical */ }

    // Anomaly check
    const anomaly = await checkAnomaly(amount, category, from);
    const [monthly, overspend, budgetStatus] = await Promise.all([
      getMonthlySummary(from),
      getOverspendAlerts(from),
      getBudgetStatus(from)
    ]);

    let reply = buildLoggedReply(pending, monthly);

    // Anomaly alert
    if (anomaly) {
      if (anomaly.type === 'spike') {
        reply += `\n\n🚨 *Unusual spend!* ₹${Number(amount).toLocaleString('en-IN')} is ${anomaly.multiple}x your usual ${category} amount (avg ₹${anomaly.avg.toLocaleString('en-IN')})`;
      } else if (anomaly.type === 'high') {
        reply += `\n\n🚨 *High spend!* ₹${Number(amount).toLocaleString('en-IN')} is your largest ever ${category} transaction (prev max ₹${anomaly.prev_max.toLocaleString('en-IN')})`;
      } else if (anomaly.type === 'large') {
        reply += `\n\n🚨 *Large transaction!* Is ₹${Number(amount).toLocaleString('en-IN')} expected?`;
      }
    }

    // Budget check for this category
    if (budgetStatus) {
      const budgets = await getBudgets();
      if (budgets[category]) {
        const catMonthly = monthly.byCategory[category] || 0;
        const budget = budgets[category];
        const pct = Math.round((catMonthly / budget) * 100);
        if (pct >= 70) {
          const status = pct >= 100 ? '🔴 Over budget!' : '🟡 Nearing limit';
          reply += `\n\n${status} *${category}:* ₹${Math.round(catMonthly).toLocaleString('en-IN')} of ₹${Math.round(budget).toLocaleString('en-IN')} (${pct}%)`;
        }
      }
    }

    if (overspend) reply += formatOverspendAlert(overspend);

    // Append contextual question if triggered
    if (pendingContextual.has(from) && pendingContextual.get(from).type === 'statement') {
      reply += '\n\nQuick one — which credit cards do you use? And what date does the statement generate each month?\n(e.g. "HSBC 5, AMEX 12" or just "5" if you use one card)\n\nThis helps me tell you the best time to make big purchases.';
    }

    return reply;

  } else if (result.type === 'summary_monthly') {
    const monthly = await getMonthlySummary(from);
    const budgetStatus = await getBudgetStatus(from);
    let reply =
      '*' + (monthly.cycleLabel || getMonthName()) + '*\n' +
      '₹' + monthly.total + '  (' + monthly.count + ' transactions)\n\n' +
      monthly.breakdown +
      monthly.discretionarySplit;
    if (budgetStatus) reply += '\n\n━━━━━━━━━━━━\n*Budgets*\n' + budgetStatus;

    // Salary prompt removed — PAY_DATES_2026 fallback provides correct cycle bounds.
    // Users can still set custom salary dates with "set salary <date>".

    return reply;

  } else if (result.type === 'summary_weekly') {
    const weekly = await getWeeklySummary(from);
    return (
'*This Week*\n' +
      '₹' + weekly.total + '  (' + weekly.count + ' transactions)\n\n' +
      weekly.breakdown +
      weekly.discretionarySplit
    );

  } else if (result.type === 'undo') {
    const undone = await undoLast(from);
    return `↩️ Removed: ₹${Number(undone.amount).toLocaleString('en-IN')} — ${undone.category}${undone.merchant ? ` @ ${undone.merchant}` : ''}`;

  } else if (result.type === 'set_salary') {
    const parsed = parseSalaryInput(result.raw || raw);
    if (parsed) {
      await updateUser(from, { salaryType: parsed.type, salaryDay: parsed.day || 0 });
      const label = parsed.type === 'fixed' ? 'the ' + parsed.day + 'th' :
                    parsed.type === 'last' ? 'end of month' : 'last working day';
      return 'Got it — salary on ' + label + '. Summaries will now use your real month boundaries.';
    }
    return 'Could not parse that. Try "26", "last", or "last working day".';

  } else if (result.type === 'set_statement') {
    const parsed = parseStatementInput(result.raw || raw);
    const userForStmt = await getUser(from);
    const dates = Object.assign({}, (userForStmt && userForStmt.statementDates) || {});
    if (parsed && parsed._single !== undefined) {
      pendingContextual.set(from, { type: 'statement', card: null });
      return 'Which card is this statement date for?';
    } else if (parsed && Object.keys(parsed).length > 0) {
      Object.assign(dates, parsed);
      await updateUser(from, { statementDates: dates });
      const summary = Object.entries(dates).map(function(e) { return e[0] + ': ' + e[1] + 'th'; }).join(', ');
      return 'Saved! Statement dates — ' + summary + '.\n\nNow I can help you time big purchases for maximum interest-free days.';
    }
    return 'Could not parse that. Try "HSBC 5" or "HSBC 5, AMEX 12".';

  } else if (result.type === 'purchase_timing') {
    const userForPurchase = await getUser(from);
    const dates = (userForPurchase && userForPurchase.statementDates) || {};
    if (Object.keys(dates).length === 0) {
      pendingContextual.set(from, { type: 'statement', card: null });
      return 'To give you the best timing advice, I need your credit card statement dates first.\n\nWhich cards do you use and when does the statement generate? (e.g. "HSBC 5, AMEX 12")';
    }
    const advice = getBillingCycleAdvice(dates);
    const best = advice[0];
    const lines = advice.map(function(a) {
      return getCategoryEmoji('Subscriptions').replace('📱','💳') + ' ' + a.card + ': statement in ' + a.daysUntilStatement + ' days → ~' + a.interestFreeDays + ' interest-free days if you buy today';
    }).join('\n');
    return '*Best time to make a big purchase:*\n\n' + lines + '\n\n' +
      '*Best card right now:* ' + best.card + ' — ~' + best.interestFreeDays + ' interest-free days\n\n' +
      'For maximum days, always buy the day *after* your statement generates.';

  } else {
    // Conversational fallback — Claude reads expense data and answers naturally
    const rows = await getHouseholdRows(from);
    const conv = await handleConversation(raw, rows, user);

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
        await deleteRowByIndex(conv.rowIndex);
        return conv.text || 'Entry deleted.';

      } else if (conv.action === 'add_category') {
        // Categories are baked into the parser — acknowledge and note
        return conv.text || 'Got it! Use that category name when logging and I will recognise it.';

      } else {
        return conv.text || helpText();
      }

    } else {
      return helpText();
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function buildLoggedReply(pending, monthly) {
  const merchantLine = pending.merchant ? ' · ' + pending.merchant : '';
  return (
    '✅ *' + pending.category + merchantLine + '*\n' +
    '₹' + Number(pending.amount).toLocaleString('en-IN') +
    (pending.note ? '  _' + pending.note + '_' : '') + '\n' +
    '\n━━━━━━━━━━━━\n' +
    '*' + (monthly.cycleLabel || getMonthName()) + '*   ₹' + monthly.total + '\n' +
    monthly.breakdown
  );
}

function buildCategoryPrompt(pending, confidence) {
  const note = confidence !== undefined
    ? `\n🤔 Not sure of category (${confidence}% confident). Pick one:\n`
    : '\nWhich category?\n';
  const list = CATEGORIES.map((c, i) => `${i + 1}. ${getCategoryEmoji(c)} ${c}`).join('\n');
  return `💸 ₹${Number(pending.amount).toLocaleString('en-IN')}${pending.merchant ? ` @ ${pending.merchant}` : ''}${note}\n${list}\n\nReply with a number or *cancel*`;
}

function formatOverspendAlert(overspend) {
  const lines = overspend.alerts.map(a => getCategoryEmoji(a.category) + ' ' + a.category + '  +' + a.pct + '% vs avg').join('\n');
  return '\n\n⚠️ *Heads up — running over in:*\n' + lines;
}

function helpText() {
  return (
    '👋 Send me:\n' +
    '• "lunch 250 Swiggy" — log expense\n' +
    '• Receipt or bank SMS screenshot 📸\n' +
    '• Bank statement PDF 📄\n' +
    '• summary — monthly total\n' +
    '• this week — weekly breakdown\n' +
    '• suggest budgets — after 2+ weeks of data\n' +
    '• undo — remove last entry\n\n' +
    '🏠 *Household:*\n' +
    '• create household — start a family group\n' +
    '• join <code> — join an existing household\n' +
    '• my household — see members & settings\n' +
    '• add shared: <category> — mark as shared\n' +
    '• remove shared: <category> — mark as personal\n' +
    '• leave household — leave the group'
  );
}

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

async function start() {
  await initSheet();
  await initUsersSheet();
  scheduleHeartbeat();
  app.listen(PORT, () => console.log(`✅ Expense tracker v4 running on port ${PORT}`));
}

start().catch(console.error);

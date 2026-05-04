// ─── Claude Response Composer ────────────────────────────────────────────────
// Replaces hardcoded response templates with Claude-composed WhatsApp messages.
// Uses Haiku for speed (~300-800ms). Falls back to static templates on failure.

const { client, callWithRetry } = require('./anthropic-client');
const { getCategoryEmoji, getVisibleCategories } = require('./constants');

const SYSTEM_PROMPT = `You are Budgy — a friendly WhatsApp expense tracker for people in India.

PERSONALITY:
- Warm, casual, slightly playful — like a friend who's good with money
- Short replies — this is WhatsApp, not email
- Use Indian formatting: ₹1,200 not $1,200
- Use bold (*text*) and italic (_text_) sparingly for emphasis
- Use emojis naturally but don't overdo it — 1-2 per message max
- Never say "Great!" or "Awesome!" at the start — vary your openers
- Never lecture or moralize about spending

RULES:
- Reply in 1-4 lines. Summaries can be longer but stay concise.
- Always include the key data (amounts, categories, totals) — don't sacrifice info for brevity
- If there's an anomaly or budget alert, weave it in naturally — don't use a separate section header
- Format amounts with Indian number system: ₹1,20,000
- Use WhatsApp formatting: *bold*, _italic_, ~strikethrough~
- Do NOT use markdown headers (#), bullet dashes (- ), or code blocks
- Return ONLY the message text — no JSON wrapper, no explanation`;

/**
 * Compose a natural WhatsApp response for a given action.
 *
 * @param {string} actionType - e.g. 'expense_logged', 'summary_monthly', etc.
 * @param {object} context - structured data about what happened
 * @param {object|null} user - user profile
 * @returns {Promise<string>} composed message text
 */
async function composeResponse(actionType, context, user) {
  const userName = user?.name || null;
  const userMessage = buildUserMessage(actionType, context, userName);

  try {
    const response = await callWithRetry(() => client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }]
    }));
    const text = response.content[0].text.trim();
    // Sanity check — if Claude returned something too short or looks like JSON, use fallback
    if (text.length < 5 || text.startsWith('{')) {
      return getFallback(actionType, context);
    }
    return text;
  } catch (err) {
    console.error('[responder] Claude composition failed:', err.message);
    return getFallback(actionType, context);
  }
}

/**
 * Build a structured description of the action for Claude to compose a response from.
 */
function buildUserMessage(actionType, ctx, userName) {
  const nameCtx = userName ? `User's name: ${userName}\n` : '';

  switch (actionType) {
    case 'expense_logged':
      return `${nameCtx}Compose a WhatsApp reply confirming this expense was logged.

Expense: ₹${Number(ctx.amount).toLocaleString('en-IN')} — ${ctx.category}${ctx.merchant ? ' at ' + ctx.merchant : ''}${ctx.note ? ' (' + ctx.note + ')' : ''}
Cycle total: ₹${ctx.monthlyTotal} (${ctx.monthlyCount} transactions)
Cycle label: ${ctx.cycleLabel || 'This month'}
${ctx.breakdown ? 'Top categories:\n' + ctx.breakdown : ''}${ctx.anomaly ? '\nANOMALY: ' + formatAnomalyForPrompt(ctx.anomaly, ctx.amount, ctx.category) : ''}${ctx.budgetWarning ? '\nBUDGET: ' + ctx.budgetWarning : ''}${ctx.overspend ? '\nOVERSPEND: ' + ctx.overspend : ''}${ctx.cardTip ? '\nCARD TIP (forward-looking, optional): ' + formatCardTipForPrompt(ctx.cardTip) : ''}

Include the emoji for the category. Show the cycle total. If there's an anomaly or budget warning, mention it naturally (don't use a separate section). If a CARD TIP is present, append it as a single short line below the confirmation prefixed with 💳 — keep it casual, mention the card, the multiplier, and the rupee upside. Don't moralize or push it; one line max.`;

    case 'expense_low_confidence':
      return `${nameCtx}The user logged an expense but I'm not confident about the category. Ask them to pick.

Expense: ₹${Number(ctx.amount).toLocaleString('en-IN')}${ctx.merchant ? ' at ' + ctx.merchant : ''}
My guess: ${ctx.category} (${ctx.confidence}% confident)

Available categories (numbered):
${ctx.categoryList}

Ask them to reply with a number. Keep it brief. Show the numbered list.`;

    case 'summary_monthly':
      return `${nameCtx}Compose a monthly spending summary reply.

${ctx.cycleLabel || 'This month'}: ₹${ctx.total} across ${ctx.count} transactions

Breakdown:
${ctx.breakdown}
${ctx.discretionarySplit ? '\n' + ctx.discretionarySplit : ''}${ctx.budgetStatus ? '\nBudgets:\n' + ctx.budgetStatus : ''}

Present this as a clean, scannable summary. Use emojis for categories.`;

    case 'summary_weekly':
      return `${nameCtx}Compose a weekly spending summary reply.

This week: ₹${ctx.total} across ${ctx.count} transactions

Breakdown:
${ctx.breakdown}
${ctx.discretionarySplit ? '\n' + ctx.discretionarySplit : ''}

Keep it short and punchy.`;

    case 'undo':
      return `${nameCtx}The user's last expense was removed.

Removed: ₹${Number(ctx.amount).toLocaleString('en-IN')} — ${ctx.category}${ctx.merchant ? ' at ' + ctx.merchant : ''}

Confirm the undo in 1 line. Be casual.`;

    case 'suggest_budgets':
      return `${nameCtx}Here are AI-suggested budgets based on ${ctx.weeksLogged} weeks of data. Present them cleanly.

Suggestions:
${ctx.suggestions}

Explain briefly that these are set ~10% below their run rate as a starting point.`;

    case 'suggest_budgets_not_ready':
      return `${nameCtx}The user asked for budget suggestions but doesn't have enough data yet.

Weeks logged: ${ctx.weeksLogged} (need at least 2)

Encourage them to keep logging. Be warm, not patronizing.`;

    case 'salary_set':
      return `${nameCtx}The user set their salary date.

Salary: ${ctx.label}

Confirm briefly. Mention that summaries will now use their pay cycle.`;

    case 'statement_set':
      return `${nameCtx}The user set their credit card statement dates.

Statement dates: ${ctx.summary}

Confirm and mention you can now help time big purchases for max interest-free days.`;

    case 'statement_need_card':
      if (ctx.forPurchaseTiming) {
        return `${nameCtx}The user asked about purchase timing, but we don't have their credit card statement dates yet.

Ask them to share their statement dates so you can give timing advice. Example format: "statement HSBC 5, AMEX 12". One line, friendly.`;
      }
      if (ctx.day) {
        return `${nameCtx}The user tried to set a statement date (day ${ctx.day}) but didn't include the card name.

Ask them to include the card name. Example: "${ctx.day}" should be "HSBC ${ctx.day}" or "AMEX ${ctx.day}". Keep it brief — one line.`;
      }
      return `${nameCtx}The user tried to set a statement date but the format wasn't clear.

Ask them to try again with format like "HSBC 5" or "HSBC 5, AMEX 12". Brief.`;

    case 'purchase_timing':
      return `${nameCtx}The user asked when to make a big purchase. Here's the billing cycle analysis:

${ctx.advice}

Best card right now: ${ctx.bestCard} — ~${ctx.bestDays} interest-free days

Explain simply: buy right after statement date = max free days.`;

    case 'import_complete':
      return `${nameCtx}Bank statement import completed.

Imported: ${ctx.count} transaction${ctx.count > 1 ? 's' : ''}
Cycle total: ₹${ctx.monthlyTotal}
${ctx.breakdown ? 'Breakdown:\n' + ctx.breakdown : ''}${ctx.discretionarySplit ? '\n' + ctx.discretionarySplit : ''}

Confirm the import. Show the updated total.`;

    case 'import_none':
      return `${nameCtx}The user uploaded a bank statement but all ${ctx.total} transactions were already logged.

${ctx.duplicates} duplicate${ctx.duplicates > 1 ? 's' : ''} skipped.

Let them know briefly — they're already up to date.`;

    case 'onboarding_welcome':
      return `Compose a first-time welcome message for Budgy (a WhatsApp expense tracker).

Ask for the user's name. Keep it friendly and short — 2 lines max. Don't explain features yet.`;

    case 'onboarding_name_received':
      return `${nameCtx}The user just told us their name. Welcome them and show them how to get started.

Show 2-3 quick examples of how to log expenses:
- "lunch 280 Swiggy"
- "auto 80"
- "groceries 1200"

Mention they can also send receipt photos or bank SMS screenshots.

Then show a SHORT list of handy shortcuts they can use anytime:
- *summary* — monthly spending
- *this week* — weekly breakdown
- *undo* — remove last entry
- *suggest budgets* — after 2+ weeks of data
- *export* — download CSV
- *create household* — track with family

Keep it warm but not overwhelming. 5-6 lines max.`;

    case 'setup_cc_ask':
      return `${nameCtx}You just logged an expense for the user. Now naturally ask if they use credit cards.

Expense confirmation: ${ctx.expenseConfirmation}

After the confirmation, add a casual line asking if they use any credit cards. Explain briefly that knowing their statement dates helps time big purchases for maximum interest-free days.

End with something like "yes / no" to make it easy to respond. Keep the CC question casual — 1-2 lines after the expense confirmation. Don't make it feel like a form.`;

    case 'setup_cc_explain':
      return `${nameCtx}The user said they use credit cards. Explain why adding statement dates helps and ask for them.

Explain simply: if you buy right after your statement date, you get ~50 days interest-free vs ~20 days if you buy right before.

Ask them to share their cards and statement dates. The statement date is when the bill generates — usually printed on the card statement or visible in the bank app.

Give an example format: "HDFC 5, Axis 12" or just tell me naturally like "I have HDFC, statement on the 5th".

Keep it friendly and brief — 3-4 lines max.`;

    case 'setup_cc_skipped':
      return `${nameCtx}The user said they don't use credit cards. Acknowledge briefly (1 line), then naturally ask when their salary comes in.

Explain in 1 line why it helps: "Knowing your pay date lets me track spending by your actual pay cycle instead of calendar months."

Give examples: "salary 26" or "salary last" or "salary last working day". Keep it brief — 2-3 lines total.`;

    case 'setup_salary_ask':
      return `${nameCtx}You just set up the user's credit card statement dates. Now naturally ask about their salary date.

Statement confirmation: ${ctx.statementConfirmation || 'Statement dates saved.'}

After confirming, ask when their salary comes in. Explain briefly: it helps track spending by pay cycle.

Give examples: "salary 26" or "salary last" or "salary last working day". Keep it casual — 2 lines after the confirmation.`;

    case 'setup_salary_ask_standalone':
      return `${nameCtx}Naturally ask the user when their salary comes in.

${ctx.expenseConfirmation ? 'Expense confirmation: ' + ctx.expenseConfirmation + '\n\nAfter the confirmation, add' : 'Add'} a casual question about their salary/pay date.

Explain briefly: "Knowing your pay date lets me track spending by your actual pay cycle."

Give examples: "salary 26" or "salary last" or "salary last working day". Keep it casual — 1-2 lines.`;

    case 'help':
      return `${nameCtx}The user needs help. List what Budgy can do, briefly.

Features:
- Log expenses by text ("lunch 250 Swiggy")
- Send receipt/SMS screenshots
- Upload bank statement PDFs
- Monthly summary ("summary")
- Weekly summary ("this week")
- Budget suggestions ("suggest budgets")
- Undo last entry ("undo")
- Household: create, join, manage shared categories

Format as a clean, scannable list for WhatsApp.`;

    case 'rewards_report':
      return `${nameCtx}Compose a credit-card rewards report for this cycle.

Cycle: ${ctx.cycleLabel}
Tagged transactions: ${ctx.taggedTxnCount} · Untagged: ${ctx.untaggedTxnCount}

Per-card breakdown (sorted by spend):
${(ctx.cards || []).map(c => `  ${c.card}: spent ₹${Math.round(c.totalSpend).toLocaleString('en-IN')} across ${c.txnCount} txns → earned ~₹${c.actualValue} (${c.effectiveRatePct}%) · optimal would have been ~₹${c.theoreticalValue} (${c.optimalRatePct}%) · gap ₹${c.gap}`).join('\n')}

Totals: spent ₹${Math.round(ctx.totals?.totalSpend || 0).toLocaleString('en-IN')} · earned ~₹${ctx.totals?.actualValue} · optimal ~₹${ctx.totals?.theoreticalValue} · gap ₹${ctx.totals?.gap}

Format as a clean WhatsApp-readable summary. Use 💳 emoji per card. Lead with the headline (total earned vs optimal). If gap is small (<₹100) say "you're optimizing well". If untagged count is high, mention that those txns weren't analysed.`;

    case 'missing_rewards':
      return `${nameCtx}Show the user where they used the wrong card this cycle.

Cycle: ${ctx.cycleLabel}
Total missed value: ₹${ctx.totalMissedInr || 0} across ${ctx.consideredTxnCount} considered txns.
Top misses:
${(ctx.top || []).map(t => `  ${t.date} · ₹${Math.round(t.amount).toLocaleString('en-IN')} ${t.merchant || ''} (${t.category}): used ${t.usedCard}, should have used ${t.shouldHaveUsed} → missed ~₹${t.missedInr}${t.bestRuleNote ? ' [' + t.bestRuleNote.slice(0, 80) + ']' : ''}`).join('\n')}

Format as a punchy WhatsApp message. If top is empty, say "you're optimizing perfectly this cycle". Otherwise lead with the total missed, then a numbered list of the top 3-5. Keep it short.`;

    case 'milestone_progress':
      return `${nameCtx}Show the user's progress toward each card's annual milestone tiers.

YTD window: ${ctx.windowStart} → ${ctx.windowEnd}

${(ctx.cards || []).map(c => `${c.card} — spent ₹${Math.round(c.ytdSpend).toLocaleString('en-IN')} YTD\n${(c.tiers || []).map(t => `  ${t.hit ? '✅' : '⏳'} ₹${Math.round(t.threshold).toLocaleString('en-IN')} → ${t.reward} (${t.progressPct}%${t.hit ? '' : ', ₹' + Math.round(t.remainingInr).toLocaleString('en-IN') + ' to go'})`).join('\n')}`).join('\n\n') || '(no milestone-eligible cards owned)'}

Format as a clean per-card WhatsApp summary. If no milestones, say "none of your cards have spend-based milestone bonuses". For partial progress, highlight the closest unmet tier.`;

    case 'error':
      return `Something went wrong processing the user's message. Apologize briefly and ask them to try again. 1 line.`;

    default:
      return `${nameCtx}Compose a brief, friendly WhatsApp reply for this action: ${actionType}\n\nContext: ${JSON.stringify(ctx)}`;
  }
}

function formatCardTipForPrompt(tip) {
  const grey = tip.greyArea ? ' [grey-area: T&C risk]' : '';
  const note = tip.bestRuleNote ? ' (' + tip.bestRuleNote + ')' : '';
  return `Best card next time: ${tip.bestCard} at ${tip.bestMultiplier}x${note}. Approx upside vs your worst owned card: ₹${tip.upsideInr}.${grey}`;
}

function formatCardTipForReply(tip) {
  const note = tip.bestRuleNote ? ' — ' + tip.bestRuleNote : '';
  const grey = tip.greyArea ? ' _(grey-area)_' : '';
  return `Next time: *${tip.bestCard}* (${tip.bestMultiplier}x)${note} → ~₹${tip.upsideInr} more${grey}`;
}

function formatAnomalyForPrompt(anomaly, amount, category) {
  if (anomaly.type === 'spike') {
    return `₹${Number(amount).toLocaleString('en-IN')} is ${anomaly.multiple}x the usual ${category} amount (avg ₹${anomaly.avg.toLocaleString('en-IN')})`;
  } else if (anomaly.type === 'high') {
    return `₹${Number(amount).toLocaleString('en-IN')} is the largest ever ${category} transaction (prev max ₹${anomaly.prev_max.toLocaleString('en-IN')})`;
  } else if (anomaly.type === 'large') {
    return `₹${Number(amount).toLocaleString('en-IN')} is a large transaction — is this expected?`;
  }
  return '';
}

/**
 * Static fallbacks — moved from server.js hardcoded templates.
 * Used when Claude composition fails.
 */
function getFallback(actionType, ctx) {
  switch (actionType) {
    case 'expense_logged': {
      const merchantLine = ctx.merchant ? ' · ' + ctx.merchant : '';
      let reply =
        getCategoryEmoji(ctx.category) + ' *' + ctx.category + merchantLine + '*\n' +
        '₹' + Number(ctx.amount).toLocaleString('en-IN') +
        (ctx.note ? '  _' + ctx.note + '_' : '') + '\n' +
        '\n' + (ctx.cycleLabel || 'This month') + '   ₹' + ctx.monthlyTotal;
      if (ctx.anomaly) {
        if (ctx.anomaly.type === 'spike') {
          reply += '\n\n⚠️ ' + ctx.anomaly.multiple + 'x your usual ' + ctx.category;
        } else if (ctx.anomaly.type === 'high') {
          reply += '\n\n⚠️ Largest ever ' + ctx.category + ' transaction';
        } else if (ctx.anomaly.type === 'large') {
          reply += '\n\n⚠️ Large transaction — expected?';
        }
      }
      if (ctx.budgetWarning) reply += '\n' + ctx.budgetWarning;
      if (ctx.cardTip) reply += '\n\n💳 ' + formatCardTipForReply(ctx.cardTip);
      return reply;
    }

    case 'expense_low_confidence':
      return '💸 ₹' + Number(ctx.amount).toLocaleString('en-IN') +
        (ctx.merchant ? ' @ ' + ctx.merchant : '') +
        '\n🤔 Not sure (' + ctx.confidence + '%). Pick one:\n\n' +
        ctx.categoryList + '\n\nReply with a number or *cancel*';

    case 'summary_monthly':
      return '*' + (ctx.cycleLabel || 'This month') + '*\n' +
        '₹' + ctx.total + '  (' + ctx.count + ' transactions)\n\n' +
        ctx.breakdown + (ctx.discretionarySplit || '') +
        (ctx.budgetStatus ? '\n\n━━━━━━━━━━━━\n*Budgets*\n' + ctx.budgetStatus : '');

    case 'summary_weekly':
      return '*This Week*\n₹' + ctx.total + '  (' + ctx.count + ' transactions)\n\n' +
        ctx.breakdown + (ctx.discretionarySplit || '');

    case 'undo':
      return '↩️ Removed: ₹' + Number(ctx.amount).toLocaleString('en-IN') + ' — ' + ctx.category +
        (ctx.merchant ? ' @ ' + ctx.merchant : '');

    case 'suggest_budgets':
      return '💡 *Budget Suggestions* (' + ctx.weeksLogged + ' weeks of data)\n\n' + ctx.suggestions;

    case 'suggest_budgets_not_ready':
      return '📊 Not enough data yet — need at least 2 full weeks.\nYou have ' + ctx.weeksLogged + ' week(s) logged. Keep going!';

    case 'salary_set':
      return 'Got it — salary on ' + ctx.label + '. Summaries will now use your real month boundaries.';

    case 'statement_set':
      return 'Saved! Statement dates — ' + ctx.summary + '. I can now help you time big purchases.';

    case 'statement_need_card':
      if (ctx.forPurchaseTiming) return 'I need your statement dates first to give timing advice. Send something like "statement HSBC 5, AMEX 12".';
      if (ctx.day) return 'Which card is that? Try "HSBC ' + ctx.day + '" or "AMEX ' + ctx.day + '".';
      return 'Try "statement HSBC 5" or "statement HSBC 5, AMEX 12".';

    case 'purchase_timing':
      return '*Best time to make a big purchase:*\n\n' + ctx.advice +
        '\n\n*Best card:* ' + ctx.bestCard + ' — ~' + ctx.bestDays + ' interest-free days';

    case 'import_complete':
      return '✅ *' + ctx.count + ' transaction' + (ctx.count > 1 ? 's' : '') + ' imported!*\n\n' +
        '📊 ₹' + ctx.monthlyTotal + '\n' + (ctx.breakdown || '');

    case 'import_none':
      return '✅ All ' + ctx.total + ' transactions already logged! ' + ctx.duplicates + ' duplicate(s) skipped.';

    case 'onboarding_welcome':
      return "Hey! I'm Budgy — your personal expense tracker on WhatsApp.\n\nWhat's your name?";

    case 'onboarding_name_received':
      return 'Nice to meet you, ' + (ctx.name || 'there') + '!\n\nSend me any expense — just type it naturally:\n"lunch 280 Swiggy"   "auto 80"   "groceries 1200"\n\nOr send a receipt photo or bank SMS screenshot 📸\n\n*Shortcuts:*\n• summary — monthly spending\n• this week — weekly breakdown\n• undo — remove last entry\n• suggest budgets — AI budget suggestions\n• export — download CSV\n• create household — track with family';

    case 'setup_cc_ask':
      return (ctx.expenseConfirmation || '') + '\n\nBy the way — do you use any credit cards? I can help you time big purchases for maximum interest-free days 💳\n\n_yes / no_';

    case 'setup_cc_explain':
      return 'Nice! Here\'s why this helps — if you buy right after your statement date, you get ~50 interest-free days vs ~20 if you buy right before.\n\nJust tell me your card names and statement dates, like:\n*HDFC 5, Axis 12*\n\n(The statement date is when your bill generates each month — check your card statement or bank app.)';

    case 'setup_cc_skipped':
      return 'No worries!\n\nQuick question — when does your salary come in? Knowing this helps me track spending by your actual pay cycle.\n\nJust send: *salary 26* or *salary last* or *salary last working day*';

    case 'setup_salary_ask':
      return (ctx.statementConfirmation || 'Statement dates saved!') + '\n\nOne more thing — when does your salary come in? This helps me track your spending by pay cycle.\n\nJust send: *salary 26* or *salary last* or *salary last working day*';

    case 'setup_salary_ask_standalone':
      return (ctx.expenseConfirmation ? ctx.expenseConfirmation + '\n\n' : '') + 'Quick question — when does your salary come in? Knowing this helps me track spending by your actual pay cycle.\n\nJust send: *salary 26* or *salary last* or *salary last working day*';

    case 'help':
      return '👋 Send me:\n' +
        '• "lunch 250 Swiggy" — log expense\n' +
        '• Receipt or bank SMS screenshot 📸\n' +
        '• Bank statement PDF 📄\n' +
        '• summary — monthly total\n' +
        '• this week — weekly breakdown\n' +
        '• suggest budgets — after 2+ weeks of data\n' +
        '• undo — remove last entry\n\n' +
        '🏠 *Household:*\n' +
        '• create household — start a family group\n' +
        '• join <code> — join existing\n' +
        '• my household — see members & settings';

    case 'rewards_report': {
      if (!ctx.cards || ctx.cards.length === 0) {
        return '💳 *Rewards report — ' + (ctx.cycleLabel || 'this cycle') + '*\n\nNo card-tagged transactions yet. Import a CC statement to enable this.';
      }
      const cardLines = ctx.cards.map(c =>
        '💳 *' + c.card + '*: spent ₹' + Math.round(c.totalSpend).toLocaleString('en-IN') +
        ' → earned ~₹' + c.actualValue + ' (' + c.effectiveRatePct + '%) · optimal ~₹' + c.theoreticalValue +
        (c.gap > 0 ? ' · gap ₹' + c.gap : '')
      ).join('\n');
      return '*Rewards report — ' + (ctx.cycleLabel || 'this cycle') + '*\n' +
        ctx.taggedTxnCount + ' tagged · ' + ctx.untaggedTxnCount + ' untagged\n\n' +
        cardLines + '\n\n' +
        '📊 *Total*: earned ~₹' + ctx.totals.actualValue + ' / optimal ~₹' + ctx.totals.theoreticalValue +
        (ctx.totals.gap > 0 ? ' (gap ₹' + ctx.totals.gap + ')' : '');
    }

    case 'missing_rewards': {
      if (!ctx.top || ctx.top.length === 0) {
        return '🏆 *' + (ctx.cycleLabel || 'this cycle') + '* — no significant misses. You\'re using the right cards!';
      }
      const lines = ctx.top.map((t, i) =>
        (i + 1) + '. ' + t.date + ' · ₹' + Math.round(t.amount).toLocaleString('en-IN') +
        ' ' + (t.merchant || t.category) +
        '\n    used *' + t.usedCard + '* → should\'ve used *' + t.shouldHaveUsed + '* (~₹' + t.missedInr + ' more)'
      ).join('\n\n');
      return '⚠️ *Missed rewards — ' + (ctx.cycleLabel || 'this cycle') + '*\n' +
        'Total missed: ~₹' + ctx.totalMissedInr + ' across ' + ctx.consideredTxnCount + ' txns\n\n' +
        lines;
    }

    case 'milestone_progress': {
      if (!ctx.cards || ctx.cards.length === 0) {
        return '🎯 No milestone-eligible cards owned yet, or no tagged spend in the past 365 days.';
      }
      const cardBlocks = ctx.cards.map(c => {
        const tiers = c.tiers.map(t =>
          (t.hit ? '✅' : '⏳') + ' ₹' + Math.round(t.threshold).toLocaleString('en-IN') +
          ' → ' + t.reward + ' (' + t.progressPct + '%' +
          (t.hit ? ')' : ', ₹' + Math.round(t.remainingInr).toLocaleString('en-IN') + ' to go)')
        ).join('\n');
        return '💳 *' + c.card + '* — ₹' + Math.round(c.ytdSpend).toLocaleString('en-IN') + ' YTD\n' + tiers;
      }).join('\n\n');
      return '🎯 *Milestone progress* (' + (ctx.windowStart || '') + ' → ' + (ctx.windowEnd || '') + ')\n\n' + cardBlocks;
    }

    case 'error':
      return '⚠️ Something went wrong. Try again!';

    default:
      return ctx.text || '⚠️ Something went wrong. Try again!';
  }
}

module.exports = { composeResponse, getFallback };

const cron = require('node-cron');
const twilio = require('twilio');
const {
  getMonthlySummary, getWeeklySummary, getOverspendAlerts,
  getBudgetStatus, suggestBudgets, getCategoryEmoji,
  getCyclePaceAnalysis,
  getLastEntryInfo
} = require('./sheets');

const FROM = process.env.TWILIO_WHATSAPP_FROM;
const TO   = process.env.YOUR_WHATSAPP_NUMBER;

// ─── Send text ────────────────────────────────────────────────────────────────
async function sendWhatsApp(body) {
  if (!FROM || !TO) { console.warn('Twilio FROM/TO not configured'); return; }
  const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  await client.messages.create({ from: FROM, to: TO, body });
}

// ─── Send image (chart via QuickChart) ───────────────────────────────────────
async function sendWhatsAppImage(mediaUrl, caption) {
  if (!FROM || !TO) return;
  const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  await client.messages.create({ from: FROM, to: TO, mediaUrl: [mediaUrl], body: caption || '' });
}

// ─── Build QuickChart horizontal bar chart URL ────────────────────────────────
function buildWeeklyChartUrl(byCategory, dateRange) {
  const COMMITTED = new Set(['Rent', 'Loan EMI', 'Investments', 'Family Transfer', 'Utilities', 'Subscriptions', 'Credit Card Payment']);

  const sorted = Object.entries(byCategory)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);

  const labels = sorted.map(function(entry) {
    return entry[0].replace('Credit Card Payment', 'CC Payment').replace('Health & Fitness', 'Health');
  });
  const data   = sorted.map(function(entry) { return Math.round(entry[1]); });
  const colors = sorted.map(function(entry) {
    return COMMITTED.has(entry[0]) ? 'rgba(100,149,237,0.85)' : 'rgba(32,178,170,0.85)';
  });

  const config = {
    type: 'horizontalBar',
    data: {
      labels: labels,
      datasets: [{
        data: data,
        backgroundColor: colors,
        borderWidth: 0
      }]
    },
    options: {
      title: {
        display: true,
        text: 'Weekly Spend — ' + dateRange,
        fontSize: 14,
        fontStyle: 'bold',
        fontColor: '#222'
      },
      legend: { display: false },
      scales: {
        xAxes: [{
          ticks: { beginAtZero: true }
        }],
        yAxes: [{
          ticks: { fontSize: 11 }
        }]
      }
    }
  };

  return 'https://quickchart.io/chart?c=' + encodeURIComponent(JSON.stringify(config)) + '&w=600&h=360&bkg=white';
}

// ─── Daily nudge: random 12–9 PM IST (06:30 UTC trigger) ─────────────────────
function scheduleDailyNudge() {
  cron.schedule('30 6 * * *', async function() {
    var delayMs = Math.floor(Math.random() * 9 * 60 * 60 * 1000);
    console.log('Nudge fires in ' + Math.round(delayMs / 3600000) + 'h');
    setTimeout(async function() {
      try {
        var nudges = [
          "Hey! Any spends today worth logging? Drop me a message!",
          "Quick check-in. How's the wallet today? Log something?",
          "Expense reminder — send me a receipt, bank SMS, or just type it out.",
          "Any receipts piling up? Send them over!",
          "End of day check — any expenses from today to track?"
        ];
        await sendWhatsApp(nudges[Math.floor(Math.random() * nudges.length)]);
        console.log('Daily nudge sent');
      } catch (err) { console.error('Nudge failed:', err.message); }
    }, delayMs);
  }, { timezone: 'UTC' });
  console.log('Daily nudge ready (12-9 PM IST)');
}

// ─── Overspend check: 8 PM IST (14:30 UTC) daily ─────────────────────────────
function scheduleOverspendCheck() {
  cron.schedule('30 14 * * *', async function() {
    try {
      var result = await getOverspendAlerts();
      if (!result) return;
      var lines = result.alerts.map(function(a) {
        return '  ' + getCategoryEmoji(a.category) + ' *' + a.category + '*: Rs.' +
          a.spent.toLocaleString('en-IN') + ' vs Rs.' + a.baseline.toLocaleString('en-IN') +
          ' avg (+' + a.pct + '%)';
      }).join('\n');
      await sendWhatsApp(
        '*Spending Alert* (' + result.weeksOfData + ' weeks of data)\n\nOver baseline in:\n' +
        lines + '\n\nSend *summary* for the full picture.'
      );
    } catch (err) { console.error('Overspend check failed:', err.message); }
  }, { timezone: 'UTC' });
  console.log('Overspend check ready (8 PM IST)');
}

// ─── Smart nudge: 9 AM IST (03:30 UTC) daily ─────────────────────────────────
function scheduleSmartNudge() {
  cron.schedule('30 3 * * *', async function() {
    try {
      var pace = await getCyclePaceAnalysis();

      // Not enough data yet — need a complete previous cycle to baseline against
      if (!pace.ready) {
        console.log('Smart nudge skipped: ' + (pace.reason || 'not ready') + ' (' + pace.cycleProgress + '% through cycle)');
        return;
      }

      var paceRatio = pace.paceRatio;
      var daysUntilPayday = pace.daysUntilPayday;
      var daysElapsed = pace.daysElapsed;

      // Need at least 25% through the cycle (~8 days) for meaningful signal
      if (pace.cycleProgress < 25) {
        console.log('Smart nudge skipped: too early in cycle (' + pace.cycleProgress + '%)');
        return;
      }

      var msg = null;

      if (paceRatio > 1.3 && daysUntilPayday > 10) {
        var overpct = Math.round((paceRatio - 1) * 100);
        var hotLines = pace.hotCategories.length > 0
          ? '\n\nRunning hot in:\n' + pace.hotCategories.map(function(h) {
              return '  ' + getCategoryEmoji(h.cat) + ' ' + h.cat + ': Rs.' +
                h.amt.toLocaleString('en-IN') + ' (+' + h.over + '% vs last cycle)';
            }).join('\n')
          : '';
        var daysMsg = daysUntilPayday === 1 ? 'tomorrow' : 'in ' + daysUntilPayday + ' days';
        msg = 'Hey, quick money check.\n\nYou\'re spending ' + overpct +
          '% faster than usual this cycle (' + pace.cycleProgress + '% through ' + pace.cycleLabel + ').' +
          hotLines + '\n\nPayday is ' + daysMsg + '. Worth slowing down a bit?';

      } else if (paceRatio < 0.9 && daysUntilPayday <= 5) {
        var saved = Math.round(pace.baselineMonthly * (pace.cycleProgress / 100) - pace.discretionaryTotal);
        var daysMsg2 = daysUntilPayday === 1 ? 'tomorrow' : 'in ' + daysUntilPayday + ' days';
        msg = 'Nice work this cycle!\n\nYou\'ve spent Rs.' + pace.discretionaryTotal.toLocaleString('en-IN') +
          ' discretionary vs your usual Rs.' + Math.round(pace.baselineMonthly * pace.cycleProgress / 100).toLocaleString('en-IN') +
          ' by this point — roughly Rs.' + saved.toLocaleString('en-IN') + ' under pace.\n\n' +
          'Payday ' + daysMsg2 + '. Good time to move that surplus to investments before lifestyle creep sneaks in.';

      } else if (paceRatio > 1.15 && daysUntilPayday > 5) {
        var mildPct = Math.round((paceRatio - 1) * 100);
        msg = 'Small heads up — you\'re about ' + mildPct +
          '% ahead of your usual spending pace with ' + daysUntilPayday + ' days until payday.\n\nNothing alarming yet, but worth keeping an eye on.';
      }

      if (msg) {
        await sendWhatsApp(msg);
        console.log('Smart nudge sent (paceRatio: ' + paceRatio.toFixed(2) + ')');
      }
    } catch (err) { console.error('Smart nudge failed:', err.message); }
  }, { timezone: 'UTC' });
  console.log('Smart nudge ready (9 AM IST)');
}

// ─── Friday digest: 7 PM IST (13:30 UTC) ─────────────────────────────────────
function scheduleFridayDigest() {
  cron.schedule('30 13 * * 5', async function() {
    try {
      var weekly  = await getWeeklySummary();
      var monthly = await getMonthlySummary();
      var budgetSuggestion = await suggestBudgets();

      var now = new Date();
      var weekStart = new Date(now);
      weekStart.setDate(now.getDate() - now.getDay());
      var dateRange =
        weekStart.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) +
        ' - ' +
        now.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });

      // 1. Chart image — weekly category breakdown
      if (Object.keys(weekly.byCategory).length > 0) {
        try {
          var chartUrl = buildWeeklyChartUrl(weekly.byCategory, dateRange);
          await sendWhatsAppImage(chartUrl, '');
          console.log('Chart sent');
        } catch (chartErr) {
          console.error('Chart failed, skipping:', chartErr.message);
        }
      }

      // 2. Text digest
      var msg =
        '*Weekly Digest — ' + dateRange + '*\n\n' +
        '*This week: Rs.' + weekly.total + '* (' + weekly.count + ' transactions)\n' +
        weekly.breakdown + '\n' +
        weekly.discretionarySplit + '\n\n' +
        '*' + (monthly.cycleLabel || getMonthName()) + ' so far: Rs.' + monthly.total + '*\n' +
        monthly.breakdown;

      // Tip
      var topDisc = getTopDiscretionaryCategory(weekly.byCategory);
      if (topDisc) {
        msg += '\n\nTip: Biggest discretionary spend this week — *' + topDisc.category +
          '* at Rs.' + Math.round(topDisc.amount).toLocaleString('en-IN') + '. Small cuts here add up.';
      }

      // Auto budget suggestion at exactly 2 weeks
      if (budgetSuggestion.ready && budgetSuggestion.weeksLogged === 2) {
        var suggLines = budgetSuggestion.suggestions.map(function(s) {
          var tag = s.committed ? ' (committed)' : '';
          return getCategoryEmoji(s.category) + ' *' + s.category + tag + '*\n' +
            '  Avg: Rs.' + s.avgMonthly.toLocaleString('en-IN') +
            '/mo  Suggested: Rs.' + s.suggested.toLocaleString('en-IN') + '/mo';
        }).join('\n\n');
        msg += '\n\n' +
          '*You now have 2 weeks of data!*\n' +
          'Suggested budgets (10% below your run-rate):\n\n' +
          suggLines + '\n\nReply *suggest budgets* anytime to see this again.';
      }

      await sendWhatsApp(msg);
      console.log('Friday digest sent');
    } catch (err) { console.error('Friday digest failed:', err.message); }
  }, { timezone: 'UTC' });
  console.log('Friday digest ready (7 PM IST)');
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getTopDiscretionaryCategory(byCategory) {
  var COMMITTED = new Set(['Rent', 'Loan EMI', 'Investments', 'Family Transfer', 'Utilities', 'Subscriptions', 'Credit Card Payment']);
  var disc = Object.entries(byCategory || {})
    .filter(function(e) { return !COMMITTED.has(e[0]); })
    .sort(function(a, b) { return b[1] - a[1]; });
  return disc.length > 0 ? { category: disc[0][0], amount: disc[0][1] } : null;
}

function getMonthName() {
  return new Date().toLocaleString('en-IN', { month: 'long' });
}

module.exports = { scheduleDailyNudge, scheduleOverspendCheck, scheduleFridayDigest, scheduleSmartNudge, scheduleEveningCheckIn, scheduleMorningFollowUp, scheduleLapseNudge, schedulePreStatementNudge, sendWhatsApp };

// ─── Evening check-in: 8 PM IST (14:30 UTC) ──────────────────────────────────
function scheduleEveningCheckIn() {
  cron.schedule('30 14 * * *', async function() {
    try {
      var info = await getLastEntryInfo();
      if (!info.hasEntries || info.daysAgo >= 7) return;
      if (info.todayCount > 0) { console.log('Evening check-in skipped: logged today'); return; }
      var msgs = [
        "Hey, anything to log from today? Even a quick auto ride counts.",
        "How'd the wallet do today? Takes 10 seconds — just type it out.",
        "Quiet day spend-wise, or just forgot to log? Either way, drop me a message.",
        "End of day check — any expenses hiding in your memory?",
        "Quick one — anything to track from today before it slips your mind?",
        "Today still blank. Worth a quick log before you call it a night?",
      ];
      await sendWhatsApp(msgs[Math.floor(Math.random() * msgs.length)]);
      console.log('Evening check-in sent');
    } catch (err) { console.error('Evening check-in failed:', err.message); }
  }, { timezone: 'UTC' });
  console.log('Evening check-in ready (8 PM IST)');
}

// ─── Morning follow-up: 9 AM IST (03:30 UTC) ─────────────────────────────────
function scheduleMorningFollowUp() {
  cron.schedule('35 3 * * *', async function() {
    try {
      var info = await getLastEntryInfo();
      if (!info.hasEntries || info.daysAgo === 0) return;
      if (info.yesterdayCount > 0) { console.log('Morning follow-up skipped: yesterday had entries'); return; }
      if (info.daysAgo < 1 || info.daysAgo >= 3) return;
      var msgs = [
        "Morning! Yesterday's expenses are still missing — anything you remember? Even a rough total helps.",
        "Yesterday's a blank in your tracker. Want to add anything before it fades completely?",
        "Hey — nothing logged from yesterday. Drop me anything you remember and I'll sort it.",
        "Quick morning check — yesterday still empty. Even one or two entries keeps the picture clear.",
      ];
      await sendWhatsApp(msgs[Math.floor(Math.random() * msgs.length)]);
      console.log('Morning follow-up sent');
    } catch (err) { console.error('Morning follow-up failed:', err.message); }
  }, { timezone: 'UTC' });
  console.log('Morning follow-up ready (9 AM IST)');
}

// ─── Lapse nudge: 10 AM IST (04:30 UTC), fires once at 3-day mark ────────────
function scheduleLapseNudge() {
  cron.schedule('30 4 * * *', async function() {
    try {
      var info = await getLastEntryInfo();
      if (!info.hasEntries || info.daysAgo !== 3) return;
      var msgs = [
        "Hey, it's been a few days since your last log. No stress — even catching up on the big ones keeps the picture clear.",
        "Three days without a log. Totally fine — life gets busy. Just type anything and we'll pick up from there.",
        "Your spending story has a gap. No pressure to backfill everything — even one entry gets things moving again.",
        "Been quiet for a few days! Any big spends worth adding? Otherwise just start fresh from today.",
      ];
      await sendWhatsApp(msgs[Math.floor(Math.random() * msgs.length)]);
      console.log('Lapse nudge sent (3 days of silence)');
    } catch (err) { console.error('Lapse nudge failed:', err.message); }
  }, { timezone: 'UTC' });
  console.log('Lapse nudge ready (10 AM IST, fires at 3-day mark)');
}

// ─── Pre-statement nudge: 9 AM IST (03:30 UTC) daily ─────────────────────────
// Fires 2 days before any user's CC statement generates
function schedulePreStatementNudge() {
  cron.schedule('35 3 * * *', async function() {
    try {
      const { getAllUsers } = require('./sheets');
      const users = await getAllUsers();
      const today = new Date();
      const targetDay = today.getDate() + 2; // 2 days from now

      for (const user of users) {
        if (!user.phone || !user.statementDates) continue;
        const dates = user.statementDates;

        for (const [card, day] of Object.entries(dates)) {
          if (day !== targetDay) continue;

          // This user's statement generates in 2 days
          const daysIfWait = 50; // approx max interest-free if they buy after
          const daysIfNow = 20;  // approx days left if they buy today

          const msgs = [
            'Heads up — your ' + card + ' statement generates in 2 days (on the ' + day + 'th).\n\nIf you have a big purchase coming up, waiting till after the ' + day + 'th gives you ~' + daysIfWait + ' interest-free days instead of ~' + daysIfNow + '.',
            'Your ' + card + ' billing cycle closes in 2 days.\n\nPlanning a big purchase? Waiting till after the ' + day + 'th maximises your interest-free window to ~' + daysIfWait + ' days.',
            card + ' statement in 2 days. Any large spend planned? Hold off till the ' + (day + 1) + 'th and you get the full ~' + daysIfWait + '-day interest-free period.',
          ];
          const msg = msgs[Math.floor(Math.random() * msgs.length)];

          // Send to this user's number
          if (!FROM || !user.phone) continue;
          const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
          await client.messages.create({ from: FROM, to: user.phone, body: msg });
          console.log('Pre-statement nudge sent to ' + user.phone + ' for ' + card);
        }
      }
    } catch (err) { console.error('Pre-statement nudge failed:', err.message); }
  }, { timezone: 'UTC' });
  console.log('Pre-statement nudge ready (fires 2 days before each CC statement)');
}

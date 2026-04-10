const cron = require('node-cron');
const { getCategoryEmoji, isCommitted, getMonthName } = require('./constants');
const {
  getMonthlySummary, getWeeklySummary, getOverspendAlerts,
  getBudgetStatus, suggestBudgets,
  getCyclePaceAnalysis,
  getLastEntryInfo,
  getAllUsers
} = require('./sheets');
const { sendWhatsAppTo, sendWhatsAppBroadcast, sendWhatsAppImageBroadcast } = require('./messaging');

// ─── Build QuickChart horizontal bar chart URL ────────────────────────────────
function buildWeeklyChartUrl(byCategory, dateRange) {
  const sorted = Object.entries(byCategory)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);

  const labels = sorted.map(function(entry) {
    return entry[0].replace('Credit Card Payment', 'CC Payment').replace('Health & Fitness', 'Health');
  });
  const data   = sorted.map(function(entry) { return Math.round(entry[1]); });
  const colors = sorted.map(function(entry) {
    return isCommitted(entry[0]) ? 'rgba(100,149,237,0.85)' : 'rgba(32,178,170,0.85)';
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

// ─── Build weekly digest (text + chart URL) ─────────────────────────────────
async function buildWeeklyDigest() {
  const weekly = await getWeeklySummary();

  const now = new Date();
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - now.getDay());
  const dateRange =
    weekStart.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) +
    ' - ' +
    now.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });

  const text =
    '*Weekly Digest — ' + dateRange + '*\n\n' +
    '*This week: ₹' + weekly.total + '* (' + weekly.count + ' transactions)\n' +
    weekly.breakdown + '\n' +
    weekly.discretionarySplit;

  let chartUrl = null;
  if (Object.keys(weekly.byCategory).length > 0) {
    try {
      chartUrl = buildWeeklyChartUrl(weekly.byCategory, dateRange);
    } catch (err) {
      console.error('Chart URL build failed:', err.message);
    }
  }

  return { text, chartUrl };
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
        await sendWhatsAppBroadcast(nudges[Math.floor(Math.random() * nudges.length)], getAllUsers);
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
      await sendWhatsAppBroadcast(
        '*Spending Alert* (' + result.weeksOfData + ' weeks of data)\n\nOver baseline in:\n' +
        lines + '\n\nSend *summary* for the full picture.',
        getAllUsers
      );
    } catch (err) { console.error('Overspend check failed:', err.message); }
  }, { timezone: 'UTC' });
  console.log('Overspend check ready (8 PM IST)');
}

// ─── Smart nudge helper: build personalized message for one user ──────────────
async function buildSmartNudgeForUser(phone) {
  var pace = getCyclePaceAnalysis(phone);
  if (pace.then) pace = await pace; // handle async

  var proj = pace.projection;
  var comp = pace.comparison;

  // Need at least 25% through cycle (~8 days) for meaningful projection
  if (pace.cycleProgress < 25) return null;
  if (proj.dailyRate === 0) return null;

  var daysUntilPayday = pace.daysUntilPayday;

  // ── With comparison baseline ──
  if (comp && comp.paceRatio <= 10) {
    var paceRatio = comp.paceRatio;

    if (paceRatio > 1.3 && daysUntilPayday > 10) {
      var msg = 'Quick money check.\n\n' +
        'You\'re spending Rs.' + proj.dailyRate.toLocaleString('en-IN') + '/day on discretionary stuff. ' +
        'At this rate, you\'ll hit *Rs.' + proj.projectedTotal.toLocaleString('en-IN') + '* by payday.\n\n' +
        'Last cycle was Rs.' + comp.baselineMonthly.toLocaleString('en-IN') + ' total (Rs.' + comp.baselineDaily.toLocaleString('en-IN') + '/day).';

      if (comp.hotCategories.length > 0) {
        msg += '\n\nBiggest movers:\n' + comp.hotCategories.map(function(h) {
          return '  ' + getCategoryEmoji(h.cat) + ' ' + h.cat + ': Rs.' + h.daily.toLocaleString('en-IN') + '/day vs Rs.' + h.prevDaily.toLocaleString('en-IN') + ' last cycle';
        }).join('\n');
      }

      msg += '\n\nPayday ' + (daysUntilPayday === 1 ? 'tomorrow' : 'in ' + daysUntilPayday + ' days') + '.';
      return msg;

    } else if (paceRatio < 0.9 && daysUntilPayday <= 5) {
      var saved = Math.round(comp.baselineMonthly * (pace.cycleProgress / 100) - pace.discretionaryTotal);
      return 'Nice work this cycle.\n\n' +
        'Rs.' + proj.dailyRate.toLocaleString('en-IN') + '/day vs Rs.' + comp.baselineDaily.toLocaleString('en-IN') + ' last cycle. ' +
        'You\'re roughly Rs.' + saved.toLocaleString('en-IN') + ' under your usual pace.\n\n' +
        'Payday ' + (daysUntilPayday === 1 ? 'tomorrow' : 'in ' + daysUntilPayday + ' days') + '. Good time to sweep the surplus into investments.';

    } else if (paceRatio > 1.15 && daysUntilPayday > 5) {
      return 'Small heads up.\n\n' +
        'Running at Rs.' + proj.dailyRate.toLocaleString('en-IN') + '/day vs Rs.' + comp.baselineDaily.toLocaleString('en-IN') + ' last cycle. ' +
        'Projected *Rs.' + proj.projectedTotal.toLocaleString('en-IN') + '* by payday (last cycle: Rs.' + comp.baselineMonthly.toLocaleString('en-IN') + ').\n\n' +
        'Nothing alarming — ' + daysUntilPayday + ' days to go.';
    }
  }

  // ── No comparison — projection-only, send on Wednesdays ──
  if (new Date().getDay() === 3) {
    var topLine = proj.topCategories.length > 0
      ? '\n\nTop categories:\n' + proj.topCategories.map(function(c) {
          return '  ' + getCategoryEmoji(c.cat) + ' ' + c.cat + ': Rs.' + c.amt.toLocaleString('en-IN') + ' (Rs.' + c.daily.toLocaleString('en-IN') + '/day)';
        }).join('\n')
      : '';
    return 'Midweek check-in.\n\n' +
      'You\'re at Rs.' + pace.discretionaryTotal.toLocaleString('en-IN') + ' discretionary so far (' + pace.cycleProgress + '% through ' + pace.cycleLabel + ').\n' +
      'At Rs.' + proj.dailyRate.toLocaleString('en-IN') + '/day, you\'ll land around *Rs.' + proj.projectedTotal.toLocaleString('en-IN') + '* by payday.' +
      topLine;
  }

  return null;
}

// ─── Smart nudge: 9 AM IST (03:30 UTC) daily ─────────────────────────────────
function scheduleSmartNudge() {
  cron.schedule('30 3 * * *', async function() {
    try {
      var users = await getAllUsers();
      for (var u = 0; u < users.length; u++) {
        var user = users[u];
        if (!user.phone) continue;
        try {
          var msg = await buildSmartNudgeForUser(user.phone);
          if (msg) {
            await sendWhatsAppTo(user.phone, msg);
            console.log('Smart nudge sent to ' + user.phone);
          }
        } catch (userErr) {
          console.error('Smart nudge failed for ' + user.phone + ':', userErr.message);
        }
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
          await sendWhatsAppImageBroadcast(chartUrl, '', getAllUsers);
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

      await sendWhatsAppBroadcast(msg, getAllUsers);
      console.log('Friday digest sent');
    } catch (err) { console.error('Friday digest failed:', err.message); }
  }, { timezone: 'UTC' });
  console.log('Friday digest ready (7 PM IST)');
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getTopDiscretionaryCategory(byCategory) {
  var disc = Object.entries(byCategory || {})
    .filter(function(e) { return !isCommitted(e[0]); })
    .sort(function(a, b) { return b[1] - a[1]; });
  return disc.length > 0 ? { category: disc[0][0], amount: disc[0][1] } : null;
}

module.exports = { scheduleDailyNudge, scheduleOverspendCheck, scheduleFridayDigest, scheduleSmartNudge, scheduleEveningCheckIn, scheduleMorningFollowUp, scheduleLapseNudge, schedulePreStatementNudge, buildWeeklyDigest, buildWeeklyChartUrl, getTopDiscretionaryCategory };

// ─── Evening check-in: 8 PM IST (14:30 UTC) ──────────────────────────────────
function scheduleEveningCheckIn() {
  cron.schedule('45 14 * * *', async function() {
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
      await sendWhatsAppBroadcast(msgs[Math.floor(Math.random() * msgs.length)], getAllUsers);
      console.log('Evening check-in sent');
    } catch (err) { console.error('Evening check-in failed:', err.message); }
  }, { timezone: 'UTC' });
  console.log('Evening check-in ready (8:15 PM IST)');
}

// ─── Morning follow-up: 9 AM IST (03:30 UTC) ─────────────────────────────────
function scheduleMorningFollowUp() {
  cron.schedule('40 3 * * *', async function() {
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
      await sendWhatsAppBroadcast(msgs[Math.floor(Math.random() * msgs.length)], getAllUsers);
      console.log('Morning follow-up sent');
    } catch (err) { console.error('Morning follow-up failed:', err.message); }
  }, { timezone: 'UTC' });
  console.log('Morning follow-up ready (9:10 AM IST)');
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
      await sendWhatsAppBroadcast(msgs[Math.floor(Math.random() * msgs.length)], getAllUsers);
      console.log('Lapse nudge sent (3 days of silence)');
    } catch (err) { console.error('Lapse nudge failed:', err.message); }
  }, { timezone: 'UTC' });
  console.log('Lapse nudge ready (10 AM IST, fires at 3-day mark)');
}

// ─── Pre-statement nudge: 9 AM IST (03:30 UTC) daily ─────────────────────────
// Fires 2 days before any user's CC statement generates
function schedulePreStatementNudge() {
  cron.schedule('50 3 * * *', async function() {
    try {
      const users = await getAllUsers();
      const today = new Date();
      const targetDate = new Date(today);
      targetDate.setDate(today.getDate() + 2);
      const targetDay = targetDate.getDate();

      for (const user of users) {
        if (!user.phone || !user.statementDates) continue;
        const dates = user.statementDates;

        for (const [card, day] of Object.entries(dates)) {
          if (day !== targetDay) continue;
          const daysIfWait = 50;
          const daysIfNow = 20;

          const msgs = [
            'Heads up — your ' + card + ' statement generates in 2 days (on the ' + day + 'th).\n\nIf you have a big purchase coming up, waiting till after the ' + day + 'th gives you ~' + daysIfWait + ' interest-free days instead of ~' + daysIfNow + '.',
            'Your ' + card + ' billing cycle closes in 2 days.\n\nPlanning a big purchase? Waiting till after the ' + day + 'th maximises your interest-free window to ~' + daysIfWait + ' days.',
            card + ' statement in 2 days. Any large spend planned? Hold off till the ' + (day + 1) + 'th and you get the full ~' + daysIfWait + '-day interest-free period.',
          ];
          const msg = msgs[Math.floor(Math.random() * msgs.length)];

          try {
            await sendWhatsAppTo(user.phone, msg);
            console.log('Pre-statement nudge sent to ' + user.phone + ' for ' + card);
          } catch (err) {
            console.error('Pre-statement nudge failed for ' + user.phone + ':', err.message);
          }
        }
      }
    } catch (err) { console.error('Pre-statement nudge failed:', err.message); }
  }, { timezone: 'UTC' });
  console.log('Pre-statement nudge ready (9:20 AM IST, fires 2 days before each CC statement)');
}

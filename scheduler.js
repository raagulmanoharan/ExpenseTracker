const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const { getCategoryEmoji, isCommitted, getMonthName } = require('./constants');
const {
  getMonthlySummary, getWeeklySummary, getOverspendAlerts,
  getBudgetStatus, suggestBudgets,
  getCyclePaceAnalysis,
  getLastEntryInfo,
  getAllUsers
} = require('./sheets');
const { sendWhatsAppTo, sendWhatsAppImageBroadcast } = require('./messaging');

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

// ═══════════════════════════════════════════════════════════════════════════════
// HEARTBEAT ENGINE — single cron, rotating checks, cadence + time windows
// Inspired by OpenClaw's heartbeat pattern
// ═══════════════════════════════════════════════════════════════════════════════

// Persistent state: { "nudgeId:phone" => Date }
// Survives server restarts via JSON file on disk
const STATE_FILE = path.join(__dirname, '.heartbeat-state.json');
const heartbeatState = new Map();

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    for (const [key, iso] of Object.entries(raw)) {
      heartbeatState.set(key, new Date(iso));
    }
    console.log('[heartbeat] Loaded ' + heartbeatState.size + ' state entries from disk');
  } catch (err) {
    console.error('[heartbeat] Failed to load state, starting fresh:', err.message);
  }
}

function saveState() {
  try {
    const obj = {};
    for (const [key, date] of heartbeatState) {
      obj[key] = date.toISOString();
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify(obj), 'utf8');
  } catch (err) {
    console.error('[heartbeat] Failed to save state:', err.message);
  }
}

function getStateKey(nudgeId, phone) {
  return nudgeId + ':' + phone;
}

function getLastSent(nudgeId, phone) {
  return heartbeatState.get(getStateKey(nudgeId, phone)) || null;
}

function markSent(nudgeId, phone) {
  heartbeatState.set(getStateKey(nudgeId, phone), new Date());
  saveState();
}

// How overdue is this nudge? Returns hours overdue (negative = not due yet)
function getOverdueHours(nudgeId, phone, cadenceHours) {
  const last = getLastSent(nudgeId, phone);
  if (!last) return cadenceHours; // never sent = fully overdue
  const hoursSince = (Date.now() - last.getTime()) / (1000 * 60 * 60);
  return hoursSince - cadenceHours;
}

// Is the current IST hour within the nudge's time window?
function isInTimeWindow(windowStart, windowEnd) {
  const now = new Date();
  const istHour = (now.getUTCHours() + 5 + (now.getUTCMinutes() >= 30 ? 1 : 0)) % 24;
  // Handle the half-hour offset more precisely
  const istMinutes = (now.getUTCHours() * 60 + now.getUTCMinutes() + 330) % 1440;
  const istH = Math.floor(istMinutes / 60);
  if (windowStart <= windowEnd) {
    return istH >= windowStart && istH < windowEnd;
  }
  // Wraps midnight
  return istH >= windowStart || istH < windowEnd;
}

// Get current IST day of week (0=Sun, 5=Fri, 6=Sat)
function getISTDayOfWeek() {
  const now = new Date();
  const istMs = now.getTime() + (330 * 60 * 1000);
  return new Date(istMs).getUTCDay();
}

// ─── Smart nudge: projection-based spending insight ──────────────────────────
async function buildSmartNudgeForUser(phone) {
  var pace = getCyclePaceAnalysis(phone);
  if (pace.then) pace = await pace;

  var proj = pace.projection;
  var comp = pace.comparison;

  if (pace.cycleProgress < 25) return null;
  if (proj.dailyRate === 0) return null;

  var daysUntilPayday = pace.daysUntilPayday;

  // With comparison baseline
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

  // No comparison — Wednesday midweek check-in only
  if (getISTDayOfWeek() === 3) {
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

// ─── Helpers ─────────────────────────────────────────────────────────────────
function getTopDiscretionaryCategory(byCategory) {
  var disc = Object.entries(byCategory || {})
    .filter(function(e) { return !isCommitted(e[0]); })
    .sort(function(a, b) { return b[1] - a[1]; });
  return disc.length > 0 ? { category: disc[0][0], amount: disc[0][1] } : null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// NUDGE DEFINITIONS — each is a check with cadence, time window, condition
// ═══════════════════════════════════════════════════════════════════════════════

const NUDGE_CHECKS = [
  {
    id: 'smart_nudge',
    description: 'Projection-based spending insight',
    cadenceHours: 24,
    windowStart: 9,   // 9 AM IST
    windowEnd: 10,
    priority: 10,      // highest — most valuable signal
    check: async function(user) {
      if (!user.phone) return null;
      return await buildSmartNudgeForUser(user.phone);
    }
  },
  {
    id: 'morning_followup',
    description: 'Yesterday was blank — catch up',
    cadenceHours: 24,
    windowStart: 9,
    windowEnd: 10,
    priority: 8,
    check: async function(user) {
      var info = await getLastEntryInfo();
      if (!info.hasEntries || info.daysAgo === 0) return null;
      if (info.yesterdayCount > 0) return null;
      if (info.daysAgo < 1 || info.daysAgo >= 3) return null;
      var msgs = [
        "Morning! Yesterday's expenses are still missing — anything you remember? Even a rough total helps.",
        "Yesterday's a blank in your tracker. Want to add anything before it fades completely?",
        "Hey — nothing logged from yesterday. Drop me anything you remember and I'll sort it.",
        "Quick morning check — yesterday still empty. Even one or two entries keeps the picture clear.",
      ];
      return msgs[Math.floor(Math.random() * msgs.length)];
    }
  },
  {
    id: 'pre_statement',
    description: 'CC statement generates in 2 days',
    cadenceHours: 24,
    windowStart: 9,
    windowEnd: 10,
    priority: 9,       // time-sensitive financial advice
    perUser: true,      // needs user-specific data (statement dates)
    check: async function(user) {
      if (!user.phone || !user.statementDates) return null;
      const today = new Date();
      const targetDate = new Date(today);
      targetDate.setDate(today.getDate() + 2);
      const targetDay = targetDate.getDate();
      const dates = user.statementDates;
      const results = [];

      for (const [card, day] of Object.entries(dates)) {
        if (day !== targetDay) continue;
        const daysIfWait = 50;
        const daysIfNow = 20;
        const msgs = [
          'Heads up — your ' + card + ' statement generates in 2 days (on the ' + day + 'th).\n\nIf you have a big purchase coming up, waiting till after the ' + day + 'th gives you ~' + daysIfWait + ' interest-free days instead of ~' + daysIfNow + '.',
          'Your ' + card + ' billing cycle closes in 2 days.\n\nPlanning a big purchase? Waiting till after the ' + day + 'th maximises your interest-free window to ~' + daysIfWait + ' days.',
          card + ' statement in 2 days. Any large spend planned? Hold off till the ' + (day + 1) + 'th and you get the full ~' + daysIfWait + '-day interest-free period.',
        ];
        results.push(msgs[Math.floor(Math.random() * msgs.length)]);
      }

      return results.length > 0 ? results.join('\n\n') : null;
    }
  },
  {
    id: 'lapse_nudge',
    description: '3 days without logging',
    cadenceHours: 24,
    windowStart: 10,
    windowEnd: 11,
    priority: 7,
    check: async function() {
      var info = await getLastEntryInfo();
      if (!info.hasEntries || info.daysAgo !== 3) return null;
      var msgs = [
        "Hey, it's been a few days since your last log. No stress — even catching up on the big ones keeps the picture clear.",
        "Three days without a log. Totally fine — life gets busy. Just type anything and we'll pick up from there.",
        "Your spending story has a gap. No pressure to backfill everything — even one entry gets things moving again.",
        "Been quiet for a few days! Any big spends worth adding? Otherwise just start fresh from today.",
      ];
      return msgs[Math.floor(Math.random() * msgs.length)];
    }
  },
  {
    id: 'daily_nudge',
    description: 'Random midday reminder to log',
    cadenceHours: 24,
    windowStart: 12,   // 12 PM IST
    windowEnd: 21,     // 9 PM IST — wide window, acts like the old random delay
    priority: 3,       // lowest — generic reminder
    check: async function() {
      var nudges = [
        "Hey! Any spends today worth logging? Drop me a message!",
        "Quick check-in. How's the wallet today? Log something?",
        "Expense reminder — send me a receipt, bank SMS, or just type it out.",
        "Any receipts piling up? Send them over!",
        "End of day check — any expenses from today to track?"
      ];
      return nudges[Math.floor(Math.random() * nudges.length)];
    }
  },
  {
    id: 'friday_digest',
    description: 'Weekly summary with chart',
    cadenceHours: 168,  // weekly
    windowStart: 19,    // 7 PM IST
    windowEnd: 20,
    priority: 10,
    dayOfWeek: 5,       // Friday only
    broadcast: true,    // sends to all users, not per-user
    check: async function(user, allUsers) {
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

      // Send chart image first
      if (Object.keys(weekly.byCategory).length > 0) {
        try {
          var chartUrl = buildWeeklyChartUrl(weekly.byCategory, dateRange);
          await sendWhatsAppImageBroadcast(chartUrl, '', async () => allUsers);
          console.log('[heartbeat] Chart sent');
        } catch (chartErr) {
          console.error('[heartbeat] Chart failed:', chartErr.message);
        }
      }

      // Build text digest
      var msg =
        '*Weekly Digest — ' + dateRange + '*\n\n' +
        '*This week: Rs.' + weekly.total + '* (' + weekly.count + ' transactions)\n' +
        weekly.breakdown + '\n' +
        weekly.discretionarySplit + '\n\n' +
        '*' + (monthly.cycleLabel || getMonthName()) + ' so far: Rs.' + monthly.total + '*\n' +
        monthly.breakdown;

      var topDisc = getTopDiscretionaryCategory(weekly.byCategory);
      if (topDisc) {
        msg += '\n\nTip: Biggest discretionary spend this week — *' + topDisc.category +
          '* at Rs.' + Math.round(topDisc.amount).toLocaleString('en-IN') + '. Small cuts here add up.';
      }

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

      return msg;
    }
  },
  {
    id: 'overspend_alert',
    description: 'Spending over baseline categories',
    cadenceHours: 24,
    windowStart: 20,   // 8 PM IST
    windowEnd: 21,
    priority: 9,
    broadcast: true,
    check: async function() {
      var result = await getOverspendAlerts();
      if (!result) return null;
      var lines = result.alerts.map(function(a) {
        return '  ' + getCategoryEmoji(a.category) + ' *' + a.category + '*: Rs.' +
          a.spent.toLocaleString('en-IN') + ' vs Rs.' + a.baseline.toLocaleString('en-IN') +
          ' avg (+' + a.pct + '%)';
      }).join('\n');
      return '*Spending Alert* (' + result.weeksOfData + ' weeks of data)\n\nOver baseline in:\n' +
        lines + '\n\nSend *summary* for the full picture.';
    }
  },
  {
    id: 'evening_checkin',
    description: 'End of day — logged anything today?',
    cadenceHours: 24,
    windowStart: 20,   // 8 PM IST
    windowEnd: 21,
    priority: 5,
    check: async function() {
      var info = await getLastEntryInfo();
      if (!info.hasEntries || info.daysAgo >= 7) return null;
      if (info.todayCount > 0) return null;
      var msgs = [
        "Hey, anything to log from today? Even a quick auto ride counts.",
        "How'd the wallet do today? Takes 10 seconds — just type it out.",
        "Quiet day spend-wise, or just forgot to log? Either way, drop me a message.",
        "End of day check — any expenses hiding in your memory?",
        "Quick one — anything to track from today before it slips your mind?",
        "Today still blank. Worth a quick log before you call it a night?",
      ];
      return msgs[Math.floor(Math.random() * msgs.length)];
    }
  }
];

// ═══════════════════════════════════════════════════════════════════════════════
// HEARTBEAT TICK — runs every 30 minutes, picks the most overdue check per user
// ═══════════════════════════════════════════════════════════════════════════════

async function heartbeatTick() {
  const tickStart = Date.now();
  console.log('[heartbeat] tick at ' + new Date().toISOString());

  try {
    const users = await getAllUsers();
    if (!users || users.length === 0) {
      console.log('[heartbeat] no users, skipping');
      return;
    }

    // 1. Run broadcast checks first (send once to all users)
    for (const nudge of NUDGE_CHECKS) {
      if (!nudge.broadcast) continue;
      if (!isInTimeWindow(nudge.windowStart, nudge.windowEnd)) continue;
      if (nudge.dayOfWeek !== undefined && getISTDayOfWeek() !== nudge.dayOfWeek) continue;

      // Use first user phone as broadcast state key
      const statePhone = '_broadcast';
      const overdueHrs = getOverdueHours(nudge.id, statePhone, nudge.cadenceHours);
      if (overdueHrs < 0) continue;

      try {
        const msg = await nudge.check(null, users);
        if (msg) {
          for (const user of users) {
            if (!user.phone) continue;
            try {
              await sendWhatsAppTo(user.phone, msg);
            } catch (err) {
              console.error('[heartbeat] ' + nudge.id + ' send failed for ' + user.phone + ':', err.message);
            }
          }
          markSent(nudge.id, statePhone);
          console.log('[heartbeat] ' + nudge.id + ' broadcast sent');
        }
      } catch (err) {
        console.error('[heartbeat] ' + nudge.id + ' check failed:', err.message);
      }
    }

    // 2. Per-user checks — pick the single most overdue nudge for each user
    const perUserChecks = NUDGE_CHECKS.filter(function(n) { return !n.broadcast; });

    for (const user of users) {
      if (!user.phone) continue;

      // Find eligible checks: in time window, day matches, overdue
      var bestNudge = null;
      var bestOverdue = -Infinity;

      for (const nudge of perUserChecks) {
        if (!isInTimeWindow(nudge.windowStart, nudge.windowEnd)) continue;
        if (nudge.dayOfWeek !== undefined && getISTDayOfWeek() !== nudge.dayOfWeek) continue;

        var overdueHrs = getOverdueHours(nudge.id, user.phone, nudge.cadenceHours);
        if (overdueHrs < 0) continue;

        // Score: overdue hours * priority weight
        var score = overdueHrs * nudge.priority;
        if (score > bestOverdue) {
          bestOverdue = score;
          bestNudge = nudge;
        }
      }

      if (!bestNudge) continue;

      try {
        var msg = await bestNudge.check(user);
        if (msg) {
          await sendWhatsAppTo(user.phone, msg);
          markSent(bestNudge.id, user.phone);
          console.log('[heartbeat] ' + bestNudge.id + ' sent to ' + user.phone);
        } else {
          // Check returned null (not actionable) — mark as checked so we don't
          // keep re-evaluating it every 30 min. Use shorter cooldown.
          markSent(bestNudge.id, user.phone);
        }
      } catch (err) {
        console.error('[heartbeat] ' + bestNudge.id + ' failed for ' + user.phone + ':', err.message);
      }
    }
  } catch (err) {
    console.error('[heartbeat] tick failed:', err.message);
  }

  const elapsed = Date.now() - tickStart;
  console.log('[heartbeat] tick done in ' + elapsed + 'ms');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SCHEDULER — single entry point replaces all individual schedule* functions
// ═══════════════════════════════════════════════════════════════════════════════

function scheduleHeartbeat() {
  loadState();
  // Run every 30 minutes
  cron.schedule('*/30 * * * *', heartbeatTick, { timezone: 'UTC' });
  console.log('[heartbeat] Scheduled — ticking every 30 min');
  console.log('[heartbeat] ' + NUDGE_CHECKS.length + ' checks registered:');
  NUDGE_CHECKS.forEach(function(n) {
    console.log('  ' + n.id + ' — ' + n.description + ' (every ' + n.cadenceHours + 'h, ' + n.windowStart + '-' + n.windowEnd + ' IST, priority ' + n.priority + ')');
  });
}

module.exports = {
  scheduleHeartbeat,
  // Pure functions still used by server.js
  buildWeeklyDigest,
  buildWeeklyChartUrl,
  getTopDiscretionaryCategory,
  buildSmartNudgeForUser,
  // Exposed for testing
  heartbeatTick,
  heartbeatState,
  NUDGE_CHECKS,
  isInTimeWindow,
  getOverdueHours,
  loadState,
  saveState
};

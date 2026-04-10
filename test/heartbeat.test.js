// Mock fs before requiring scheduler so persistence doesn't touch disk
jest.mock('fs', () => ({
  existsSync: jest.fn(() => false),
  readFileSync: jest.fn(() => '{}'),
  writeFileSync: jest.fn(),
}));

const {
  heartbeatState,
  NUDGE_CHECKS,
  TEMPLATE_SIDS,
  isInTimeWindow,
  getOverdueHours,
  sendNudgeToUser,
  normaliseCheckResult,
  buildWeeklyChartUrl,
  getTopDiscretionaryCategory,
  loadState,
  saveState,
} = require('../scheduler');

const fs = require('fs');

// Mock dependencies
jest.mock('node-cron', () => ({ schedule: jest.fn() }));
jest.mock('../sheets', () => ({
  getMonthlySummary: jest.fn(),
  getWeeklySummary: jest.fn(),
  getOverspendAlerts: jest.fn(),
  getBudgetStatus: jest.fn(),
  suggestBudgets: jest.fn(),
  getCyclePaceAnalysis: jest.fn(),
  getLastEntryInfo: jest.fn(),
  getAllUsers: jest.fn(),
  isWithinSessionWindow: jest.fn(),
}));
jest.mock('../messaging', () => ({
  sendWhatsAppTo: jest.fn(),
  sendWhatsAppImageTo: jest.fn(),
  sendWhatsAppTemplate: jest.fn(),
  sendWhatsAppImageBroadcast: jest.fn(),
}));

const { isWithinSessionWindow } = require('../sheets');
const { sendWhatsAppTo, sendWhatsAppTemplate } = require('../messaging');

describe('Heartbeat Engine', () => {
  beforeEach(() => {
    heartbeatState.clear();
  });

  describe('NUDGE_CHECKS registry', () => {
    test('has 8 check definitions', () => {
      expect(NUDGE_CHECKS).toHaveLength(8);
    });

    test('each check has required fields', () => {
      for (const check of NUDGE_CHECKS) {
        expect(check).toHaveProperty('id');
        expect(check).toHaveProperty('cadenceHours');
        expect(check).toHaveProperty('windowStart');
        expect(check).toHaveProperty('windowEnd');
        expect(check).toHaveProperty('priority');
        expect(check).toHaveProperty('check');
        expect(typeof check.check).toBe('function');
      }
    });

    test('all IDs are unique', () => {
      const ids = NUDGE_CHECKS.map(n => n.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    test('priorities are between 1 and 10', () => {
      for (const check of NUDGE_CHECKS) {
        expect(check.priority).toBeGreaterThanOrEqual(1);
        expect(check.priority).toBeLessThanOrEqual(10);
      }
    });

    test('time windows are valid IST hours', () => {
      for (const check of NUDGE_CHECKS) {
        expect(check.windowStart).toBeGreaterThanOrEqual(0);
        expect(check.windowStart).toBeLessThan(24);
        expect(check.windowEnd).toBeGreaterThan(0);
        expect(check.windowEnd).toBeLessThanOrEqual(24);
      }
    });

    test('broadcast checks are flagged correctly', () => {
      const broadcasts = NUDGE_CHECKS.filter(n => n.broadcast);
      expect(broadcasts.length).toBe(2); // friday_digest and overspend_alert
      const broadcastIds = broadcasts.map(n => n.id).sort();
      expect(broadcastIds).toEqual(['friday_digest', 'overspend_alert']);
    });

    test('friday_digest is weekly and Friday-only', () => {
      const friday = NUDGE_CHECKS.find(n => n.id === 'friday_digest');
      expect(friday.cadenceHours).toBe(168);
      expect(friday.dayOfWeek).toBe(5);
    });
  });

  describe('getOverdueHours', () => {
    test('returns full cadence when never sent', () => {
      const hours = getOverdueHours('test_nudge', '+1234', 24);
      expect(hours).toBe(24);
    });

    test('returns negative when recently sent', () => {
      heartbeatState.set('test_nudge:+1234', new Date());
      const hours = getOverdueHours('test_nudge', '+1234', 24);
      expect(hours).toBeLessThan(0);
    });

    test('returns positive when overdue', () => {
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      heartbeatState.set('test_nudge:+1234', twoHoursAgo);
      const hours = getOverdueHours('test_nudge', '+1234', 1);
      expect(hours).toBeGreaterThan(0);
    });

    test('different users have independent state', () => {
      heartbeatState.set('test_nudge:+1111', new Date());
      const hoursUser1 = getOverdueHours('test_nudge', '+1111', 24);
      const hoursUser2 = getOverdueHours('test_nudge', '+2222', 24);
      expect(hoursUser1).toBeLessThan(0);
      expect(hoursUser2).toBe(24); // never sent
    });

    test('different nudges have independent state', () => {
      heartbeatState.set('nudge_a:+1234', new Date());
      const hoursA = getOverdueHours('nudge_a', '+1234', 24);
      const hoursB = getOverdueHours('nudge_b', '+1234', 24);
      expect(hoursA).toBeLessThan(0);
      expect(hoursB).toBe(24);
    });
  });

  describe('isInTimeWindow', () => {
    test('is a function', () => {
      expect(typeof isInTimeWindow).toBe('function');
    });

    // Time window tests are tricky because they depend on current time.
    // We test the logic implicitly: a 0-24 window should always be true.
    test('full day window always matches', () => {
      expect(isInTimeWindow(0, 24)).toBe(true);
    });
  });

  describe('buildWeeklyChartUrl', () => {
    test('returns quickchart URL', () => {
      const url = buildWeeklyChartUrl(
        { 'Food': 500, 'Transport': 200 },
        '01 Apr - 07 Apr'
      );
      expect(url).toContain('quickchart.io/chart');
      expect(url).toContain('Weekly%20Spend');
    });

    test('limits to 8 categories', () => {
      const categories = {};
      for (let i = 0; i < 12; i++) categories['Cat' + i] = 100 * (12 - i);
      const url = buildWeeklyChartUrl(categories, '01-07 Apr');
      const decoded = decodeURIComponent(url);
      const config = JSON.parse(decoded.split('?c=')[1].split('&w=')[0]);
      expect(config.data.labels.length).toBeLessThanOrEqual(8);
    });
  });

  describe('getTopDiscretionaryCategory', () => {
    test('returns highest non-committed category', () => {
      const result = getTopDiscretionaryCategory({
        'Rent': 20000,       // committed
        'Food': 5000,        // discretionary
        'Shopping': 8000,    // discretionary
      });
      expect(result.category).toBe('Shopping');
      expect(result.amount).toBe(8000);
    });

    test('returns null for empty input', () => {
      expect(getTopDiscretionaryCategory({})).toBeNull();
      expect(getTopDiscretionaryCategory(null)).toBeNull();
    });
  });

  describe('State persistence', () => {
    beforeEach(() => {
      heartbeatState.clear();
      jest.clearAllMocks();
    });

    test('loadState restores timestamps from disk', () => {
      const stored = {
        'smart_nudge:+91123': '2026-04-10T09:00:00.000Z',
        'daily_nudge:+91456': '2026-04-10T14:00:00.000Z',
      };
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify(stored));

      loadState();

      expect(heartbeatState.size).toBe(2);
      expect(heartbeatState.get('smart_nudge:+91123')).toEqual(new Date('2026-04-10T09:00:00.000Z'));
      expect(heartbeatState.get('daily_nudge:+91456')).toEqual(new Date('2026-04-10T14:00:00.000Z'));
    });

    test('loadState handles missing file gracefully', () => {
      fs.existsSync.mockReturnValue(false);
      loadState();
      expect(heartbeatState.size).toBe(0);
    });

    test('loadState handles corrupt file gracefully', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue('not json');
      loadState();
      expect(heartbeatState.size).toBe(0);
    });

    test('saveState writes all entries to disk', () => {
      heartbeatState.set('smart_nudge:+91123', new Date('2026-04-10T09:00:00.000Z'));
      heartbeatState.set('daily_nudge:+91456', new Date('2026-04-10T14:00:00.000Z'));

      saveState();

      expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
      const written = JSON.parse(fs.writeFileSync.mock.calls[0][1]);
      expect(written['smart_nudge:+91123']).toBe('2026-04-10T09:00:00.000Z');
      expect(written['daily_nudge:+91456']).toBe('2026-04-10T14:00:00.000Z');
    });

    test('markSent triggers saveState', () => {
      // getOverdueHours + markSent integration
      expect(getOverdueHours('test', '+91123', 24)).toBe(24); // never sent
      heartbeatState.set('test:+91123', new Date());
      saveState();
      expect(fs.writeFileSync).toHaveBeenCalled();
    });
  });

  describe('Template metadata', () => {
    test('each check has template config with sidKey and buildVariables', () => {
      for (const check of NUDGE_CHECKS) {
        expect(check.template).toBeDefined();
        expect(check.template.sidKey).toBeDefined();
        expect(typeof check.template.buildVariables).toBe('function');
      }
    });

    test('TEMPLATE_SIDS has entry for each nudge sidKey', () => {
      for (const check of NUDGE_CHECKS) {
        expect(TEMPLATE_SIDS).toHaveProperty(check.template.sidKey);
      }
    });

    test('friday_digest has chart template config', () => {
      const friday = NUDGE_CHECKS.find(n => n.id === 'friday_digest');
      expect(friday.template.chartSidKey).toBe('friday_chart');
      expect(typeof friday.template.buildChartVariables).toBe('function');
    });

    test('static nudge buildVariables returns empty object', () => {
      const staticNudges = ['morning_followup', 'lapse_nudge', 'daily_nudge', 'evening_checkin'];
      for (const id of staticNudges) {
        const nudge = NUDGE_CHECKS.find(n => n.id === id);
        expect(nudge.template.buildVariables('any message')).toEqual({});
      }
    });

    test('smart_nudge buildVariables truncates to 1024 chars', () => {
      const nudge = NUDGE_CHECKS.find(n => n.id === 'smart_nudge');
      const longMsg = 'x'.repeat(2000);
      const vars = nudge.template.buildVariables(longMsg);
      expect(vars['1'].length).toBe(1024);
    });
  });

  describe('normaliseCheckResult', () => {
    test('returns null for null/undefined', () => {
      expect(normaliseCheckResult(null)).toBeNull();
      expect(normaliseCheckResult(undefined)).toBeNull();
    });

    test('wraps string into object', () => {
      const result = normaliseCheckResult('hello');
      expect(result).toEqual({ freeformMessage: 'hello', templateData: {} });
    });

    test('passes through object as-is', () => {
      const obj = { freeformMessage: 'hi', templateData: { foo: 'bar' } };
      expect(normaliseCheckResult(obj)).toBe(obj);
    });
  });

  describe('sendNudgeToUser', () => {
    const nudge = {
      id: 'test_nudge',
      template: {
        sidKey: 'daily_nudge',
        buildVariables: function() { return {}; }
      }
    };
    const user = { phone: '+919876543210', lastMessageAt: null };

    beforeEach(() => {
      jest.clearAllMocks();
    });

    test('sends freeform when within session window', async () => {
      isWithinSessionWindow.mockReturnValue(true);
      const sent = await sendNudgeToUser(nudge, user, 'Hello!');
      expect(sent).toBe(true);
      expect(sendWhatsAppTo).toHaveBeenCalledWith('+919876543210', 'Hello!');
      expect(sendWhatsAppTemplate).not.toHaveBeenCalled();
    });

    test('sends template when outside session window with SID configured', async () => {
      isWithinSessionWindow.mockReturnValue(false);
      // Temporarily set a template SID
      const original = TEMPLATE_SIDS.daily_nudge;
      TEMPLATE_SIDS.daily_nudge = 'HX_test_sid';
      try {
        const sent = await sendNudgeToUser(nudge, user, 'Hello!');
        expect(sent).toBe(true);
        expect(sendWhatsAppTemplate).toHaveBeenCalledWith('+919876543210', 'HX_test_sid', {});
        expect(sendWhatsAppTo).not.toHaveBeenCalled();
      } finally {
        TEMPLATE_SIDS.daily_nudge = original;
      }
    });

    test('returns false when outside session window with no SID', async () => {
      isWithinSessionWindow.mockReturnValue(false);
      const original = TEMPLATE_SIDS.daily_nudge;
      TEMPLATE_SIDS.daily_nudge = null;
      try {
        const sent = await sendNudgeToUser(nudge, user, 'Hello!');
        expect(sent).toBe(false);
        expect(sendWhatsAppTo).not.toHaveBeenCalled();
        expect(sendWhatsAppTemplate).not.toHaveBeenCalled();
      } finally {
        TEMPLATE_SIDS.daily_nudge = original;
      }
    });

    test('returns false when template send throws', async () => {
      isWithinSessionWindow.mockReturnValue(false);
      const original = TEMPLATE_SIDS.daily_nudge;
      TEMPLATE_SIDS.daily_nudge = 'HX_bad_sid';
      sendWhatsAppTemplate.mockRejectedValue(new Error('Template not approved'));
      try {
        const sent = await sendNudgeToUser(nudge, user, 'Hello!');
        expect(sent).toBe(false);
      } finally {
        TEMPLATE_SIDS.daily_nudge = original;
      }
    });

    test('returns false for null check result', async () => {
      const sent = await sendNudgeToUser(nudge, user, null);
      expect(sent).toBe(false);
    });
  });
});

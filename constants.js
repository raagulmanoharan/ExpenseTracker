// ─── Shared constants and utilities ──────────────────────────────────────────

const CATEGORIES = [
  'Food & Dining', 'Food Delivery', 'Groceries', 'Transport', 'Shopping',
  'Entertainment', 'Health & Fitness', 'Utilities', 'Rent', 'Travel',
  'Personal Care', 'Subscriptions', 'Family Transfer', 'Investments', 'Loan EMI',
  'Credit Card Payment', 'Other'
];

// New users see only these 6 universal categories.
// As they log expenses in other categories, those categories become visible.
const BASE_CATEGORIES = [
  'Food & Dining', 'Food Delivery', 'Groceries',
  'Transport', 'Shopping', 'Other'
];

/**
 * Returns the categories a user should see — starts with BASE_CATEGORIES,
 * expands as they log expenses in other categories.
 * @param {object|null} user - user profile (unused for now, future personalization)
 * @param {Array} expenseHistory - raw sheet rows (each row[3] = category)
 * @returns {string[]} ordered subset of CATEGORIES
 */
function getVisibleCategories(user, expenseHistory) {
  if (!user || !expenseHistory || expenseHistory.length === 0) return BASE_CATEGORIES;
  const visible = new Set(BASE_CATEGORIES);
  for (const row of expenseHistory) {
    const cat = row[3] || 'Other';
    if (CATEGORIES.includes(cat)) visible.add(cat);
  }
  // Return in the canonical CATEGORIES order
  return CATEGORIES.filter(c => visible.has(c));
}

const COMMITTED_CATEGORIES = new Set([
  'Rent', 'Loan EMI', 'Investments', 'Family Transfer', 'Utilities', 'Subscriptions', 'Credit Card Payment'
]);

function isCommitted(category) {
  return COMMITTED_CATEGORIES.has(category);
}

function getMonthName() {
  return new Date().toLocaleString('en-IN', { month: 'long' });
}

function parseIndianDate(dateStr) {
  const parts = dateStr.split('/');
  if (parts.length !== 3) return null;
  return new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0]));
}

function safeParseJSON(text) {
  try {
    return JSON.parse(text.trim());
  } catch {
    try {
      return JSON.parse(text.trim().replace(/```json|```/g, '').trim());
    } catch {
      console.error('JSON parse failed:', text.substring(0, 200));
      return { type: 'unknown' };
    }
  }
}

function getCategoryEmoji(category) {
  const map = {
    'Food & Dining': '🍽️', 'Food Delivery': '🛵', 'Groceries': '🛒',
    'Transport': '🚗', 'Shopping': '🛍️', 'Entertainment': '🎬',
    'Health & Fitness': '💊', 'Utilities': '💡', 'Rent': '🏠',
    'Travel': '✈️', 'Personal Care': '💆', 'Subscriptions': '📱',
    'Family Transfer': '👨‍👩‍👧', 'Investments': '📈', 'Loan EMI': '🏦',
    'Credit Card Payment': '💳', 'Other': '📦'
  };
  return map[category] || '💸';
}

function isSharedCategory(category, sharedCategories) {
  if (!sharedCategories || sharedCategories.length === 0) return false;
  return sharedCategories.includes(category);
}

module.exports = {
  CATEGORIES,
  BASE_CATEGORIES,
  COMMITTED_CATEGORIES,
  isCommitted,
  isSharedCategory,
  getVisibleCategories,
  getMonthName,
  parseIndianDate,
  safeParseJSON,
  getCategoryEmoji
};

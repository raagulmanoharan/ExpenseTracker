// ─── Shared constants and utilities ──────────────────────────────────────────

const CATEGORIES = [
  'Food & Dining', 'Food Delivery', 'Groceries', 'Transport', 'Shopping',
  'Entertainment', 'Health & Fitness', 'Utilities', 'Rent', 'Travel',
  'Personal Care', 'Subscriptions', 'Family Transfer', 'Investments', 'Loan EMI',
  'Credit Card Payment', 'Other'
];

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
  COMMITTED_CATEGORIES,
  isCommitted,
  isSharedCategory,
  getMonthName,
  parseIndianDate,
  safeParseJSON,
  getCategoryEmoji
};

// ─── Shared Anthropic client + retry logic ──────────────────────────────────
// Single source of truth — imported by parser.js, conversation.js, pdf-parser.js,
// cc-statement-parser.js, responder.js, insights.js.

const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Centralized model selection. Using current-generation IDs across the codebase:
//   - intent classification + composed-reply: Haiku 4.5 (~5x faster than Sonnet 4)
//   - structured parsing (statements, vision): Sonnet 4.6 (better JSON adherence)
//   - conversational Q&A: Sonnet 4.6
// Override any of these per-call by passing an explicit model.
const MODELS = {
  intentClassifier: 'claude-haiku-4-5-20251001',
  responseComposer: 'claude-haiku-4-5-20251001',
  insightSummarizer: 'claude-haiku-4-5-20251001',
  conversation:     'claude-sonnet-4-6',
  bankStatement:    'claude-sonnet-4-6',
  ccStatement:      'claude-sonnet-4-6',
  expenseImage:     'claude-sonnet-4-6'
};

// Wrap a long, stable system prompt for prompt caching. The Anthropic API
// caches the prefix on the first call and reuses it on subsequent calls within
// ~5 minutes of the last hit — typical savings 90% on input tokens for the
// cached portion. Caller passes a single string; we wrap it in the array-of-
// blocks shape the API expects with cache_control.
function cachedSystem(text) {
  return [{ type: 'text', text, cache_control: { type: 'ephemeral' } }];
}

// Retry on transient Anthropic API errors (529 overloaded, 500, 503)
async function callWithRetry(fn, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (err) {
      const status = err.status || err.statusCode || 0;
      if (i < retries && (status === 529 || status === 500 || status === 503)) {
        const delay = (i + 1) * 1000;
        console.warn(`[anthropic] ${status} on attempt ${i + 1}, retrying in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
}

module.exports = { client, callWithRetry, MODELS, cachedSystem };

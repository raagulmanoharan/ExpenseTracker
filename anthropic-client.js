// ─── Shared Anthropic client + retry logic ──────────────────────────────────
// Single source of truth — imported by parser.js, conversation.js, pdf-parser.js, responder.js

const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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

module.exports = { client, callWithRetry };

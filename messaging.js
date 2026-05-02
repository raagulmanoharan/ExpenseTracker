// ─── Shared messaging module ─────────────────────────────────────────────────
// Singleton Twilio client. All WhatsApp sends go through here.

const twilio = require('twilio');

const FROM = process.env.TWILIO_WHATSAPP_FROM;

// ─── Interactive message template SIDs (session-only, no approval needed) ────
const INTERACTIVE_SIDS = {
  cc_setup_ask:           'HX4e4e5897998dc38b311bcb62efe6a3e4',
  household_invite_step:  'HXbb2a9761504722c0eddab1edac50fa4c',
  household_invite_msg:   'HX580e006baf80c7ad1f2b772ecdda81b9',
  category_picker:        'HX1a5738924be3cfbf63af2dbf58a7a37e',
  salary_setup_ask:       'HXc3182799f55f58f4aac4a439102f0b58',
  duplicate_confirm:      'HXc5643f5b5e641cf1048144c6c0bfd97a',
};

// Plain-text templates for outside 24h session sends (must be approved)
const TEMPLATE_SIDS = {
  household_update: 'HXc61e733e7a7927308095cd26816498d2',
};

let _client = null;
function getClient() {
  if (!_client) {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    if (!sid || !token) return null;
    _client = twilio(sid, token);
  }
  return _client;
}

// Send to a specific recipient (for webhook replies and targeted nudges)
async function sendWhatsAppTo(to, body) {
  const client = getClient();
  if (!client || !FROM) {
    console.warn('[messaging] Twilio not configured, skipping send');
    return;
  }
  await client.messages.create({ from: FROM, to, body });
}

// Send an image to a specific recipient
async function sendWhatsAppImageTo(to, mediaUrl, caption) {
  const client = getClient();
  if (!client || !FROM) return;
  await client.messages.create({ from: FROM, to, mediaUrl: [mediaUrl], body: caption || '' });
}

// Send a Content Template message (for outside 24h session window)
async function sendWhatsAppTemplate(to, contentSid, contentVariables) {
  const client = getClient();
  if (!client || !FROM) {
    console.warn('[messaging] Twilio not configured, skipping template send');
    return;
  }
  const params = { from: FROM, to, contentSid };
  if (contentVariables && Object.keys(contentVariables).length > 0) {
    params.contentVariables = JSON.stringify(contentVariables);
  }
  await client.messages.create(params);
}

// Send an interactive message (buttons or list picker) using a Content Template
// Falls back to text-only body if template send fails
async function sendWhatsAppInteractive(to, templateKey, variables, fallbackBody) {
  const client = getClient();
  if (!client || !FROM) {
    console.warn('[messaging] Twilio not configured, skipping interactive send');
    return;
  }
  const contentSid = INTERACTIVE_SIDS[templateKey];
  if (!contentSid) {
    console.warn('[messaging] No template SID for', templateKey, '— using fallback');
    if (fallbackBody) await client.messages.create({ from: FROM, to, body: fallbackBody });
    return;
  }
  try {
    const params = { from: FROM, to, contentSid };
    if (variables && Object.keys(variables).length > 0) {
      params.contentVariables = JSON.stringify(variables);
    }
    await client.messages.create(params);
  } catch (err) {
    console.warn('[messaging] Interactive send failed, using fallback:', err.message);
    if (fallbackBody) await client.messages.create({ from: FROM, to, body: fallbackBody });
  }
}

// Send a household notification — works in OR out of the 24h session window.
// Tries free-form text first (cheaper, no template fee). If Twilio rejects it
// because the recipient hasn't messaged the bot in 24+ hours, retry with the
// approved budgy_household_update template.
async function sendHouseholdNotification(to, body) {
  const client = getClient();
  if (!client || !FROM) {
    console.warn('[messaging] Twilio not configured, skipping household notification');
    return;
  }
  try {
    await client.messages.create({ from: FROM, to, body });
  } catch (err) {
    // Twilio error 63016 = outside 24h session window; also retry on generic failures
    const code = err && (err.code || err.status);
    const isSessionError = code === 63016 || /outside.*window|24.?hour|template/i.test(err.message || '');
    if (!isSessionError) {
      console.error('[messaging] household notification failed:', err.message);
      return;
    }
    try {
      await client.messages.create({
        from: FROM,
        to,
        contentSid: TEMPLATE_SIDS.household_update,
        contentVariables: JSON.stringify({ '1': body })
      });
    } catch (templateErr) {
      console.error('[messaging] household notification template fallback failed:', templateErr.message);
    }
  }
}

// Broadcast to all users (for scheduled nudges)
async function sendWhatsAppBroadcast(body, getAllUsers) {
  const users = await getAllUsers();
  for (const user of users) {
    if (!user.phone) continue;
    try {
      await sendWhatsAppTo(user.phone, body);
    } catch (err) {
      console.error(`[messaging] Broadcast failed for ${user.phone}:`, err.message);
    }
  }
}

// Broadcast image to all users
async function sendWhatsAppImageBroadcast(mediaUrl, caption, getAllUsers) {
  const users = await getAllUsers();
  for (const user of users) {
    if (!user.phone) continue;
    try {
      await sendWhatsAppImageTo(user.phone, mediaUrl, caption);
    } catch (err) {
      console.error(`[messaging] Image broadcast failed for ${user.phone}:`, err.message);
    }
  }
}

module.exports = {
  sendWhatsAppTo,
  sendWhatsAppImageTo,
  sendWhatsAppTemplate,
  sendWhatsAppInteractive,
  sendHouseholdNotification,
  sendWhatsAppBroadcast,
  sendWhatsAppImageBroadcast,
  INTERACTIVE_SIDS,
  TEMPLATE_SIDS
};

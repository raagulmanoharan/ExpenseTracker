// ─── Shared messaging module ─────────────────────────────────────────────────
// Singleton Twilio client. All WhatsApp sends go through here.

const twilio = require('twilio');

const FROM = process.env.TWILIO_WHATSAPP_FROM;

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
  sendWhatsAppBroadcast,
  sendWhatsAppImageBroadcast
};

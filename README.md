# 📲 WhatsApp Expense Tracker

Track your daily expenses by sending WhatsApp messages. Claude AI parses your natural language, categorises the expense, and logs it to a Google Sheet — then replies with your running monthly total.

## How it works

```
You → WhatsApp → Twilio → This server → Claude API (parse) → Google Sheets (log) → Reply
```

---

## ✅ What you can say

| Message | What it does |
|---|---|
| `lunch 250 Swiggy` | Logs ₹250, Food Delivery, Swiggy |
| `auto 80` | Logs ₹80, Transport |
| `groceries 1200 Big Bazaar` | Logs ₹1200, Groceries |
| `bought headphones 2499 Amazon` | Logs ₹2499, Shopping |
| `zomato 350 biryani` | Logs ₹350, Food Delivery |
| `summary` | Monthly breakdown by category |
| `this week` | This week's spending |
| `undo` | Removes the last entry |

---

## 🛠️ Setup (one-time, ~30–45 min)

### Step 1 — Google Sheets

1. Create a new Google Sheet at [sheets.google.com](https://sheets.google.com)
2. Rename the first sheet tab to **`Expenses`**
3. Copy the Sheet ID from the URL:
   ```
   docs.google.com/spreadsheets/d/YOUR_SHEET_ID_IS_HERE/edit
   ```

### Step 2 — Google Service Account

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create a new project (or use an existing one)
3. Enable the **Google Sheets API**:
   - APIs & Services → Enable APIs → search "Google Sheets API" → Enable
4. Create a Service Account:
   - APIs & Services → Credentials → Create Credentials → Service Account
   - Give it any name, click Done
5. Click on the service account → Keys tab → Add Key → JSON
6. Download the JSON file
7. Share your Google Sheet with the service account email (looks like `name@project.iam.gserviceaccount.com`) — give it **Editor** access

### Step 3 — Twilio WhatsApp Business Number

1. Sign up at [twilio.com](https://twilio.com) and purchase a WhatsApp-enabled number
2. Go to **Messaging → Senders → WhatsApp Senders** and complete the business verification
3. Note your WhatsApp Business number — you'll configure the webhook URL after deploying

### Step 4 — Deploy to Render

1. Push this code to a GitHub repo
2. Go to [render.com](https://render.com) → New → Web Service → connect your repo
3. Settings:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Health Check Path:** `/health`
4. Add these Environment Variables:
   ```
   ANTHROPIC_API_KEY       → your Claude API key (console.anthropic.com)
   GOOGLE_SHEET_ID         → the sheet ID from Step 1
   GOOGLE_SERVICE_ACCOUNT_JSON → paste the full contents of the JSON file from Step 2
   ```
5. Deploy. Copy your Render URL once it's live (e.g. `https://your-app.onrender.com`)

### Step 5 — Connect Twilio to your server

1. In Twilio → Messaging → Senders → WhatsApp Senders → select your number
2. Set **"When a message comes in"** webhook to:
   ```
   https://your-app.onrender.com/webhook
   ```
   Method: **HTTP POST**
3. Save

### Step 6 — Test it!

Send **"lunch 250 Swiggy"** to your Twilio WhatsApp number and you should get a confirmation reply.

---

## 📊 Google Sheet columns

| Date | Time | Amount (₹) | Category | Merchant | Note | Raw Message |
|---|---|---|---|---|---|---|
| 27/03/2026 | 01:30 PM | 250 | Food Delivery | Swiggy | — | lunch 250 Swiggy |

---

### Step 6b — Content Templates (for scheduled nudges)

Production WhatsApp only allows freeform messages within 24 hours of a user's last message. Scheduled nudges (reminders, digests, alerts) fire outside this window and require pre-approved Content Templates.

1. Go to **Twilio Console → Content Editor**
2. Create templates for each nudge type (see `.env.example` for the list)
3. Submit for Meta approval (takes 24-48 hours)
4. Once approved, add the template SIDs (`HXxxx...`) to your environment variables

Without templates configured, nudges will only be delivered to users who messaged within the last 24 hours.

---

## 💡 Tips

- **Free tier note:** Render's free tier spins down after 15 min of inactivity. First message after sleep takes ~30s. Upgrade to Starter ($7/mo) for always-on.
- **Multiple users:** The tracker logs all messages. Add a "From" column to `sheets.js` if Adithee also wants to use it.
- **Template approval lead time:** Meta takes 24-48 hours to approve Content Templates. Create and submit them before deploying the production number.

---

## 📁 Project structure

```
whatsapp-expense-tracker/
├── server.js        ← Express webhook handler
├── parser.js        ← Claude AI expense parser
├── sheets.js        ← Google Sheets read/write
├── package.json
├── render.yaml      ← Render deployment config
├── .env.example     ← Required environment variables
└── README.md
```

# Google Meet Gemini Notes → HubSpot CRM Sync

Automatically syncs Google Meet Gemini meeting notes into your HubSpot CRM meeting records.

When a Google Meet call ends, Gemini saves a Google Doc containing:
- **Notes** — an AI-generated summary, action items, and key points
- **Transcript** — the full meeting transcript (stored as a separate tab in the same Google Doc)

This tool finds those documents, matches them to the corresponding HubSpot meeting record by start time, and writes the formatted notes directly into the HubSpot meeting body. A link to the transcript tab in Google Docs is also included (the transcript itself is not copied into HubSpot — only the link).

> **Note on Google Calendar notifications:** HubSpot meetings can be linked to Google Calendar events. When this tool updates the meeting body in HubSpot, HubSpot may sync the change back to the Google Calendar event description. This causes Google to automatically send an "event updated" email to all meeting attendees — this is standard Google Calendar behavior and cannot be suppressed from the HubSpot API side. Attendees will receive the meeting notes as part of the calendar update, which in many cases is a desirable outcome.

---

## How It Works

1. **Search Google Drive** for Gemini-generated meeting note documents modified in the last N hours
2. **Parse the meeting start time** from the document filename (`Meeting started YYYY/MM/DD HH:MM TZ - Notes by Gemini`)
3. **Find the matching HubSpot meeting** using a configurable time window (default ±10 minutes)
4. **Write formatted HTML** into the HubSpot meeting body via the Engagements API
5. **Record the result** in a local SQLite database to avoid duplicate syncs
6. Runs on a **cron schedule** (every hour by default)

---

## Prerequisites

- Node.js 18+
- A Google account with Google Meet + Gemini Notes enabled
- A HubSpot account with meetings scheduled through HubSpot (so HubSpot meeting records exist)

---

## Setup

### Step 1 — Clone and install dependencies

```bash
git clone https://github.com/astonysh/Google-Meeting-Gemini-Notes-Transcript-Hubspot-CRM-Sync.git
cd Google-Meeting-Gemini-Notes-Transcript-Hubspot-CRM-Sync
npm install
cp .env.example .env
```

---

### Step 2 — Enable Google APIs

Go to [Google Cloud Console](https://console.cloud.google.com/) and enable the following APIs for your project:

- **Google Drive API**
- **Google Docs API**
- **Gmail API** (required for the OAuth2 scope)

---

### Step 3 — Create a Google OAuth2 Client

1. In Google Cloud Console, go to **APIs & Services → Credentials**
2. Click **Create Credentials → OAuth 2.0 Client ID**
3. Select **Web application** as the application type
   > ⚠️ Do NOT select "Desktop app" — it does not allow custom redirect URIs
4. Under **Authorized redirect URIs**, add:
   ```
   http://localhost:3333/callback
   ```
5. Click **Create** and note your **Client ID** and **Client Secret**
6. Add them to your `.env` file:
   ```
   GMAIL_CLIENT_ID=your-client-id.apps.googleusercontent.com
   GMAIL_CLIENT_SECRET=your-client-secret
   ```

---

### Step 4 — Get a Google Refresh Token

Run the included token helper script:

```bash
npm run get-token
```

This will:
1. Open your browser to the Google authorization page
2. Ask you to grant access to Gmail, Drive, and Docs (read-only for Drive/Docs)
3. Print your refresh token to the terminal

Copy the token into your `.env` file:
```
GMAIL_REFRESH_TOKEN=your-refresh-token
```

---

### Step 5 — Create a HubSpot Private App

1. In HubSpot, go to **Settings → Integrations → Private Apps**
2. Click **Create a private app**
3. Give it a name (e.g., "Gemini Notes Sync")
4. Under **Scopes**, add:
   - `crm.objects.contacts.read`
   - `crm.objects.contacts.write`
5. Click **Create app** and copy the generated token
6. Add it to your `.env` file:
   ```
   HUBSPOT_PRIVATE_APP_TOKEN=pat-na1-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
   ```

---

### Step 6 — Configure sync settings

In your `.env` file, set:

```env
# How far back to search for new Gemini note documents (hours)
# Set to 25 to cover a full day plus 1 hour of overlap
MEET_SYNC_LOOKBACK_HOURS=25

# Time window for matching a Google Doc to a HubSpot meeting (minutes, ±)
# Use a smaller value (e.g. 10) if you have back-to-back meetings
MEET_SYNC_MATCH_WINDOW_MIN=10
```

---

### Step 7 — Run a test sync

```bash
npm run sync
```

This runs a one-time sync and exits. Check the console output for results. You should see something like:

```
[MeetSync] Starting sync, searching for Gemini notes from the last 25h...
[MeetSync] Found 3 candidate document(s)
[MeetSync] Processing document: Meeting started 2026/04/24 10:00 CEST - Notes by Gemini
[MeetSync] Parsed meeting time: 2026-04-24T08:00:00.000Z
[MeetSync] Matched HubSpot meeting: "Q2 Review" (id=12345678)
[MeetSync] Synced: "Meeting started 2026/04/24 10:00 CEST - Notes by Gemini" → HubSpot meeting 12345678
[MeetSync] Sync run complete
```

Then open the corresponding meeting in HubSpot to verify the notes appear in the meeting body.

---

### Step 8 — Run continuously (background process)

#### Option A: Run directly

```bash
node index.js
```

Runs the sync immediately, then repeats every hour via cron.

#### Option B: Run with PM2 (recommended for servers/Mac mini)

```bash
npm install -g pm2
pm2 start index.js --name meet-sync
pm2 save
pm2 startup   # optional: auto-start on system reboot
```

View logs:
```bash
pm2 logs meet-sync
```

---

## Deduplication

The tool stores all processed documents in a local SQLite database (`sync.db`). Each Google Doc is identified by its Drive file ID and will never be processed twice, regardless of how many times the sync runs.

To inspect the sync history:
```bash
sqlite3 sync.db "SELECT doc_title, meeting_start, status, synced_at FROM synced_meetings ORDER BY synced_at DESC LIMIT 20;"
```

Status values:
| Status | Meaning |
|--------|---------|
| `synced` | Successfully written to HubSpot |
| `no_match` | No HubSpot meeting found in the time window |
| `multi_match` | Multiple HubSpot meetings matched — manual review needed |
| `error` | API error during processing |

---

## Troubleshooting

**"No candidate documents found"**
- Verify that Google Meet with Gemini Notes is enabled on your account
- Check that the Gemini note documents appear in your Google Drive
- Increase `MEET_SYNC_LOOKBACK_HOURS` if you want to backfill older meetings

**"No matching HubSpot meeting found"**
- The HubSpot meeting must already exist (created via HubSpot scheduling, not Google Calendar directly)
- Try increasing `MEET_SYNC_MATCH_WINDOW_MIN` if meeting times are slightly off
- Verify the meeting start time in the Google Doc filename matches the HubSpot record

**"Multiple HubSpot meetings matched"**
- Two or more HubSpot meetings fall within the time window
- Reduce `MEET_SYNC_MATCH_WINDOW_MIN`, or manually associate the doc in HubSpot

**"Google API 403 / insufficient permissions"**
- Re-run `npm run get-token` and make sure you authorize all three scopes
- Ensure Google Drive API and Google Docs API are enabled in Google Cloud Console

**"HubSpot API 401"**
- Verify `HUBSPOT_PRIVATE_APP_TOKEN` is correct and the app has the required scopes

---

## Project Structure

```
.
├── index.js          # Main sync logic + cron scheduler
├── hubspot.js        # HubSpot API client
├── google.js         # Google OAuth2 + Drive + Docs clients
├── db.js             # SQLite initialization and access
├── scripts/
│   └── get-token.js  # Helper to obtain Google OAuth2 refresh token
├── .env.example      # Environment variable template
└── sync.db           # Created automatically on first run (gitignored)
```

---

## License

[PolyForm Noncommercial License 1.0.0](LICENSE)

Free for personal and non-commercial use. If you wish to use this project for commercial purposes, please open an issue or contact the author to discuss licensing.

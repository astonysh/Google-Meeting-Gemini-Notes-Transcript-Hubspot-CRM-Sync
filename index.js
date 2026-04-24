'use strict';

require('dotenv').config();

const cron = require('node-cron');
const { getDriveClient, getDocsClient } = require('./google');
const { getDb } = require('./db');
const hubspot = require('./hubspot');

// Common timezone abbreviation → UTC offset hours
const TZ_OFFSETS = {
  UTC: 0, GMT: 0,
  CET: 1, CEST: 2,
  EET: 2, EEST: 3,
  WET: 0, WEST: 1,
  EST: -5, EDT: -4,
  CST: -6, CDT: -5,
  MST: -7, MDT: -6,
  PST: -8, PDT: -7,
  HKT: 8, SGT: 8, JST: 9,
  IST: 5.5, AEST: 10, AEDT: 11,
};

function parseMeetingTime(dateStr, timeStr, tzStr) {
  const [year, month, day] = dateStr.split('/').map(Number);
  const [hour, minute] = timeStr.split(':').map(Number);
  const offsetHours = TZ_OFFSETS[tzStr.toUpperCase()];
  if (offsetHours === undefined) {
    console.warn(`[MeetSync] Unknown timezone "${tzStr}", defaulting to UTC`);
  }
  const offset = (offsetHours ?? 0) * 3600 * 1000;
  const localMs = Date.UTC(year, month - 1, day, hour, minute, 0);
  return localMs - offset;
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function extractBodyHtml(bodyContent) {
  const parts = [];
  let inList = false;

  for (const elem of (bodyContent || [])) {
    if (!elem.paragraph) continue;

    const styleType = elem.paragraph.paragraphStyle?.namedStyleType || 'NORMAL_TEXT';
    const hasBullet = !!elem.paragraph.bullet;

    const inlineHtml = (elem.paragraph.elements || [])
      .map((e) => {
        const raw = e.textRun?.content || '';
        if (raw === '\n') return '';
        const text = escapeHtml(raw);
        const style = e.textRun?.textStyle || {};
        let out = text;
        if (style.bold && style.italic) out = `<b><i>${out}</i></b>`;
        else if (style.bold) out = `<b>${out}</b>`;
        else if (style.italic) out = `<i>${out}</i>`;
        return out;
      })
      .join('');

    const content = inlineHtml.trim();

    if (!hasBullet && inList) {
      parts.push('</ul>');
      inList = false;
    }

    if (hasBullet) {
      if (!inList) { parts.push('<ul>'); inList = true; }
      parts.push(`<li>${content}</li>`);
    } else if (styleType === 'HEADING_1') {
      if (content) parts.push(`<h1>${content}</h1>`);
    } else if (styleType === 'HEADING_2') {
      if (content) parts.push(`<h2>${content}</h2>`);
    } else if (styleType === 'HEADING_3') {
      if (content) parts.push(`<h3>${content}</h3>`);
    } else {
      parts.push(content ? `<p>${content}</p>` : '<br>');
    }
  }

  if (inList) parts.push('</ul>');
  return parts.join('');
}

function trimGeminiFooter(bodyContent) {
  const FOOTER_PATTERNS = [
    /review Gemini'?s notes/i,
    /Get tips and learn how Gemini/i,
    /quality of these specific notes/i,
    /Take a short survey/i,
    /how helpful the notes were/i,
  ];

  let end = bodyContent.length;
  while (end > 0) {
    const elem = bodyContent[end - 1];
    if (!elem.paragraph) { end--; continue; }
    const text = (elem.paragraph.elements || [])
      .map((e) => e.textRun?.content || '')
      .join('')
      .trim();
    if (!text || FOOTER_PATTERNS.some((re) => re.test(text))) {
      end--;
    } else {
      break;
    }
  }
  return bodyContent.slice(0, end);
}

function skipMeetingHeader(bodyContent) {
  const SKIP_PATTERNS = [
    /^Meeting\s+\w+\s+\d+,\s+\d{4}\s+at\s+\d+:\d+/i,
    /^Meeting records/i,
    /^Meeting started/i,
  ];

  let i = 0;
  while (i < bodyContent.length) {
    const elem = bodyContent[i];
    if (!elem.paragraph) { i++; continue; }
    const text = (elem.paragraph.elements || [])
      .map((e) => e.textRun?.content || '')
      .join('')
      .trim();
    if (!text || SKIP_PATTERNS.some((re) => re.test(text))) {
      i++;
    } else {
      break;
    }
  }
  return bodyContent.slice(i);
}

async function syncMeetings() {
  const db = getDb();
  const drive = getDriveClient();
  const docs = getDocsClient();

  const lookbackHours = parseInt(process.env.MEET_SYNC_LOOKBACK_HOURS || '25', 10);
  const windowMin = parseInt(process.env.MEET_SYNC_MATCH_WINDOW_MIN || '10', 10);
  const sinceDate = new Date(Date.now() - lookbackHours * 3600 * 1000).toISOString();

  console.log(`[MeetSync] Starting sync, searching for Gemini notes from the last ${lookbackHours}h...`);

  // Step 1: Search Google Drive for Gemini note documents
  let files;
  try {
    const res = await drive.files.list({
      q: `mimeType='application/vnd.google-apps.document' and fullText contains 'Notes by Gemini' and modifiedTime > '${sinceDate}'`,
      fields: 'files(id,name,modifiedTime)',
      pageSize: 50,
    });
    files = res.data.files || [];
  } catch (err) {
    console.error('[MeetSync] Drive search failed, skipping this run:', err.message);
    return;
  }

  console.log(`[MeetSync] Found ${files.length} candidate document(s)`);

  for (const file of files) {
    // Step 2: Deduplication check
    const existing = db.prepare('SELECT status FROM synced_meetings WHERE google_doc_id = ?').get(file.id);
    if (existing) {
      console.log(`[MeetSync] Already processed, skipping: ${file.name} (${existing.status})`);
      continue;
    }

    console.log(`[MeetSync] Processing document: ${file.name}`);

    // Step 3: Read document content
    let document;
    try {
      const docRes = await docs.documents.get({ documentId: file.id, includeTabsContent: true });
      document = docRes.data;
    } catch (err) {
      console.error(`[MeetSync] Failed to read document (${file.name}):`, err.message);
      db.prepare('INSERT OR IGNORE INTO synced_meetings (google_doc_id, doc_title, status) VALUES (?, ?, ?)')
        .run(file.id, file.name, 'error');
      continue;
    }

    // Step 4: Parse meeting start time from filename
    const timeMatch = file.name.match(/Meeting started (\d{4}\/\d{2}\/\d{2}) (\d{2}:\d{2}) (\w+)/)
      || extractBodyHtml(document.body?.content).match(/Meeting started (\d{4}\/\d{2}\/\d{2}) (\d{2}:\d{2}) (\w+)/);
    if (!timeMatch) {
      console.warn(`[MeetSync] Could not find meeting time, skipping: ${file.name}`);
      db.prepare('INSERT OR IGNORE INTO synced_meetings (google_doc_id, doc_title, status) VALUES (?, ?, ?)')
        .run(file.id, file.name, 'no_match');
      continue;
    }

    const [, dateStr, timeStr, tzStr] = timeMatch;
    const meetingStartMs = parseMeetingTime(dateStr, timeStr, tzStr);
    const meetingStartIso = new Date(meetingStartMs).toISOString();
    console.log(`[MeetSync] Parsed meeting time: ${meetingStartIso}`);

    // Step 5: Find matching HubSpot meeting by time window
    let matches;
    try {
      matches = await hubspot.findMeetingsByTimeWindow(meetingStartMs, windowMin);
    } catch (err) {
      console.error(`[MeetSync] HubSpot search failed (${file.name}):`, err.message);
      db.prepare('INSERT OR IGNORE INTO synced_meetings (google_doc_id, doc_title, meeting_start, status) VALUES (?, ?, ?, ?)')
        .run(file.id, file.name, meetingStartIso, 'error');
      continue;
    }

    if (matches.length === 0) {
      console.warn(`[MeetSync] No matching HubSpot meeting found (±${windowMin}min): ${file.name}`);
      db.prepare('INSERT OR IGNORE INTO synced_meetings (google_doc_id, doc_title, meeting_start, status) VALUES (?, ?, ?, ?)')
        .run(file.id, file.name, meetingStartIso, 'no_match');
      continue;
    }

    if (matches.length > 1) {
      console.warn(`[MeetSync] Multiple HubSpot meetings matched (${matches.length}), manual review needed: ${file.name}`);
      console.warn('[MeetSync] Matches:', matches.map((m) => `${m.id} "${m.title}" @${m.startTime}`).join(', '));
      db.prepare('INSERT OR IGNORE INTO synced_meetings (google_doc_id, doc_title, meeting_start, status) VALUES (?, ?, ?, ?)')
        .run(file.id, file.name, meetingStartIso, 'multi_match');
      continue;
    }

    const matched = matches[0];
    console.log(`[MeetSync] Matched HubSpot meeting: "${matched.title}" (id=${matched.id})`);

    // Step 6: Build meeting body HTML
    // Notes tab → formatted content (skip header metadata)
    // Transcript tab → link to Google Docs (opens in new window)
    const docBaseUrl = `https://docs.google.com/document/d/${file.id}/edit`;

    let bodyHtml = '';
    for (const tab of (document.tabs || [])) {
      const title = tab.tabProperties?.title || '';
      const tabId = tab.tabProperties?.tabId;

      if (title === 'Transcript') {
        const url = tabId ? `${docBaseUrl}?tab=t.${tabId}` : docBaseUrl;
        bodyHtml += `<hr><h2>Transcript</h2><p><a href="${url}" target="_blank" rel="noopener noreferrer">View full transcript in Google Docs →</a></p>`;
      } else {
        const rawContent = tab.documentTab?.body?.content || [];
        const filtered = trimGeminiFooter(skipMeetingHeader(rawContent));
        const html = extractBodyHtml(filtered);
        if (html.trim()) bodyHtml += html;
      }
    }

    // Fallback for older single-body documents (no tabs)
    if (!document.tabs || document.tabs.length === 0) {
      bodyHtml = extractBodyHtml(document.body?.content);
    }

    const truncated = bodyHtml.length > 65000
      ? bodyHtml.slice(0, 65000) + '<p><em>[Content truncated]</em></p>'
      : bodyHtml;

    // Step 7: Update HubSpot meeting body
    try {
      await hubspot.updateMeetingBody(matched.id, truncated);
    } catch (err) {
      console.error(`[MeetSync] Failed to update HubSpot meeting body (${file.name}):`, err.message);
      db.prepare('INSERT OR IGNORE INTO synced_meetings (google_doc_id, doc_title, meeting_start, status) VALUES (?, ?, ?, ?)')
        .run(file.id, file.name, meetingStartIso, 'error');
      continue;
    }

    // Step 8: Record sync result
    db.prepare(`
      INSERT OR IGNORE INTO synced_meetings (google_doc_id, hubspot_meeting_id, doc_title, meeting_start, status)
      VALUES (?, ?, ?, ?, 'synced')
    `).run(file.id, matched.id, file.name, meetingStartIso);

    console.log(`[MeetSync] Synced: "${file.name}" → HubSpot meeting ${matched.id}`);

    await new Promise((r) => setTimeout(r, 300));
  }

  console.log('[MeetSync] Sync run complete');
}

module.exports = { syncMeetings };

// Only start cron and run immediately when executed directly
if (require.main === module) {
  cron.schedule('0 * * * *', () => {
    syncMeetings().catch((err) => console.error('[MeetSync] Uncaught error:', err.message));
  });
  syncMeetings().catch((err) => console.error('[MeetSync] Startup sync failed:', err.message));
}

'use strict';

const path = require('path');
const Database = require('better-sqlite3');

let db;

function getDb() {
  if (!db) {
    db = new Database(path.join(__dirname, 'sync.db'));
    db.pragma('journal_mode = WAL');
    initSchema(db);
  }
  return db;
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS synced_meetings (
      google_doc_id       TEXT PRIMARY KEY,
      hubspot_meeting_id  TEXT,
      doc_title           TEXT,
      meeting_start       TEXT,
      synced_at           TEXT DEFAULT (datetime('now')),
      status              TEXT DEFAULT 'synced'
    );
  `);
}

module.exports = { getDb };

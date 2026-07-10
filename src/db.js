import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Open (or create) the SQLite database.
 * Creates the table if it doesn't exist.
 * Returns the Database instance.
 */
export function openDB(dbPath) {
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });

  const db = new Database(dbPath);

  // Enable WAL mode for better concurrent read performance
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS uploaded (
      cid          TEXT PRIMARY KEY,
      content_type TEXT,
      size_bytes   INTEGER,
      uploaded_at  TEXT DEFAULT (datetime('now'))
    )
  `);

  return db;
}

/**
 * Check if a CID has already been uploaded.
 */
export function isUploaded(db, cid) {
  const row = db.prepare('SELECT 1 FROM uploaded WHERE cid = ?').get(cid);
  return row !== undefined;
}

/**
 * Record a successful upload in the database.
 */
export function markUploaded(db, cid, contentType, sizeBytes) {
  db.prepare(`
    INSERT OR REPLACE INTO uploaded (cid, content_type, size_bytes, uploaded_at)
    VALUES (?, ?, ?, datetime('now'))
  `).run(cid, contentType, sizeBytes);
}

/**
 * Close the database connection.
 */
export function closeDB(db) {
  db.close();
}

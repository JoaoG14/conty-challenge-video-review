import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export function openDatabase(path = ":memory:"): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS campaigns (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      required_pieces TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS deliveries (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL REFERENCES campaigns(id),
      creator_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS versions (
      id TEXT PRIMARY KEY,
      delivery_id TEXT NOT NULL REFERENCES deliveries(id),
      piece_type TEXT NOT NULL CHECK (piece_type IN ('script', 'video', 'cover', 'caption')),
      number INTEGER NOT NULL CHECK (number > 0),
      content TEXT,
      url TEXT,
      duration_seconds REAL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'approved')),
      submitted_at TEXT NOT NULL,
      approved_at TEXT,
      UNIQUE (delivery_id, piece_type, number),
      CHECK (
        (piece_type IN ('script', 'caption') AND content IS NOT NULL AND url IS NULL AND duration_seconds IS NULL)
        OR (piece_type = 'cover' AND content IS NULL AND url IS NOT NULL AND duration_seconds IS NULL)
        OR (piece_type = 'video' AND content IS NULL AND url IS NOT NULL AND duration_seconds IS NOT NULL AND duration_seconds > 0)
      ),
      CHECK ((status = 'pending' AND approved_at IS NULL) OR (status = 'approved' AND approved_at IS NOT NULL))
    );

    CREATE TABLE IF NOT EXISTS comments (
      id TEXT PRIMARY KEY,
      version_id TEXT NOT NULL REFERENCES versions(id),
      second REAL NOT NULL CHECK (second >= 0),
      text TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS comments_by_version ON comments(version_id);
  `);
  return db;
}

export function transaction<T>(db: DatabaseSync, action: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = action();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

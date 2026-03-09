import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import type { ClockwerkEvent } from "./types";

const CLOCKWERK_DIR = resolve(process.env.HOME ?? "~", ".clockwerk");
const DB_PATH = resolve(CLOCKWERK_DIR, "clockwerk.db");

let _db: Database | null = null;

export function getDbPath(): string {
  return DB_PATH;
}

export function getDb(): Database {
  if (_db) return _db;

  if (!existsSync(CLOCKWERK_DIR)) {
    mkdirSync(CLOCKWERK_DIR, { recursive: true });
  }

  _db = new Database(DB_PATH, { create: true });

  // Performance pragmas
  _db.run("PRAGMA journal_mode = WAL");
  _db.run("PRAGMA synchronous = NORMAL");
  _db.run("PRAGMA cache_size = -8000");
  _db.run("PRAGMA busy_timeout = 3000");

  migrate(_db);

  return _db;
}

function migrate(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      timestamp INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      source TEXT NOT NULL,
      project_token TEXT NOT NULL,
      tool_name TEXT,
      description TEXT,
      file_path TEXT,
      branch TEXT,
      issue_id TEXT,
      topic TEXT,
      harness_session_id TEXT
    )
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_events_timestamp
    ON events(timestamp)
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_events_project
    ON events(project_token, timestamp)
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_events_session
    ON events(harness_session_id)
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_events_covering
    ON events(project_token, timestamp, harness_session_id, branch, issue_id, topic, source)
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      project_token TEXT NOT NULL,
      start_ts INTEGER NOT NULL,
      end_ts INTEGER NOT NULL,
      duration_seconds INTEGER NOT NULL,
      source TEXT NOT NULL,
      branch TEXT,
      issue_id TEXT,
      topics TEXT,        -- JSON array
      file_areas TEXT,    -- JSON array
      event_count INTEGER NOT NULL,
      description TEXT
    )
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_sessions_project
    ON sessions(project_token, start_ts)
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS sync_state (
      project_token TEXT PRIMARY KEY,
      watermark INTEGER NOT NULL DEFAULT 0
    )
  `);
}

const insertEventStmt = `
  INSERT OR IGNORE INTO events
    (id, timestamp, event_type, source, project_token, tool_name, description, file_path, branch, issue_id, topic, harness_session_id)
  VALUES
    (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

export function insertEvent(db: Database, event: ClockwerkEvent): void {
  db.run(insertEventStmt, [
    event.id,
    event.timestamp,
    event.event_type,
    event.source,
    event.project_token,
    event.context.tool_name ?? null,
    event.context.description ?? null,
    event.context.file_path ?? null,
    event.context.branch ?? null,
    event.context.issue_id ?? null,
    event.context.topic ?? null,
    event.harness_session_id ?? null,
  ]);
}

export function insertEvents(db: Database, events: ClockwerkEvent[]): void {
  const stmt = db.prepare(insertEventStmt);
  const tx = db.transaction((evts: ClockwerkEvent[]) => {
    for (const event of evts) {
      stmt.run(
        event.id,
        event.timestamp,
        event.event_type,
        event.source,
        event.project_token,
        event.context.tool_name ?? null,
        event.context.description ?? null,
        event.context.file_path ?? null,
        event.context.branch ?? null,
        event.context.issue_id ?? null,
        event.context.topic ?? null,
        event.harness_session_id ?? null,
      );
    }
  });
  tx(events);
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

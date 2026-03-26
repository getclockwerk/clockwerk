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

/**
 * Open the database in read-only mode. Useful for offline queries
 * (e.g., `clockwerk status` when the daemon isn't running).
 * Returns null if the database file doesn't exist.
 */
export function openDbReadOnly(): Database | null {
  if (!existsSync(DB_PATH)) return null;
  const db = new Database(DB_PATH, { readonly: true });
  db.run("PRAGMA busy_timeout = 1000");
  return db;
}

export function getDb(): Database {
  if (_db) return _db;

  if (!existsSync(CLOCKWERK_DIR)) {
    mkdirSync(CLOCKWERK_DIR, { recursive: true });
  }

  _db = new Database(DB_PATH, { create: true });

  _db.run("PRAGMA journal_mode = WAL");
  _db.run("PRAGMA synchronous = NORMAL");
  _db.run("PRAGMA cache_size = -8000");
  _db.run("PRAGMA busy_timeout = 3000");

  migrateDb(_db);

  return _db;
}

export function migrateDb(db: Database): void {
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
      event_count INTEGER NOT NULL DEFAULT 0,
      description TEXT,
      event_types TEXT,        -- JSON: {"tool_call": 12, "file_edit": 5}
      files_changed TEXT,      -- JSON array
      tools_used TEXT,         -- JSON array
      source_breakdown TEXT,   -- JSON: {"claude-code": 40, "file-watch": 5}
      commits TEXT,            -- JSON array of {hash, message, ts}
      sync_version INTEGER NOT NULL DEFAULT 1,
      synced_version INTEGER NOT NULL DEFAULT 0,
      deleted_at INTEGER,
      device_id TEXT
    )
  `);

  // Migrate existing sessions table to add new columns (must run before
  // indexes that reference the new columns like sync_version)
  migrateSessionsTable(db);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_sessions_project
    ON sessions(project_token, start_ts)
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_sessions_partition
    ON sessions(project_token, branch, end_ts)
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_sessions_dirty
    ON sessions(project_token) WHERE sync_version > synced_version
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS sync_deletes (
      session_id TEXT PRIMARY KEY,
      project_token TEXT NOT NULL,
      deleted_at INTEGER NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS sync_state (
      project_token TEXT PRIMARY KEY,
      watermark INTEGER NOT NULL DEFAULT 0,
      pull_watermark INTEGER NOT NULL DEFAULT 0
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS branch_links (
      project_token TEXT NOT NULL,
      branch TEXT NOT NULL,
      issue_id TEXT NOT NULL,
      issue_title TEXT,
      linked_at INTEGER NOT NULL,
      PRIMARY KEY (project_token, branch)
    )
  `);

  migrateSyncStateTable(db);
}

function migrateSyncStateTable(db: Database): void {
  const cols = db
    .query<{ name: string }, []>("PRAGMA table_info(sync_state)")
    .all()
    .map((c) => c.name);

  if (!cols.includes("pull_watermark")) {
    db.run("ALTER TABLE sync_state ADD COLUMN pull_watermark INTEGER NOT NULL DEFAULT 0");
  }
}

function migrateSessionsTable(db: Database): void {
  // Check if new columns exist by inspecting table_info
  const cols = db
    .query<{ name: string }, []>("PRAGMA table_info(sessions)")
    .all()
    .map((c) => c.name);

  const newColumns: [string, string][] = [
    ["event_types", "TEXT"],
    ["files_changed", "TEXT"],
    ["tools_used", "TEXT"],
    ["source_breakdown", "TEXT"],
    ["commits", "TEXT"],
    ["sync_version", "INTEGER NOT NULL DEFAULT 1"],
    ["synced_version", "INTEGER NOT NULL DEFAULT 0"],
    ["deleted_at", "INTEGER"],
    ["summary", "TEXT"],
    ["description_synced", "INTEGER NOT NULL DEFAULT 0"],
    ["summary_synced", "INTEGER NOT NULL DEFAULT 0"],
    ["device_id", "TEXT"],
    ["issue_title", "TEXT"],
  ];

  for (const [name, type] of newColumns) {
    if (!cols.includes(name)) {
      db.run(`ALTER TABLE sessions ADD COLUMN ${name} ${type}`);
    }
  }
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

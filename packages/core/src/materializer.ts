import type { Database } from "bun:sqlite";
import type { ClockwerkEvent, LocalSession } from "./types";
import { SESSION_GAP } from "./sessions";

const SESSION_MIN = 60; // minimum session duration in seconds

interface SessionRow {
  id: string;
  project_token: string;
  start_ts: number;
  end_ts: number;
  duration_seconds: number;
  source: string;
  sync_version: number;
  synced_version: number;
  deleted_at: number | null;
}

function rowToSession(row: SessionRow): LocalSession {
  return {
    id: row.id,
    project_token: row.project_token,
    start_ts: row.start_ts,
    end_ts: row.end_ts,
    duration_seconds: row.duration_seconds,
    source: row.source,
    sync_version: row.sync_version,
    synced_version: row.synced_version,
    deleted_at: row.deleted_at ?? undefined,
  };
}

/**
 * Incrementally materializes events into the local sessions table.
 *
 * On each event batch:
 * - For each event, find a matching session (same project_token, within SESSION_GAP)
 * - If found, extend the session
 * - If not, create a new session with a stable UUID
 *
 * Periodically merges adjacent sessions that fall within SESSION_GAP of each other.
 */
export class SessionMaterializer {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /**
   * Process a batch of events and upsert into the sessions table.
   * Called after insertEvents() in the daemon flush loop.
   */
  materializeEvents(events: ClockwerkEvent[]): void {
    if (events.length === 0) return;

    // Sort events by timestamp for deterministic processing
    const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp);

    const tx = this.db.transaction(() => {
      for (const event of sorted) {
        this.processEvent(event);
      }
    });
    tx();
  }

  private processEvent(event: ClockwerkEvent): void {
    // Find a matching session: same project_token, within SESSION_GAP
    const existing = this.db
      .query<SessionRow, [string, number, number, number]>(
        `SELECT id, project_token, start_ts, end_ts, duration_seconds, source,
                sync_version, synced_version, deleted_at
         FROM sessions
         WHERE project_token = ?
           AND end_ts >= (? - ${SESSION_GAP})
           AND start_ts <= (? + ${SESSION_GAP})
           AND deleted_at IS NULL
         ORDER BY ABS(end_ts - ?) ASC
         LIMIT 1`,
      )
      .get(event.project_token, event.timestamp, event.timestamp, event.timestamp);

    if (existing) {
      this.extendSession(existing, event);
    } else {
      this.createSession(event);
    }
  }

  private extendSession(session: SessionRow, event: ClockwerkEvent): void {
    const newStartTs = Math.min(session.start_ts, event.timestamp);
    let newEndTs = Math.max(session.end_ts, event.timestamp);

    // Enforce minimum duration
    if (newEndTs - newStartTs < SESSION_MIN) {
      newEndTs = newStartTs + SESSION_MIN;
    }

    const newDuration = newEndTs - newStartTs;

    this.db.run(
      `UPDATE sessions SET
        start_ts = ?, end_ts = ?, duration_seconds = ?,
        sync_version = sync_version + 1
      WHERE id = ?`,
      [newStartTs, newEndTs, newDuration, session.id],
    );
  }

  private createSession(event: ClockwerkEvent): void {
    const id = crypto.randomUUID();
    const startTs = event.timestamp;
    let endTs = event.timestamp;
    if (endTs - startTs < SESSION_MIN) {
      endTs = startTs + SESSION_MIN;
    }

    this.db.run(
      `INSERT INTO sessions
        (id, project_token, start_ts, end_ts, duration_seconds, source,
         sync_version, synced_version, deleted_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, 0, NULL)`,
      [id, event.project_token, startTs, endTs, endTs - startTs, event.source],
    );
  }

  /**
   * Merge adjacent sessions within the same project that have a gap <= SESSION_GAP.
   * Should be called periodically (e.g., every 30s).
   */
  mergeAdjacentSessions(): number {
    let mergeCount = 0;

    const tx = this.db.transaction(() => {
      const projects = this.db
        .query<
          { project_token: string },
          []
        >(`SELECT DISTINCT project_token FROM sessions WHERE deleted_at IS NULL`)
        .all();

      for (const { project_token } of projects) {
        mergeCount += this.mergePartition(project_token);
      }
    });
    tx();

    return mergeCount;
  }

  private mergePartition(projectToken: string): number {
    const sessions = this.db
      .query<SessionRow, [string]>(
        `SELECT id, project_token, start_ts, end_ts, duration_seconds, source,
                sync_version, synced_version, deleted_at
         FROM sessions
         WHERE project_token = ?
           AND deleted_at IS NULL
         ORDER BY start_ts ASC`,
      )
      .all(projectToken);

    if (sessions.length < 2) return 0;

    let mergeCount = 0;

    for (let i = 1; i < sessions.length; i++) {
      const prev = sessions[i - 1];
      const curr = sessions[i];

      // Check if gap between prev.end_ts and curr.start_ts is within SESSION_GAP
      if (curr.start_ts - prev.end_ts <= SESSION_GAP) {
        // Merge curr into prev
        this.mergeSessions(prev, curr);
        // Reload the updated prev for subsequent iterations
        const updated = this.db
          .query<SessionRow, [string]>(
            `SELECT id, project_token, start_ts, end_ts, duration_seconds, source,
                    sync_version, synced_version, deleted_at
             FROM sessions WHERE id = ?`,
          )
          .get(prev.id)!;
        sessions[i] = updated;
        sessions[i - 1] = updated;
        mergeCount++;
      }
    }

    return mergeCount;
  }

  private mergeSessions(target: SessionRow, source: SessionRow): void {
    const newStartTs = Math.min(target.start_ts, source.start_ts);
    let newEndTs = Math.max(target.end_ts, source.end_ts);
    if (newEndTs - newStartTs < SESSION_MIN) {
      newEndTs = newStartTs + SESSION_MIN;
    }

    // Update target session
    this.db.run(
      `UPDATE sessions SET
        start_ts = ?, end_ts = ?, duration_seconds = ?,
        sync_version = sync_version + 1
      WHERE id = ?`,
      [newStartTs, newEndTs, newEndTs - newStartTs, target.id],
    );

    // Soft-delete the source session and record for sync
    this.db.run(`UPDATE sessions SET deleted_at = ? WHERE id = ?`, [
      Math.floor(Date.now() / 1000),
      source.id,
    ]);

    this.db.run(
      `INSERT OR IGNORE INTO sync_deletes (session_id, project_token, deleted_at)
       VALUES (?, ?, ?)`,
      [source.id, source.project_token, Math.floor(Date.now() / 1000)],
    );
  }

  /**
   * Soft-delete a session. Records the deletion for sync.
   */
  deleteSession(sessionId: string): boolean {
    const existing = this.db
      .query<SessionRow, [string]>(
        `SELECT id, project_token, start_ts, end_ts, duration_seconds, source,
                sync_version, synced_version, deleted_at
         FROM sessions WHERE id = ? AND deleted_at IS NULL`,
      )
      .get(sessionId);

    if (!existing) return false;

    const now = Math.floor(Date.now() / 1000);

    this.db.run("UPDATE sessions SET deleted_at = ? WHERE id = ?", [now, sessionId]);
    this.db.run(
      `INSERT OR IGNORE INTO sync_deletes (session_id, project_token, deleted_at)
       VALUES (?, ?, ?)`,
      [sessionId, existing.project_token, now],
    );

    return true;
  }

  /**
   * Restore a soft-deleted session.
   */
  restoreSession(sessionId: string): boolean {
    const existing = this.db
      .query<SessionRow, [string]>(
        `SELECT id, project_token, start_ts, end_ts, duration_seconds, source,
                sync_version, synced_version, deleted_at
         FROM sessions WHERE id = ? AND deleted_at IS NOT NULL`,
      )
      .get(sessionId);

    if (!existing) return false;

    this.db.run(
      "UPDATE sessions SET deleted_at = NULL, sync_version = sync_version + 1 WHERE id = ?",
      [sessionId],
    );
    this.db.run("DELETE FROM sync_deletes WHERE session_id = ?", [sessionId]);

    return true;
  }

  /**
   * Get a single session by ID.
   */
  getSession(sessionId: string, includeDeleted = false): LocalSession | null {
    const where = includeDeleted ? "" : "AND deleted_at IS NULL";
    const row = this.db
      .query<SessionRow, [string]>(
        `SELECT id, project_token, start_ts, end_ts, duration_seconds, source,
                sync_version, synced_version, deleted_at
         FROM sessions WHERE id = ? ${where}`,
      )
      .get(sessionId);
    return row ? rowToSession(row) : null;
  }

  /**
   * Query soft-deleted sessions.
   */
  queryDeletedSessions(opts?: { since?: number; until?: number }): LocalSession[] {
    const conditions: string[] = ["deleted_at IS NOT NULL"];
    const params: (string | number)[] = [];

    if (opts?.since) {
      conditions.push("end_ts >= ?");
      params.push(opts.since);
    }
    if (opts?.until) {
      conditions.push("start_ts <= ?");
      params.push(opts.until);
    }

    const where = `WHERE ${conditions.join(" AND ")}`;
    const rows = this.db
      .query<SessionRow, (string | number)[]>(
        `SELECT id, project_token, start_ts, end_ts, duration_seconds, source,
                sync_version, synced_version, deleted_at
         FROM sessions ${where} ORDER BY start_ts ASC`,
      )
      .all(...params);

    return rows.map(rowToSession);
  }

  /**
   * Query sessions from the materialized sessions table.
   * Replaces computeSessions() for local queries.
   */
  querySessions(opts?: {
    projectToken?: string;
    since?: number;
    until?: number;
  }): LocalSession[] {
    const conditions: string[] = ["deleted_at IS NULL"];
    const params: (string | number)[] = [];

    if (opts?.projectToken) {
      conditions.push("project_token = ?");
      params.push(opts.projectToken);
    }
    if (opts?.since) {
      conditions.push("end_ts >= ?");
      params.push(opts.since);
    }
    if (opts?.until) {
      conditions.push("start_ts <= ?");
      params.push(opts.until);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.db
      .query<SessionRow, (string | number)[]>(
        `SELECT id, project_token, start_ts, end_ts, duration_seconds, source,
                sync_version, synced_version, deleted_at
         FROM sessions ${where} ORDER BY start_ts ASC`,
      )
      .all(...params);

    return rows.map(rowToSession);
  }

  /**
   * Check if the sessions table has any materialized sessions.
   * Used to determine if backfill is needed on first start.
   */
  hasAnySessions(): boolean {
    const row = this.db
      .query<
        { cnt: number },
        []
      >("SELECT COUNT(*) as cnt FROM sessions WHERE deleted_at IS NULL")
      .get();
    return (row?.cnt ?? 0) > 0;
  }

  /**
   * Check if there are events but no sessions (needs backfill).
   */
  needsBackfill(): boolean {
    if (this.hasAnySessions()) return false;
    const row = this.db
      .query<{ cnt: number }, []>("SELECT COUNT(*) as cnt FROM events")
      .get();
    return (row?.cnt ?? 0) > 0;
  }

  /**
   * Prune events older than the earliest active session minus SESSION_GAP.
   * Safe to run periodically - materialized sessions are the durable record.
   * Returns the number of events deleted.
   */
  pruneOldEvents(olderThanDays = 30): number {
    // Find the earliest active session's start_ts
    const earliest = this.db
      .query<
        { min_ts: number | null },
        []
      >("SELECT MIN(start_ts) as min_ts FROM sessions WHERE deleted_at IS NULL")
      .get();

    // Calculate cutoff: the earlier of (olderThanDays ago) or (earliest session - SESSION_GAP)
    const nowTs = Math.floor(Date.now() / 1000);
    const daysCutoff = nowTs - olderThanDays * 86400;

    let cutoff = daysCutoff;
    if (earliest?.min_ts) {
      cutoff = Math.min(cutoff, earliest.min_ts - SESSION_GAP);
    }

    if (cutoff <= 0) return 0;

    const result = this.db.run("DELETE FROM events WHERE timestamp < ?", [cutoff]);
    return result.changes;
  }

  /**
   * Backfill the sessions table from existing events.
   * Uses the existing computeSessions() logic, then inserts with stable UUIDs.
   */
  backfillFromEvents(
    computeSessionsFn: (
      db: Database,
      projectToken: string,
      since?: number,
    ) => import("./types").Session[],
  ): void {
    const tokens = this.db
      .query<{ project_token: string }, []>("SELECT DISTINCT project_token FROM events")
      .all()
      .map((r) => r.project_token);

    const tx = this.db.transaction(() => {
      for (const token of tokens) {
        const sessions = computeSessionsFn(this.db, token);
        for (const session of sessions) {
          const id = crypto.randomUUID();
          this.db.run(
            `INSERT OR IGNORE INTO sessions
              (id, project_token, start_ts, end_ts, duration_seconds, source,
               sync_version, synced_version, deleted_at)
            VALUES (?, ?, ?, ?, ?, ?, 1, 0, NULL)`,
            [
              id,
              token,
              session.start_ts,
              session.end_ts,
              session.duration_seconds,
              session.source,
            ],
          );
        }
      }
    });
    tx();
  }
}

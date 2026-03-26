import type { Database } from "bun:sqlite";
import type { ClockwerkEvent, LocalSession } from "./types";
import { SESSION_GAP } from "./sessions";

const SESSION_MIN = 60; // minimum session duration in seconds

const TEMP_EXTENSIONS = [".tmp", ".temp", ".swp", ".swo", ".bak", ".orig"];

function isTempFile(filePath: string): boolean {
  const basename = filePath.split("/").pop() ?? filePath;
  for (const ext of TEMP_EXTENSIONS) {
    if (basename.endsWith(ext)) return true;
  }
  if (basename.includes(".tmp.") || basename.includes(".temp.")) return true;
  if (basename.endsWith("~")) return true;
  return false;
}

interface SessionRow {
  id: string;
  project_token: string;
  start_ts: number;
  end_ts: number;
  duration_seconds: number;
  source: string;
  branch: string | null;
  issue_id: string | null;
  issue_title: string | null;
  topics: string | null;
  file_areas: string | null;
  event_count: number;
  description: string | null;
  event_types: string | null;
  files_changed: string | null;
  tools_used: string | null;
  source_breakdown: string | null;
  commits: string | null;
  summary: string | null;
  sync_version: number;
  synced_version: number;
  deleted_at: number | null;
}

function parseJsonArray(val: string | null): string[] {
  if (!val) return [];
  try {
    return JSON.parse(val);
  } catch {
    return [];
  }
}

function parseJsonObj<T>(val: string | null): T | undefined {
  if (!val) return undefined;
  try {
    return JSON.parse(val);
  } catch {
    return undefined;
  }
}

function rowToSession(row: SessionRow): LocalSession {
  return {
    id: row.id,
    project_token: row.project_token,
    start_ts: row.start_ts,
    end_ts: row.end_ts,
    duration_seconds: row.duration_seconds,
    source: row.source,
    branch: row.branch ?? undefined,
    issue_id: row.issue_id ?? undefined,
    issue_title: row.issue_title ?? undefined,
    topics: parseJsonArray(row.topics),
    file_areas: parseJsonArray(row.file_areas),
    event_count: row.event_count,
    description: row.description ?? undefined,
    summary: parseJsonObj(row.summary),
    event_types: parseJsonObj(row.event_types),
    files_changed: parseJsonArray(row.files_changed) || undefined,
    tools_used: parseJsonArray(row.tools_used) || undefined,
    source_breakdown: parseJsonObj(row.source_breakdown),
    commits: parseJsonObj(row.commits),
    sync_version: row.sync_version,
    synced_version: row.synced_version,
    deleted_at: row.deleted_at ?? undefined,
  };
}

/**
 * Incrementally materializes events into the local sessions table.
 *
 * On each event batch:
 * - For each event, find a matching session (same project_token + branch, within SESSION_GAP)
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
    const branch = event.context.branch ?? null;

    // Find a matching session: same project_token + branch, within SESSION_GAP
    const existing = this.db
      .query<SessionRow, [string, string | null, string | null, number, number, number]>(
        `SELECT * FROM sessions
         WHERE project_token = ?
           AND (branch = ? OR (branch IS NULL AND ? IS NULL))
           AND end_ts >= (? - ${SESSION_GAP})
           AND start_ts <= (? + ${SESSION_GAP})
           AND deleted_at IS NULL
         ORDER BY ABS(end_ts - ?) ASC
         LIMIT 1`,
      )
      .get(
        event.project_token,
        branch,
        branch,
        event.timestamp,
        event.timestamp,
        event.timestamp,
      );

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

    const newEventCount = session.event_count + 1;
    const newDuration = newEndTs - newStartTs;

    // Merge metadata
    const topics = new Set(parseJsonArray(session.topics));
    if (event.context.topic) topics.add(event.context.topic);

    const files = new Set(parseJsonArray(session.files_changed));
    if (event.context.file_path) {
      const paths = event.context.file_path.includes(", ")
        ? event.context.file_path.split(", ")
        : [event.context.file_path];
      for (const fp of paths) {
        if (fp && !isTempFile(fp)) files.add(fp);
      }
    }

    // Recompute file areas from all files
    const areas = new Set<string>();
    for (const fp of files) {
      const parts = fp.split("/");
      const area = parts.slice(0, Math.min(2, parts.length)).join("/");
      if (area) areas.add(area);
    }

    const tools = new Set(parseJsonArray(session.tools_used));
    if (event.context.tool_name) tools.add(event.context.tool_name);

    // Update event type counts
    const eventTypes: Record<string, number> = parseJsonObj(session.event_types) ?? {};
    eventTypes[event.event_type] = (eventTypes[event.event_type] ?? 0) + 1;

    // Update source breakdown
    const sourceBreakdown: Record<string, number> =
      parseJsonObj(session.source_breakdown) ?? {};
    sourceBreakdown[event.source] = (sourceBreakdown[event.source] ?? 0) + 1;

    // Pick primary source (most common)
    let primarySource = session.source;
    let maxCount = 0;
    for (const [src, count] of Object.entries(sourceBreakdown)) {
      if (count > maxCount) {
        primarySource = src;
        maxCount = count;
      }
    }

    const newBranch = session.branch ?? event.context.branch ?? null;
    let issueId = session.issue_id ?? event.context.issue_id ?? null;
    let issueTitle: string | null = session.issue_title ?? null;

    // Fallback: look up branch_links if still no issue_id
    if (!issueId && newBranch) {
      const link = this.db
        .query<
          { issue_id: string; issue_title: string | null },
          [string, string]
        >("SELECT issue_id, issue_title FROM branch_links WHERE project_token = ? AND branch = ?")
        .get(event.project_token, newBranch);
      if (link) {
        issueId = link.issue_id;
        issueTitle = link.issue_title;
      }
    }

    this.db.run(
      `UPDATE sessions SET
        start_ts = ?, end_ts = ?, duration_seconds = ?,
        source = ?, branch = ?, issue_id = ?, issue_title = ?,
        topics = ?, file_areas = ?, event_count = ?,
        event_types = ?, files_changed = ?, tools_used = ?,
        source_breakdown = ?,
        sync_version = sync_version + 1
      WHERE id = ?`,
      [
        newStartTs,
        newEndTs,
        newDuration,
        primarySource,
        newBranch,
        issueId,
        issueTitle,
        topics.size > 0 ? JSON.stringify([...topics]) : null,
        areas.size > 0 ? JSON.stringify([...areas]) : null,
        newEventCount,
        JSON.stringify(eventTypes),
        files.size > 0 ? JSON.stringify([...files]) : null,
        tools.size > 0 ? JSON.stringify([...tools]) : null,
        Object.keys(sourceBreakdown).length > 1 ? JSON.stringify(sourceBreakdown) : null,
        session.id,
      ],
    );
  }

  private createSession(event: ClockwerkEvent): void {
    const id = crypto.randomUUID();
    const startTs = event.timestamp;
    let endTs = event.timestamp;
    if (endTs - startTs < SESSION_MIN) {
      endTs = startTs + SESSION_MIN;
    }

    const topics: string[] = [];
    if (event.context.topic) topics.push(event.context.topic);

    const files: string[] = [];
    if (event.context.file_path) {
      const paths = event.context.file_path.includes(", ")
        ? event.context.file_path.split(", ")
        : [event.context.file_path];
      for (const fp of paths) {
        if (fp && !isTempFile(fp)) files.push(fp);
      }
    }

    const areas = new Set<string>();
    for (const fp of files) {
      const parts = fp.split("/");
      const area = parts.slice(0, Math.min(2, parts.length)).join("/");
      if (area) areas.add(area);
    }

    const tools: string[] = [];
    if (event.context.tool_name) tools.push(event.context.tool_name);

    const eventTypes: Record<string, number> = { [event.event_type]: 1 };

    const branch = event.context.branch ?? null;
    let issueId = event.context.issue_id ?? null;
    let issueTitle: string | null = null;

    if (!issueId && branch) {
      const link = this.db
        .query<
          { issue_id: string; issue_title: string | null },
          [string, string]
        >("SELECT issue_id, issue_title FROM branch_links WHERE project_token = ? AND branch = ?")
        .get(event.project_token, branch);
      if (link) {
        issueId = link.issue_id;
        issueTitle = link.issue_title;
      }
    }

    this.db.run(
      `INSERT INTO sessions
        (id, project_token, start_ts, end_ts, duration_seconds, source,
         branch, issue_id, issue_title, topics, file_areas, event_count, description,
         event_types, files_changed, tools_used, source_breakdown, commits,
         sync_version, synced_version, deleted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, NULL)`,
      [
        id,
        event.project_token,
        startTs,
        endTs,
        endTs - startTs,
        event.source,
        branch,
        issueId,
        issueTitle,
        topics.length > 0 ? JSON.stringify(topics) : null,
        areas.size > 0 ? JSON.stringify([...areas]) : null,
        1, // event_count
        event.context.description ?? null,
        JSON.stringify(eventTypes),
        files.length > 0 ? JSON.stringify(files) : null,
        tools.length > 0 ? JSON.stringify(tools) : null,
        null, // source_breakdown (only one source)
        null, // commits
      ],
    );
  }

  /**
   * Merge adjacent sessions within the same partition that have a gap <= SESSION_GAP.
   * Should be called periodically (e.g., every 30s).
   */
  mergeAdjacentSessions(): number {
    let mergeCount = 0;

    const tx = this.db.transaction(() => {
      // Get distinct partitions (project_token + branch)
      const partitions = this.db
        .query<{ project_token: string; branch: string | null }, []>(
          `SELECT DISTINCT project_token, branch FROM sessions
           WHERE deleted_at IS NULL`,
        )
        .all();

      for (const { project_token, branch } of partitions) {
        mergeCount += this.mergePartition(project_token, branch);
      }
    });
    tx();

    return mergeCount;
  }

  private mergePartition(projectToken: string, branch: string | null): number {
    const sessions = this.db
      .query<SessionRow, [string, string | null, string | null]>(
        `SELECT * FROM sessions
         WHERE project_token = ?
           AND (branch = ? OR (branch IS NULL AND ? IS NULL))
           AND deleted_at IS NULL
         ORDER BY start_ts ASC`,
      )
      .all(projectToken, branch, branch);

    if (sessions.length < 2) return 0;

    let mergeCount = 0;

    for (let i = 1; i < sessions.length; i++) {
      const prev = sessions[i - 1];
      const curr = sessions[i];

      // Check if gap between prev.end_ts and curr.start_ts is within SESSION_GAP
      if (curr.start_ts - prev.end_ts <= SESSION_GAP) {
        // Merge curr into prev
        this.mergeSessions(prev, curr);
        // Mark curr as the merged result for subsequent iterations
        sessions[i] = this.db
          .query<SessionRow, [string]>("SELECT * FROM sessions WHERE id = ?")
          .get(prev.id)!;
        // The previous session index now points to the updated prev
        // Adjust so the next iteration compares against the merged result
        sessions[i - 1] = sessions[i];
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

    const newEventCount = target.event_count + source.event_count;

    // Merge metadata
    const topics = new Set([
      ...parseJsonArray(target.topics),
      ...parseJsonArray(source.topics),
    ]);
    const files = new Set([
      ...parseJsonArray(target.files_changed),
      ...parseJsonArray(source.files_changed),
    ]);
    const areas = new Set<string>();
    for (const fp of files) {
      const parts = fp.split("/");
      const area = parts.slice(0, Math.min(2, parts.length)).join("/");
      if (area) areas.add(area);
    }
    const tools = new Set([
      ...parseJsonArray(target.tools_used),
      ...parseJsonArray(source.tools_used),
    ]);

    // Merge event types
    const eventTypes: Record<string, number> = parseJsonObj(target.event_types) ?? {};
    const srcEventTypes: Record<string, number> = parseJsonObj(source.event_types) ?? {};
    for (const [k, v] of Object.entries(srcEventTypes)) {
      eventTypes[k] = (eventTypes[k] ?? 0) + v;
    }

    // Merge source breakdown
    const sourceBreakdown: Record<string, number> =
      parseJsonObj(target.source_breakdown) ?? {};
    const srcSourceBreakdown: Record<string, number> =
      parseJsonObj(source.source_breakdown) ?? {};
    for (const [k, v] of Object.entries(srcSourceBreakdown)) {
      sourceBreakdown[k] = (sourceBreakdown[k] ?? 0) + v;
    }

    // Pick primary source
    let primarySource = target.source;
    let maxCount = 0;
    for (const [src, count] of Object.entries(sourceBreakdown)) {
      if (count > maxCount) {
        primarySource = src;
        maxCount = count;
      }
    }
    // If breakdown is empty (single-source sessions), keep target's source
    if (Object.keys(sourceBreakdown).length === 0) {
      primarySource = target.source;
    }

    // Merge commits
    const targetCommits =
      parseJsonObj<Array<{ hash: string; message: string; ts: number }>>(
        target.commits,
      ) ?? [];
    const sourceCommits =
      parseJsonObj<Array<{ hash: string; message: string; ts: number }>>(
        source.commits,
      ) ?? [];
    const allCommits = [...targetCommits, ...sourceCommits].sort((a, b) => a.ts - b.ts);

    // Keep first non-null
    const issueId = target.issue_id ?? source.issue_id;
    const description = target.description ?? source.description;

    // Update target session
    this.db.run(
      `UPDATE sessions SET
        start_ts = ?, end_ts = ?, duration_seconds = ?,
        source = ?, issue_id = ?,
        topics = ?, file_areas = ?, event_count = ?, description = ?,
        event_types = ?, files_changed = ?, tools_used = ?,
        source_breakdown = ?, commits = ?,
        sync_version = sync_version + 1
      WHERE id = ?`,
      [
        newStartTs,
        newEndTs,
        newEndTs - newStartTs,
        primarySource,
        issueId,
        topics.size > 0 ? JSON.stringify([...topics]) : null,
        areas.size > 0 ? JSON.stringify([...areas]) : null,
        newEventCount,
        description,
        Object.keys(eventTypes).length > 0 ? JSON.stringify(eventTypes) : null,
        files.size > 0 ? JSON.stringify([...files]) : null,
        tools.size > 0 ? JSON.stringify([...tools]) : null,
        Object.keys(sourceBreakdown).length > 1 ? JSON.stringify(sourceBreakdown) : null,
        allCommits.length > 0 ? JSON.stringify(allCommits) : null,
        target.id,
      ],
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
   * Update a session's mutable fields (currently: description).
   * Bumps sync_version so the change is picked up by sync.
   */
  updateSession(
    sessionId: string,
    updates: { description?: string; summary?: string },
  ): LocalSession | null {
    const existing = this.db
      .query<
        SessionRow,
        [string]
      >("SELECT * FROM sessions WHERE id = ? AND deleted_at IS NULL")
      .get(sessionId);

    if (!existing) return null;

    const setClauses: string[] = [];
    const params: (string | number | null)[] = [];

    if (updates.description !== undefined) {
      setClauses.push("description = ?");
      params.push(updates.description || null);
      setClauses.push("description_synced = 0");
    }

    if (updates.summary !== undefined) {
      setClauses.push("summary = ?");
      params.push(updates.summary || null);
      setClauses.push("summary_synced = 0");
    }

    if (setClauses.length === 0) return rowToSession(existing);

    setClauses.push("sync_version = sync_version + 1");
    params.push(sessionId);

    this.db.run(`UPDATE sessions SET ${setClauses.join(", ")} WHERE id = ?`, params);

    const updated = this.db
      .query<
        SessionRow,
        [string]
      >("SELECT * FROM sessions WHERE id = ? AND deleted_at IS NULL")
      .get(sessionId);

    return updated ? rowToSession(updated) : null;
  }

  /**
   * Soft-delete a session. Records the deletion for sync.
   */
  deleteSession(sessionId: string): boolean {
    const existing = this.db
      .query<
        SessionRow,
        [string]
      >("SELECT * FROM sessions WHERE id = ? AND deleted_at IS NULL")
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
      .query<
        SessionRow,
        [string]
      >("SELECT * FROM sessions WHERE id = ? AND deleted_at IS NOT NULL")
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
      .query<SessionRow, [string]>(`SELECT * FROM sessions WHERE id = ? ${where}`)
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
      .query<
        SessionRow,
        (string | number)[]
      >(`SELECT * FROM sessions ${where} ORDER BY start_ts ASC`)
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
      .query<
        SessionRow,
        (string | number)[]
      >(`SELECT * FROM sessions ${where} ORDER BY start_ts ASC`)
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
   * Backfill the sessions table from existing events.
   * Uses the existing computeSessions() logic, then inserts with stable UUIDs.
   */
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
          // Generate a stable UUID for each backfilled session
          const id = crypto.randomUUID();
          this.db.run(
            `INSERT OR IGNORE INTO sessions
              (id, project_token, start_ts, end_ts, duration_seconds, source,
               branch, issue_id, topics, file_areas, event_count, description,
               event_types, files_changed, tools_used, source_breakdown, commits,
               sync_version, synced_version, deleted_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, NULL)`,
            [
              id,
              session.project_token,
              session.start_ts,
              session.end_ts,
              session.duration_seconds,
              session.source,
              session.branch ?? null,
              session.issue_id ?? null,
              session.topics.length > 0 ? JSON.stringify(session.topics) : null,
              session.file_areas.length > 0 ? JSON.stringify(session.file_areas) : null,
              session.event_count,
              session.description ?? null,
              session.event_types ? JSON.stringify(session.event_types) : null,
              session.files_changed ? JSON.stringify(session.files_changed) : null,
              session.tools_used ? JSON.stringify(session.tools_used) : null,
              session.source_breakdown ? JSON.stringify(session.source_breakdown) : null,
              session.commits ? JSON.stringify(session.commits) : null,
            ],
          );
        }
      }
    });
    tx();
  }
}

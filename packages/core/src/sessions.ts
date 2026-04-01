import type { Database } from "bun:sqlite";
import type { Session } from "./types";

export const SESSION_GAP = 1500; // 25 minutes in seconds
const SESSION_MIN = 60; // minimum session duration in seconds

interface EventRow {
  id: string;
  timestamp: number;
  event_type: string;
  source: string;
  project_token: string;
  tool_name: string | null;
  description: string | null;
  file_path: string | null;
  branch: string | null;
  issue_id: string | null;
  topic: string | null;
  harness_session_id: string | null;
}

/**
 * Compute sessions from raw events.
 *
 * Ported from tt's compute_sessions_sql() - same algorithm:
 * 1. Partition events by harness_session_id (or project:branch fallback)
 * 2. Detect gaps > 25 minutes between consecutive events
 * 3. Group consecutive events between gaps into sessions
 * 4. Enforce minimum 60s per session
 */
export function computeSessions(
  db: Database,
  projectToken: string,
  since?: number,
  sessionGap?: number,
): Session[] {
  const sinceTs = since ?? 0;
  const gapThreshold = sessionGap ?? SESSION_GAP;

  const events = db
    .query<EventRow, [string, number]>(
      `SELECT * FROM events
       WHERE project_token = ? AND timestamp >= ?
       ORDER BY timestamp ASC`,
    )
    .all(projectToken, sinceTs);

  if (events.length === 0) return [];

  const partitions = new Map<string, EventRow[]>();
  for (const event of events) {
    const key = `${event.project_token}:${event.branch ?? "default"}`;
    const partition = partitions.get(key);
    if (partition) {
      partition.push(event);
    } else {
      partitions.set(key, [event]);
    }
  }

  const sessions: Session[] = [];

  for (const [partitionKey, partEvents] of partitions) {
    let sessionStart = partEvents[0].timestamp;
    let sessionEvents: EventRow[] = [partEvents[0]];

    for (let i = 1; i < partEvents.length; i++) {
      const gap = partEvents[i].timestamp - partEvents[i - 1].timestamp;

      if (gap > gapThreshold) {
        sessions.push(buildSession(partitionKey, sessionStart, sessionEvents));
        sessionStart = partEvents[i].timestamp;
        sessionEvents = [partEvents[i]];
      } else {
        sessionEvents.push(partEvents[i]);
      }
    }

    sessions.push(buildSession(partitionKey, sessionStart, sessionEvents));
  }

  sessions.sort((a, b) => a.start_ts - b.start_ts);

  return sessions;
}

function buildSession(
  partitionKey: string,
  startTs: number,
  events: EventRow[],
): Session {
  const lastEvent = events[events.length - 1];
  let endTs = lastEvent.timestamp;

  if (endTs - startTs < SESSION_MIN) {
    endTs = startTs + SESSION_MIN;
  }

  const sourceCounts = new Map<string, number>();
  for (const e of events) {
    sourceCounts.set(e.source, (sourceCounts.get(e.source) ?? 0) + 1);
  }
  let primarySource = events[0].source;
  let maxCount = 0;
  for (const [source, count] of sourceCounts) {
    if (count > maxCount) {
      primarySource = source;
      maxCount = count;
    }
  }

  return {
    id: `${partitionKey}:${startTs}`,
    project_token: events[0].project_token,
    start_ts: startTs,
    end_ts: endTs,
    duration_seconds: endTs - startTs,
    source: primarySource,
  };
}

/**
 * Merge overlapping session intervals and return total wall-clock seconds.
 * Ported from tt's merge_intervals_total().
 */
export function mergeSessionsDuration(sessions: Session[]): number {
  if (sessions.length === 0) return 0;

  const sorted = [...sessions].sort((a, b) => a.start_ts - b.start_ts);

  let total = 0;
  let curStart = sorted[0].start_ts;
  let curEnd = sorted[0].end_ts;

  for (let i = 1; i < sorted.length; i++) {
    const s = sorted[i];
    if (s.start_ts <= curEnd) {
      if (s.end_ts > curEnd) curEnd = s.end_ts;
    } else {
      total += curEnd - curStart;
      curStart = s.start_ts;
      curEnd = s.end_ts;
    }
  }

  total += curEnd - curStart;

  return total;
}

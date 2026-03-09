import type { Database } from "bun:sqlite";
import type { Session } from "./types";

export const SESSION_GAP = 300; // 5 minutes in seconds
const SESSION_MIN = 60; // minimum session duration in seconds

const TEMP_EXTENSIONS = [".tmp", ".temp", ".swp", ".swo", ".bak", ".orig"];

/** Filter out temporary/transient files from session file lists. */
function isTempFile(filePath: string): boolean {
  const basename = filePath.split("/").pop() ?? filePath;
  for (const ext of TEMP_EXTENSIONS) {
    if (basename.endsWith(ext)) return true;
  }
  // Patterns like "foo.tmp.js", "bar.temp.tsx"
  if (basename.includes(".tmp.") || basename.includes(".temp.")) return true;
  // Editor backup files like "file.txt~"
  if (basename.endsWith("~")) return true;
  return false;
}

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
 * Ported from tt's compute_sessions_sql() — same algorithm:
 * 1. Partition events by harness_session_id (or project:branch fallback)
 * 2. Detect gaps > 5 minutes between consecutive events
 * 3. Group consecutive events between gaps into sessions
 * 4. Enforce minimum 60s per session
 */
export function computeSessions(
  db: Database,
  projectToken: string,
  since?: number,
): Session[] {
  const sinceTs = since ?? 0;

  const events = db
    .query<EventRow, [string, number]>(
      `SELECT * FROM events
       WHERE project_token = ? AND timestamp >= ?
       ORDER BY timestamp ASC`,
    )
    .all(projectToken, sinceTs);

  if (events.length === 0) return [];

  // Group events by partition key
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

  // Compute sessions per partition
  const sessions: Session[] = [];

  for (const [partitionKey, partEvents] of partitions) {
    let sessionStart = partEvents[0].timestamp;
    let sessionEvents: EventRow[] = [partEvents[0]];

    for (let i = 1; i < partEvents.length; i++) {
      const gap = partEvents[i].timestamp - partEvents[i - 1].timestamp;

      if (gap > SESSION_GAP) {
        // Gap detected — flush current session
        sessions.push(buildSession(partitionKey, sessionStart, sessionEvents));
        sessionStart = partEvents[i].timestamp;
        sessionEvents = [partEvents[i]];
      } else {
        sessionEvents.push(partEvents[i]);
      }
    }

    // Flush last session
    sessions.push(buildSession(partitionKey, sessionStart, sessionEvents));
  }

  // Sort by start time
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

  // Enforce minimum duration
  if (endTs - startTs < SESSION_MIN) {
    endTs = startTs + SESSION_MIN;
  }

  // Aggregate sources — pick the most common one + breakdown
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

  // Event type breakdown
  const eventTypeCounts: Record<string, number> = {};
  for (const e of events) {
    eventTypeCounts[e.event_type] = (eventTypeCounts[e.event_type] ?? 0) + 1;
  }

  // Aggregate topics
  const topicSet = new Set<string>();
  for (const e of events) {
    if (e.topic) topicSet.add(e.topic);
  }

  // Collect individual file paths, filtering out temp/transient files
  const fileSet = new Set<string>();
  for (const e of events) {
    if (!e.file_path) continue;
    // Heartbeat events join multiple paths with ", "
    const paths = e.file_path.includes(", ") ? e.file_path.split(", ") : [e.file_path];
    for (const fp of paths) {
      if (fp && !isTempFile(fp)) fileSet.add(fp);
    }
  }

  // Aggregate file areas (top-level directory from file paths)
  const areaSet = new Set<string>();
  for (const fp of fileSet) {
    const parts = fp.split("/");
    const area = parts.slice(0, Math.min(2, parts.length)).join("/");
    if (area) areaSet.add(area);
  }

  // Collect tool names
  const toolSet = new Set<string>();
  for (const e of events) {
    if (e.tool_name) toolSet.add(e.tool_name);
  }

  // Use first non-null issue_id and branch
  const issueId = events.find((e) => e.issue_id)?.issue_id ?? undefined;
  const branch = events.find((e) => e.branch)?.branch ?? undefined;

  // Source breakdown only if multiple sources
  const sourceBreakdown =
    sourceCounts.size > 1 ? Object.fromEntries(sourceCounts) : undefined;

  return {
    id: `${partitionKey}:${startTs}`,
    project_token: events[0].project_token,
    start_ts: startTs,
    end_ts: endTs,
    duration_seconds: endTs - startTs,
    source: primarySource,
    branch,
    issue_id: issueId,
    topics: [...topicSet],
    file_areas: [...areaSet],
    event_count: events.length,
    event_types: eventTypeCounts,
    files_changed: fileSet.size > 0 ? [...fileSet] : undefined,
    tools_used: toolSet.size > 0 ? [...toolSet] : undefined,
    source_breakdown: sourceBreakdown,
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
      // Overlapping — extend
      if (s.end_ts > curEnd) curEnd = s.end_ts;
    } else {
      // Gap — flush
      total += curEnd - curStart;
      curStart = s.start_ts;
      curEnd = s.end_ts;
    }
  }

  // Flush last interval
  total += curEnd - curStart;

  return total;
}

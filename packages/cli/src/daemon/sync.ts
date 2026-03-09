import type { Database } from "bun:sqlite";
import {
  getUserConfig,
  computeSessions,
  getCommitsInRange,
  getProjectRegistry,
  SESSION_GAP,
} from "@clockwerk/core";

const SYNC_INTERVAL_MS = 30_000; // 30 seconds

let syncTimer: ReturnType<typeof setInterval> | null = null;

function getSyncWatermark(db: Database, projectToken: string): number {
  const row = db
    .query<
      { watermark: number },
      [string]
    >("SELECT watermark FROM sync_state WHERE project_token = ?")
    .get(projectToken);
  return row?.watermark ?? 0;
}

function setSyncWatermark(db: Database, projectToken: string, watermark: number): void {
  db.run(
    `INSERT INTO sync_state (project_token, watermark) VALUES (?, ?)
     ON CONFLICT(project_token) DO UPDATE SET watermark = ?`,
    [projectToken, watermark, watermark],
  );
}

async function syncProject(db: Database, projectToken: string): Promise<void> {
  const userConfig = getUserConfig();
  if (!userConfig) return; // Not logged in, skip sync

  const watermark = getSyncWatermark(db, projectToken);

  // Check if there are any new events since the watermark before doing work
  const hasNewEvents = db
    .query<
      { c: number },
      [string, number]
    >("SELECT COUNT(*) as c FROM events WHERE project_token = ? AND timestamp > ?")
    .get(projectToken, watermark);
  if (!hasNewEvents || hasNewEvents.c === 0) return;

  // Look back by SESSION_GAP so ongoing sessions get recomputed with their
  // full event range instead of fragmenting into 1-min sessions.
  // The cloud upsert (onConflictDoUpdate) handles updating existing sessions.
  const lookback = Math.max(0, watermark - SESSION_GAP);
  const sessions = computeSessions(db, projectToken, lookback);

  if (sessions.length === 0) return;

  // Enrich sessions with git commits
  const registry = getProjectRegistry();
  const projectDir = registry.find((r) => r.project_token === projectToken)?.directory;
  if (projectDir) {
    for (const s of sessions) {
      const commits = getCommitsInRange(projectDir, s.start_ts, s.end_ts);
      if (commits.length > 0) s.commits = commits;
    }
  }

  try {
    const res = await fetch(`${userConfig.api_url}/api/v1/sync`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userConfig.token}`,
      },
      body: JSON.stringify({
        project_token: projectToken,
        sessions: sessions.map((s) => ({
          id: s.id,
          start_ts: s.start_ts,
          end_ts: s.end_ts,
          duration_seconds: s.duration_seconds,
          source: s.source,
          branch: s.branch,
          issue_id: s.issue_id,
          topics: s.topics,
          file_areas: s.file_areas,
          event_count: s.event_count,
          description: s.description,
          commits: s.commits,
          event_types: s.event_types,
          files_changed: s.files_changed,
          tools_used: s.tools_used,
          source_breakdown: s.source_breakdown,
        })),
        watermark,
      }),
    });

    if (res.ok) {
      await res.json();
      // Update watermark to latest event timestamp
      const latestTs = Math.max(...sessions.map((s) => s.end_ts));
      setSyncWatermark(db, projectToken, latestTs);
    }
  } catch {
    // Network error — will retry next cycle
  }
}

export function startSync(db: Database): void {
  syncTimer = setInterval(async () => {
    // Get all project tokens with events
    const tokens = db
      .query<{ project_token: string }, []>("SELECT DISTINCT project_token FROM events")
      .all()
      .map((r) => r.project_token);

    for (const token of tokens) {
      await syncProject(db, token);
    }
  }, SYNC_INTERVAL_MS);
}

export function stopSync(): void {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
}

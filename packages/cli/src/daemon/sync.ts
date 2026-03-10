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
          topics: s.topics.slice(0, 50),
          file_areas: s.file_areas.slice(0, 100),
          event_count: s.event_count,
          description: s.description,
          commits: s.commits?.slice(0, 200),
          event_types: s.event_types,
          files_changed: s.files_changed?.slice(0, 500),
          tools_used: s.tools_used?.slice(0, 100),
          source_breakdown: s.source_breakdown,
        })),
        watermark,
      }),
    });

    if (res.ok) {
      const result = await res.json();
      // Only advance watermark if the server actually accepted sessions
      if (result.accepted > 0) {
        const latestTs = Math.max(...sessions.map((s) => s.end_ts));
        setSyncWatermark(db, projectToken, latestTs);
      }
    }
  } catch {
    // Network error — will retry next cycle
  }
}

export function startSync(db: Database): void {
  syncTimer = setInterval(async () => {
    // Only sync registered projects, not stale tokens left in the events table
    const registry = getProjectRegistry();
    const registeredTokens = new Set(registry.map((r) => r.project_token));

    const tokens = db
      .query<{ project_token: string }, []>("SELECT DISTINCT project_token FROM events")
      .all()
      .map((r) => r.project_token)
      .filter((t) => registeredTokens.has(t));

    for (const token of tokens) {
      await syncProject(db, token);
    }
  }, SYNC_INTERVAL_MS);
}

export function resetWatermarks(db: Database): void {
  db.run("DELETE FROM sync_state");
}

export function stopSync(): void {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
}

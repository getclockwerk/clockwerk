import type { Database } from "bun:sqlite";
import type { LocalSession } from "./types";
import { SessionMaterializer } from "./materializer";
import { computeSessions, mergeSessionsDuration } from "./sessions";

export type Period = "today" | "yesterday" | "week" | "month" | "all";

export interface SessionQueryOptions {
  period?: Period;
  projectToken?: string;
  since?: number;
  until?: number;
}

export interface SessionQueryResult {
  sessions: LocalSession[];
  total_seconds: number;
}

function periodToRange(period: Period): { since: number; until?: number } {
  switch (period) {
    case "today": {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      return { since: Math.floor(d.getTime() / 1000) };
    }
    case "yesterday": {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      const until = Math.floor(d.getTime() / 1000);
      d.setDate(d.getDate() - 1);
      return { since: Math.floor(d.getTime() / 1000), until };
    }
    case "week": {
      const d = new Date();
      const day = d.getDay();
      // getDay(): 0=Sun, 1=Mon, ..., 6=Sat
      // Go back to Monday: Mon=0, Tue=1, ..., Sun=6
      const daysSinceMonday = day === 0 ? 6 : day - 1;
      d.setDate(d.getDate() - daysSinceMonday);
      d.setHours(0, 0, 0, 0);
      return { since: Math.floor(d.getTime() / 1000) };
    }
    case "month": {
      const d = new Date();
      d.setDate(1);
      d.setHours(0, 0, 0, 0);
      return { since: Math.floor(d.getTime() / 1000) };
    }
    case "all":
      return { since: 0 };
  }
}

/**
 * Query sessions for a time period from the local database.
 *
 * Hides: period-to-timestamp resolution, SessionMaterializer lifecycle,
 * mergeSessionsDuration aggregation, and the fallback-from-events path.
 *
 * When `source` is a `SessionMaterializer`, queries it directly with no
 * ad-hoc allocation and no `hasAnySessions()` check (the materializer is
 * already populated by the event pipeline's backfill-on-start logic).
 *
 * When `source` is a `Database`, runs the existing three-way fallback logic
 * (ephemeral materializer -> computeSessions fan-out -> computeSessions with filter).
 */
export function querySessions(
  source: SessionMaterializer | Database,
  opts?: SessionQueryOptions,
): SessionQueryResult {
  const period = opts?.period ?? "today";

  let since: number;
  let until: number | undefined;

  if (opts?.since !== undefined) {
    since = opts.since;
    until = opts.until;
  } else {
    const range = periodToRange(period);
    since = range.since;
    until = range.until;
  }

  const projectToken = opts?.projectToken;

  if (source instanceof SessionMaterializer) {
    const sessions = source.querySessions({
      projectToken,
      since: since || undefined,
      until,
    });
    return { sessions, total_seconds: mergeSessionsDuration(sessions) };
  }

  const db: Database = source;
  const mat = new SessionMaterializer(db);

  if (mat.hasAnySessions()) {
    const sessions = mat.querySessions({
      projectToken,
      since: since || undefined,
      until,
    });
    return { sessions, total_seconds: mergeSessionsDuration(sessions) };
  }

  // Fallback: compute from events when sessions table not yet populated
  if (!projectToken) {
    const tokens = db
      .query<{ project_token: string }, [number]>(
        "SELECT DISTINCT project_token FROM events WHERE timestamp >= ?",
      )
      .all(since)
      .map((r) => r.project_token);

    const sessions: LocalSession[] = tokens.flatMap((t) =>
      computeSessions(db, t, since).map((s) => ({
        ...s,
        sync_version: 0,
        synced_version: 0,
      })),
    );
    return { sessions, total_seconds: mergeSessionsDuration(sessions) };
  }

  const sessions: LocalSession[] = computeSessions(db, projectToken, since).map((s) => ({
    ...s,
    sync_version: 0,
    synced_version: 0,
  }));
  return { sessions, total_seconds: mergeSessionsDuration(sessions) };
}

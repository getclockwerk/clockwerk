import {
  getDb,
  getUserConfig,
  getProjectRegistry,
  getDeviceId,
  isLocalToken,
} from "@clockwerk/core";
import { success, error, info, warn } from "../ui";

interface PullEntry {
  id: string;
  version: number;
  start_ts: number;
  end_ts: number;
  duration_seconds: number;
  source: string | null;
  description: string | null;
  summary: string | null;
  issue_id: string | null;
  issue_title: string | null;
  device_id: string;
}

interface PullResult {
  entries: PullEntry[];
  watermark: number;
}

export default async function pull(_args: string[]): Promise<void> {
  const userConfig = getUserConfig();
  if (!userConfig) {
    error("Not logged in. Run 'clockwerk login' first.");
    process.exit(1);
  }

  const db = getDb();
  const registry = getProjectRegistry();
  const cloudTokens = registry
    .map((r) => r.project_token)
    .filter((t) => !isLocalToken(t));

  if (cloudTokens.length === 0) {
    info("No cloud projects to pull from.");
    return;
  }

  const deviceId = getDeviceId();

  let totalPulled = 0;
  let projectCount = 0;

  for (const token of cloudTokens) {
    // Get pull watermark for this project
    const state = db
      .query<
        { pull_watermark: number },
        [string]
      >("SELECT pull_watermark FROM sync_state WHERE project_token = ?")
      .get(token);
    const since = state?.pull_watermark ?? 0;

    try {
      const url = new URL(`${userConfig.api_url}/api/v2/sync/pull`);
      url.searchParams.set("project_token", token);
      url.searchParams.set("device_id", deviceId);
      url.searchParams.set("since", String(since));

      const res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${userConfig.token}` },
      });

      if (res.status === 403) {
        const body = await res.json().catch(() => ({ error: "Forbidden" }));
        warn(body.error ?? "Pull requires a Pro or Team plan.");
        info("Upgrade at https://getclockwerk.com/pricing");
        return;
      }

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        error(`Pull failed for ${token}: HTTP ${res.status} ${body}`);
        continue;
      }

      const result: PullResult = await res.json();

      if (result.entries.length === 0) {
        continue;
      }

      // Upsert pulled sessions - insert new ones, update existing if version is newer
      const upsertStmt = db.prepare(`
        INSERT INTO sessions
          (id, project_token, start_ts, end_ts, duration_seconds, source,
           description, summary, issue_id, issue_title, sync_version, synced_version, device_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          start_ts = excluded.start_ts,
          end_ts = excluded.end_ts,
          duration_seconds = excluded.duration_seconds,
          source = excluded.source,
          description = excluded.description,
          summary = excluded.summary,
          issue_id = excluded.issue_id,
          issue_title = excluded.issue_title,
          sync_version = excluded.sync_version,
          synced_version = excluded.synced_version
        WHERE excluded.sync_version > sessions.sync_version
      `);

      const tx = db.transaction((entries: PullEntry[]) => {
        for (const entry of entries) {
          upsertStmt.run(
            entry.id,
            token,
            entry.start_ts,
            entry.end_ts,
            entry.duration_seconds,
            entry.source,
            entry.description,
            entry.summary,
            entry.issue_id,
            entry.issue_title,
            entry.version,
            entry.version,
            entry.device_id,
          );
        }
      });
      tx(result.entries);

      // Update pull watermark
      db.run(
        `INSERT INTO sync_state (project_token, watermark, pull_watermark)
         VALUES (?, 0, ?)
         ON CONFLICT(project_token) DO UPDATE SET pull_watermark = ?`,
        [token, result.watermark, result.watermark],
      );

      totalPulled += result.entries.length;
      projectCount++;
    } catch (err) {
      error(`Pull error for ${token}: ${err instanceof Error ? err.message : err}`);
    }
  }

  if (totalPulled === 0) {
    info("Already up to date.");
  } else {
    success(`Pulled ${totalPulled} session(s) from ${projectCount} project(s)`);
  }
}

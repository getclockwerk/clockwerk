import {
  getDb,
  getUserConfig,
  getProjectRegistry,
  isLocalToken,
  findProjectConfig,
  saveProjectConfig,
  registerProject,
  SessionMaterializer,
} from "@clockwerk/core";
import { confirm, choose } from "../prompt";
import { success, error, info } from "../ui";

interface SyncEntry {
  id: string;
  version: number;
  start_ts: number;
  end_ts: number;
  duration_seconds: number;
  source?: string;
  description?: string;
  summary?: string;
}

interface SyncResult {
  accepted: string[];
  deleted: string[];
  rejected: { id: string; reason: string }[];
}

interface CloudProject {
  id: string;
  name: string;
  token: string;
  orgId: string;
}

interface UserOrg {
  id: string;
  name: string;
}

export default async function sync(args: string[]): Promise<void> {
  const userConfig = getUserConfig();
  if (!userConfig) {
    error("Not logged in. Run 'clockwerk login' first.");
    process.exit(1);
  }

  const includeDescriptions = args.includes("-d") || args.includes("--with-descriptions");
  const includeSummaries = args.includes("-s") || args.includes("--with-summaries");

  const db = getDb();
  const materializer = new SessionMaterializer(db);

  // Run a merge pass before syncing to finalize adjacent sessions
  const merged = materializer.mergeAdjacentSessions();
  if (merged > 0) {
    info(`Merged ${merged} adjacent session(s)`);
  }

  // Get registered projects
  const registry = getProjectRegistry();

  if (registry.length === 0) {
    info("No projects registered. Run 'clockwerk init' in a project directory first.");
    return;
  }

  const relink = args.includes("--relink");

  // Handle unlinked projects - local-only, or all projects when --relink
  const entriesToLink = relink
    ? registry
    : registry.filter((r) => isLocalToken(r.project_token));

  if (entriesToLink.length > 0) {
    let orgs: UserOrg[] | null = null;
    let cloudProjects: CloudProject[] | null = null;

    for (const entry of entriesToLink) {
      const config = findProjectConfig(entry.directory);
      if (!config) continue;

      const name = config.project_name ?? entry.directory.split("/").pop() ?? "Unknown";
      const prompt = relink
        ? `Re-link "${name}" to a project on ${userConfig.api_url}?`
        : `"${name}" is local-only. Link to cloud for syncing?`;
      const shouldLink = await confirm(prompt);

      if (!shouldLink) continue;

      // Lazy-fetch orgs and cloud projects on first link
      if (!orgs || !cloudProjects) {
        try {
          const [projRes, meRes] = await Promise.all([
            fetch(`${userConfig.api_url}/api/v1/projects`, {
              headers: { Authorization: `Bearer ${userConfig.token}` },
            }),
            fetch(`${userConfig.api_url}/api/v1/auth/me`, {
              headers: { Authorization: `Bearer ${userConfig.token}` },
            }),
          ]);

          cloudProjects = projRes.ok ? ((await projRes.json()).projects ?? []) : [];
          orgs = meRes.ok ? ((await meRes.json()).orgs ?? []) : [];
        } catch {
          error("Could not reach the API. Skipping local project linking.");
          break;
        }

        if (!orgs || orgs.length === 0) {
          error("No organizations found.");
          break;
        }
      }

      // Choose: create new or link to existing
      const options = [
        `Create new project "${name}"`,
        ...(cloudProjects ?? []).map((p) => p.name),
      ];

      const choice = await choose("Select a cloud project:", options);

      let cloudToken: string;

      if (choice === 0) {
        // Create new project
        let orgId: string;
        if (orgs.length === 1) {
          orgId = orgs[0].id;
        } else {
          const orgChoice = await choose(
            "Which organization?",
            orgs.map((o) => o.name),
          );
          orgId = orgs[orgChoice].id;
        }

        try {
          const res = await fetch(`${userConfig.api_url}/api/v1/projects`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${userConfig.token}`,
            },
            body: JSON.stringify({ org_id: orgId, name }),
          });

          if (!res.ok) {
            const e = await res.json().catch(() => ({}));
            error(`Failed to create project: ${e.error ?? res.statusText}`);
            continue;
          }

          const data = await res.json();
          cloudToken = data.project.token;
          success(`Created "${name}"`);
        } catch {
          error("Failed to create project. Skipping.");
          continue;
        }
      } else {
        cloudToken = (cloudProjects ?? [])[choice - 1].token;
        success(`Linked to "${(cloudProjects ?? [])[choice - 1].name}"`);
      }

      // Update local session tokens and mark dirty for sync
      db.run(
        "UPDATE sessions SET project_token = ?, synced_version = 0 WHERE project_token = ?",
        [cloudToken, entry.project_token],
      );
      db.run("UPDATE events SET project_token = ? WHERE project_token = ?", [
        cloudToken,
        entry.project_token,
      ]);

      // Update config and registry
      config.project_token = cloudToken;
      config.api_url = userConfig.api_url;
      saveProjectConfig(entry.directory, config);
      registerProject({ project_token: cloudToken, directory: entry.directory });
    }
  }

  // Re-read registry after potential linking
  const updatedRegistry = getProjectRegistry();
  const cloudTokens = new Set(
    updatedRegistry.map((r) => r.project_token).filter((t) => !isLocalToken(t)),
  );

  if (cloudTokens.size === 0) {
    info("No cloud projects to sync.");
    return;
  }

  let totalSynced = 0;
  let totalDeleted = 0;
  let totalRejected = 0;
  let projectCount = 0;

  for (const token of cloudTokens) {
    // Get dirty sessions (sync_version > synced_version)
    const dirtySessions = db
      .query<
        {
          id: string;
          sync_version: number;
          start_ts: number;
          end_ts: number;
          duration_seconds: number;
          source: string;
          description: string | null;
          summary: string | null;
        },
        [string]
      >(
        `SELECT id, sync_version, start_ts, end_ts, duration_seconds, source, description, summary
         FROM sessions
         WHERE project_token = ?
           AND sync_version > synced_version
           AND deleted_at IS NULL`,
      )
      .all(token);

    // Get pending deletes
    const pendingDeletes = db
      .query<{ session_id: string }, [string]>(
        "SELECT session_id FROM sync_deletes WHERE project_token = ?",
      )
      .all(token)
      .map((r) => r.session_id);

    if (dirtySessions.length === 0 && pendingDeletes.length === 0) {
      continue;
    }

    // Strip to minimal fields - descriptions and summaries are opt-in
    const entries: SyncEntry[] = dirtySessions.map((s) => ({
      id: s.id,
      version: s.sync_version,
      start_ts: s.start_ts,
      end_ts: s.end_ts,
      duration_seconds: s.duration_seconds,
      source: s.source,
      ...(includeDescriptions && s.description ? { description: s.description } : {}),
      ...(includeSummaries && s.summary ? { summary: s.summary } : {}),
    }));

    try {
      const res = await fetch(`${userConfig.api_url}/api/v2/sync`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userConfig.token}`,
        },
        body: JSON.stringify({
          project_token: token,
          entries,
          deletes: pendingDeletes,
        }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        error(`Sync failed for ${token}: HTTP ${res.status} ${body}`);
        continue;
      }

      const result: SyncResult = await res.json();

      // Mark accepted sessions as synced
      if (result.accepted.length > 0) {
        const updateStmt = db.prepare(
          "UPDATE sessions SET synced_version = sync_version WHERE id = ?",
        );
        const tx = db.transaction((ids: string[]) => {
          for (const id of ids) {
            updateStmt.run(id);
          }
        });
        tx(result.accepted);
      }

      // Remove synced deletes
      if (result.deleted.length > 0) {
        const deleteStmt = db.prepare("DELETE FROM sync_deletes WHERE session_id = ?");
        const tx = db.transaction((ids: string[]) => {
          for (const id of ids) {
            deleteStmt.run(id);
          }
        });
        tx(result.deleted);

        // Also hard-delete the soft-deleted sessions
        const hardDeleteStmt = db.prepare(
          "DELETE FROM sessions WHERE id = ? AND deleted_at IS NOT NULL",
        );
        const hardTx = db.transaction((ids: string[]) => {
          for (const id of ids) {
            hardDeleteStmt.run(id);
          }
        });
        hardTx(result.deleted);
      }

      totalSynced += result.accepted.length;
      totalDeleted += result.deleted.length;
      totalRejected += result.rejected.length;
      projectCount++;
    } catch (err) {
      error(`Sync error for ${token}: ${err instanceof Error ? err.message : err}`);
    }
  }

  if (projectCount === 0) {
    info("Nothing to sync.");
  } else {
    const parts = [`Synced ${totalSynced} session(s) across ${projectCount} project(s)`];
    if (totalDeleted > 0) parts.push(`deleted ${totalDeleted}`);
    if (totalRejected > 0) parts.push(`${totalRejected} rejected (stale)`);
    success(parts.join(", "));
  }
}

import { join } from "node:path";
import * as fs from "node:fs";
import { daemon } from "../daemon/client";
import {
  resolveProjectFromPath,
  openDbReadOnly,
  querySessions,
  getClockwerkDir,
} from "@clockwerk/core";
import { formatDuration } from "../format";
import { kv, badge, dim, error, warn, pc } from "../ui";
import { PluginManager } from "../plugin-manager";

const pluginManager = new PluginManager({
  fs,
  fetch: globalThis.fetch,
  pluginsDir: join(getClockwerkDir(), "plugins"),
});

export default async function status(_args: string[]): Promise<void> {
  const daemonUp = daemon.isRunning();
  kv(
    "Daemon",
    badge(daemonUp ? "running" : "stopped", daemonUp ? "success" : "error"),
    0,
  );

  const entry = resolveProjectFromPath(process.cwd());

  if (daemonUp) {
    await queryDaemonStatus(entry?.project_token);
  } else {
    queryOffline(entry?.project_token);
  }

  const cache = pluginManager.loadUpdateCache();
  if (cache && cache.updates.length > 0) {
    console.log();
    warn(`Plugin updates available (${cache.updates.length}):`);
    for (const u of cache.updates) {
      console.log(
        `  ${u.name}: ${pc.dim(u.installedVersion)} -> ${pc.bold(u.latestVersion)}`,
      );
    }
    dim("Run 'clockwerk plugin update' to update.");
  }
}

async function queryDaemonStatus(projectToken?: string): Promise<void> {
  const todayParams: Record<string, unknown> = { period: "today" };
  const weekParams: Record<string, unknown> = { period: "week" };
  if (projectToken) {
    todayParams.project_token = projectToken;
    weekParams.project_token = projectToken;
  }

  try {
    const [todayData, weekData] = await Promise.all([
      daemon.query<{ total_seconds: number }>("sessions", todayParams),
      daemon.query<{ total_seconds: number }>("sessions", weekParams),
    ]);

    kv("Today", pc.bold(formatDuration(todayData?.total_seconds ?? 0)), 0);
    kv("Week", pc.bold(formatDuration(weekData?.total_seconds ?? 0)), 0);
  } catch (err) {
    error(`Failed to query daemon: ${err}`);
    process.exit(1);
  }
}

function queryOffline(projectToken?: string): void {
  const db = openDbReadOnly();
  if (!db) {
    dim("\nNo local database found. Run 'clockwerk up' to start tracking.");
    return;
  }

  try {
    const today = querySessions(db, { period: "today", projectToken });
    const week = querySessions(db, { period: "week", projectToken });

    kv("Today", pc.bold(formatDuration(today.total_seconds)), 0);
    kv("Week", pc.bold(formatDuration(week.total_seconds)), 0);
    dim("(offline - reading from local database)");
  } finally {
    db.close();
  }
}

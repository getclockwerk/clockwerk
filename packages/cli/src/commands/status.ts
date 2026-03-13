import { isDaemonRunning } from "../daemon/server";
import {
  queryDaemon,
  findProjectConfig,
  openDbReadOnly,
  SessionMaterializer,
  mergeSessionsDuration,
} from "@clockwerk/core";
import { formatDuration } from "../format";
import { kv, heading, badge, dim, error, pc } from "../ui";

export default async function status(_args: string[]): Promise<void> {
  const daemonUp = isDaemonRunning();
  kv(
    "Daemon",
    badge(daemonUp ? "running" : "stopped", daemonUp ? "success" : "error"),
    0,
  );

  const project = findProjectConfig(process.cwd());
  if (project) {
    kv("Project", project.project_token, 0);
  }

  if (daemonUp) {
    await queryDaemonStatus(project?.project_token);
  } else {
    queryOffline(project?.project_token);
  }
}

async function queryDaemonStatus(projectToken?: string): Promise<void> {
  const params: Record<string, unknown> = { period: "today" };
  if (projectToken) {
    params.project_token = projectToken;
  }

  try {
    const statusRes = await queryDaemon("status");
    const statusData = statusRes.data as {
      plugins?: {
        name: string;
        source: string;
        running: boolean;
        eventCount: number;
        lastEventTs: number | null;
      }[];
    };

    const res = await queryDaemon("sessions", params);
    const data = res.data as { sessions: unknown[]; total_seconds: number };

    kv(
      "Today",
      `${pc.bold(formatDuration(data.total_seconds))} across ${data.sessions.length} session(s)`,
      0,
    );

    const plugins = statusData.plugins ?? [];
    if (plugins.length > 0) {
      heading(`Plugins (${plugins.length})`);
      for (const p of plugins) {
        const status = badge(
          p.running ? "running" : "stopped",
          p.running ? "success" : "error",
        );
        const events = p.eventCount > 0 ? pc.dim(` · ${p.eventCount} events`) : "";
        const lastEvent = p.lastEventTs
          ? pc.dim(` · last ${formatTimeSince(p.lastEventTs)}`)
          : "";
        console.log(`  ${pc.white(p.name)} [${status}]${events}${lastEvent}`);
      }
    }
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
    const materializer = new SessionMaterializer(db);

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const since = Math.floor(todayStart.getTime() / 1000);

    const sessions = materializer.querySessions({
      projectToken,
      since,
    });

    const totalSeconds = mergeSessionsDuration(sessions);

    kv(
      "Today",
      `${pc.bold(formatDuration(totalSeconds))} across ${sessions.length} session(s)`,
      0,
    );
    dim("(offline - reading from local database)");
  } finally {
    db.close();
  }
}

function formatTimeSince(ts: number): string {
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

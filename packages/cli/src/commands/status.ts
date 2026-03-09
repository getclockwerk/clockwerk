import { isDaemonRunning } from "../daemon/server";
import { queryDaemon } from "../daemon/client";
import { findProjectConfig } from "@clockwerk/core";

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export default async function status(_args: string[]): Promise<void> {
  const daemonUp = isDaemonRunning();
  console.log(
    `Daemon: ${daemonUp ? "\x1b[32mrunning\x1b[0m" : "\x1b[31mstopped\x1b[0m"}`,
  );

  if (!daemonUp) {
    console.log(`\nRun 'clockwerk up' to start tracking.`);
    return;
  }

  const project = findProjectConfig(process.cwd());
  const params: Record<string, unknown> = { period: "today" };
  if (project) {
    params.project_token = project.project_token;
    console.log(`Project: ${project.project_token}`);
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

    console.log(
      `Today: ${formatDuration(data.total_seconds)} across ${data.sessions.length} session(s)`,
    );

    const plugins = statusData.plugins ?? [];
    if (plugins.length > 0) {
      console.log(`\nPlugins (${plugins.length}):`);
      for (const p of plugins) {
        const status = p.running ? "\x1b[32mrunning\x1b[0m" : "\x1b[31mstopped\x1b[0m";
        const events = p.eventCount > 0 ? ` · ${p.eventCount} events` : "";
        const lastEvent = p.lastEventTs
          ? ` · last ${formatTimeSince(p.lastEventTs)}`
          : "";
        console.log(`  ${p.name} [${status}]${events}${lastEvent}`);
      }
    }
  } catch (err) {
    console.error("Failed to query daemon:", err);
  }
}

function formatTimeSince(ts: number): string {
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

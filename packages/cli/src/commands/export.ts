import { daemon } from "../daemon/client";
import { resolveProjectFromPath } from "@clockwerk/core";
import type { Session } from "@clockwerk/core";
import { formatDuration } from "../format";
import { writeFileSync } from "node:fs";
import { error, info } from "../ui";

function parseArgs(args: string[]) {
  let format: "csv" | "json" = "csv";
  let since: string | undefined;
  let all = false;
  let output: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--format" && args[i + 1]) {
      const val = args[++i];
      if (val !== "csv" && val !== "json") {
        error(`Invalid format: ${val}. Use 'csv' or 'json'.`);
        process.exit(1);
      }
      format = val;
    } else if (arg === "--since" && args[i + 1]) {
      since = args[++i];
    } else if (arg === "--all") {
      all = true;
    } else if ((arg === "-o" || arg === "--output") && args[i + 1]) {
      output = args[++i];
    }
  }

  return { format, since, all, output };
}

function parseSince(since: string | undefined, all: boolean): number | undefined {
  if (all) return 0;
  if (!since) {
    // Default: last 7 days
    const d = new Date();
    d.setDate(d.getDate() - 7);
    d.setHours(0, 0, 0, 0);
    return Math.floor(d.getTime() / 1000);
  }

  // Parse YYYY-MM-DD
  const date = new Date(since);
  if (isNaN(date.getTime())) {
    error(`Invalid date: ${since}. Use YYYY-MM-DD format.`);
    process.exit(1);
  }
  return Math.floor(date.getTime() / 1000);
}

export function escapeCsvField(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function sessionToCsvRow(s: Session): string {
  const start = new Date(s.start_ts * 1000);
  const end = new Date(s.end_ts * 1000);

  const dateStr = start.toISOString().slice(0, 10);
  const startTime = start.toTimeString().slice(0, 5);
  const endTime = end.toTimeString().slice(0, 5);

  const fields = [
    dateStr,
    startTime,
    endTime,
    formatDuration(s.duration_seconds),
    s.project_token,
    s.source,
  ];

  return fields.map(escapeCsvField).join(",");
}

export default async function exportCommand(args: string[]): Promise<void> {
  const opts = parseArgs(args);

  if (!daemon.isRunning()) {
    error("Daemon is not running. Start it with 'clockwerk up'.");
    process.exit(1);
  }

  const entry = resolveProjectFromPath(process.cwd());
  const sinceTs = parseSince(opts.since, opts.all);

  const params: Record<string, unknown> = {};
  if (entry) {
    params.project_token = entry.project_token;
  }

  // Determine period for daemon query
  if (opts.all) {
    params.period = "all";
  } else {
    // Use 'week' for default, but override if custom since
    params.period = opts.since ? "all" : "week";
  }

  try {
    const data = await daemon.query<{ sessions: Session[]; total_seconds: number }>(
      "sessions",
      params,
    );
    if (!data) throw new Error("No data returned from daemon");

    let sessions = data.sessions;

    // If custom since date, filter client-side
    if (sinceTs && sinceTs > 0) {
      sessions = sessions.filter((s) => s.start_ts >= sinceTs);
    }

    // Sort by start time
    sessions.sort((a, b) => a.start_ts - b.start_ts);

    let output: string;
    if (opts.format === "json") {
      output = JSON.stringify(sessions, null, 2) + "\n";
    } else {
      const header = "Date,Start,End,Duration,Project,Source";
      const rows = sessions.map(sessionToCsvRow);
      output = [header, ...rows].join("\n") + "\n";
    }

    if (opts.output) {
      writeFileSync(opts.output, output);
      info(
        `Exported ${sessions.length} session(s) (${formatDuration(data.total_seconds)}) to ${opts.output}`,
      );
    } else {
      process.stdout.write(output);
    }
  } catch (err) {
    error(`Failed to query daemon: ${err}`);
    process.exit(1);
  }
}

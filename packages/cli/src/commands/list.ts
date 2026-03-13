import {
  openDbReadOnly,
  SessionMaterializer,
  findProjectConfig,
  type LocalSession,
} from "@clockwerk/core";
import { formatDuration } from "../format";
import { error, dim, heading, pc } from "../ui";

type Period = "today" | "yesterday" | "week" | "month";

const PERIODS: Record<string, Period> = {
  today: "today",
  yesterday: "yesterday",
  week: "week",
  month: "month",
};

function periodRange(period: Period): { since: number; until?: number; label: string } {
  const now = new Date();
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);

  switch (period) {
    case "today":
      return {
        since: Math.floor(startOfDay.getTime() / 1000),
        label: "Today",
      };
    case "yesterday": {
      const yesterday = new Date(startOfDay);
      yesterday.setDate(yesterday.getDate() - 1);
      return {
        since: Math.floor(yesterday.getTime() / 1000),
        until: Math.floor(startOfDay.getTime() / 1000),
        label: "Yesterday",
      };
    }
    case "week": {
      const weekAgo = new Date(startOfDay);
      weekAgo.setDate(weekAgo.getDate() - 7);
      return {
        since: Math.floor(weekAgo.getTime() / 1000),
        label: "This week",
      };
    }
    case "month": {
      const monthAgo = new Date(startOfDay);
      monthAgo.setDate(monthAgo.getDate() - 30);
      return {
        since: Math.floor(monthAgo.getTime() / 1000),
        label: "This month",
      };
    }
  }
}

function formatTime(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

function formatDate(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toLocaleDateString("en-GB", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 1) + "\u2026";
}

function renderTable(sessions: LocalSession[], label: string): void {
  if (sessions.length === 0) {
    dim(`No sessions for ${label.toLowerCase()}.`);
    return;
  }

  // Sort by start time
  const sorted = [...sessions].sort((a, b) => a.start_ts - b.start_ts);

  // Calculate total
  const totalSeconds = sorted.reduce((sum, s) => sum + s.duration_seconds, 0);

  // Column widths
  const dateCol = 16;
  const timeCol = 13;
  const durCol = 8;

  // Header
  heading(label);
  console.log(
    `  ${pc.dim("Date".padEnd(dateCol))}${pc.dim("Time".padEnd(timeCol))}${pc.dim("Duration".padEnd(durCol))}  ${pc.dim("Description")}`,
  );
  console.log(pc.dim("  " + "\u2500".repeat(dateCol + timeCol + durCol + 30)));

  // Group by date
  let lastDate = "";

  for (const s of sorted) {
    const date = formatDate(s.start_ts);
    const time = `${formatTime(s.start_ts)}-${formatTime(s.end_ts)}`;
    const dur = formatDuration(s.duration_seconds);
    const desc = s.description ? truncate(s.description, 40) : pc.dim("-");

    const dateStr = date !== lastDate ? date : "";
    lastDate = date;

    console.log(
      `  ${pc.white(dateStr.padEnd(dateCol))}${time.padEnd(timeCol)}${pc.bold(dur.padEnd(durCol))}  ${desc}`,
    );
  }

  // Footer
  console.log(pc.dim("  " + "\u2500".repeat(dateCol + timeCol + durCol + 30)));
  console.log(
    `  ${"".padEnd(dateCol)}${"".padEnd(timeCol)}${pc.bold(pc.green(formatDuration(totalSeconds).padEnd(durCol)))}  ${pc.dim(`${sorted.length} session(s)`)}`,
  );
  console.log();
}

export default async function list(args: string[]): Promise<void> {
  const periodArg = args[0]?.toLowerCase();

  if (!periodArg || !PERIODS[periodArg]) {
    error("Usage: clockwerk list <today|yesterday|week|month>");
    process.exit(1);
  }

  const period = PERIODS[periodArg];

  const db = openDbReadOnly();
  if (!db) {
    error("No local database found. Run 'clockwerk up' to start tracking.");
    process.exit(1);
  }

  try {
    const materializer = new SessionMaterializer(db);
    const project = findProjectConfig(process.cwd());
    const { since, until, label } = periodRange(period);

    const sessions = materializer.querySessions({
      projectToken: project?.project_token,
      since,
      until,
    });

    renderTable(sessions, label);
  } finally {
    db.close();
  }
}

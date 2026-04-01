import {
  openDbReadOnly,
  querySessions,
  resolveProjectFromPath,
  mergeSessionsDuration,
  type Period,
  type LocalSession,
} from "@clockwerk/core";
import { formatDuration } from "../format";
import { error, dim, pc } from "../ui";

const PERIODS: Record<string, Period> = {
  today: "today",
  yesterday: "yesterday",
  week: "week",
  month: "month",
};

const PERIOD_LABELS: Record<string, string> = {
  today: "Today",
  yesterday: "Yesterday",
  week: "This week",
  month: "This month",
};

export function formatTime(ts: number): string {
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

function isSingleDay(period: Period): boolean {
  return period === "today" || period === "yesterday";
}

function renderRow(session: LocalSession, indent: string): void {
  const timeRange = `${formatTime(session.start_ts)} - ${formatTime(session.end_ts)}`;
  const dur = formatDuration(session.duration_seconds);
  console.log(`${indent}${timeRange}  ${pc.dim(session.source.padEnd(16))}${dur}`);
}

export function renderSessions(
  sessions: LocalSession[],
  label: string,
  period: Period,
): void {
  if (sessions.length === 0) {
    dim(`No sessions for ${label.toLowerCase()}.`);
    return;
  }

  const sorted = [...sessions].sort((a, b) => a.start_ts - b.start_ts);
  const totalSeconds = mergeSessionsDuration(sorted);

  console.log(pc.bold(`${label} (${formatDuration(totalSeconds)})`));

  if (isSingleDay(period)) {
    for (const s of sorted) {
      renderRow(s, "  ");
    }
  } else {
    let lastDate = "";
    for (const s of sorted) {
      const date = formatDate(s.start_ts);
      if (date !== lastDate) {
        if (lastDate !== "") console.log();
        console.log(`  ${pc.dim(date)}`);
        lastDate = date;
      }
      renderRow(s, "    ");
    }
  }
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
    const entry = resolveProjectFromPath(process.cwd());
    const { sessions } = querySessions(db, {
      period,
      projectToken: entry?.project_token,
    });
    const label = PERIOD_LABELS[period] ?? period;

    renderSessions(sessions, label, period);
  } finally {
    db.close();
  }
}

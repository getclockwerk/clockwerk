import { findProjectConfig, type ClockwerkEvent } from "@clockwerk/core";
import { sendEvent } from "../daemon/client";
import { isDaemonRunning } from "../daemon/server";
import { formatDuration } from "../format";

/**
 * Manual time logging.
 * Usage: clockwerk log 2h "client meeting"
 *        clockwerk log 45m "code review"
 *        clockwerk log 1h30m "design session"
 */
export default async function log(args: string[]): Promise<void> {
  const durationStr = args[0];
  const description = args.slice(1).join(" ") || undefined;

  if (!durationStr) {
    console.error("Usage: clockwerk log <duration> [description]");
    console.error('  e.g. clockwerk log 2h "client meeting"');
    console.error('  e.g. clockwerk log 45m "code review"');
    process.exit(1);
  }

  const seconds = parseDuration(durationStr);
  if (seconds <= 0) {
    console.error(`Invalid duration: ${durationStr}`);
    process.exit(1);
  }

  const projectConfig = findProjectConfig(process.cwd());
  if (!projectConfig) {
    console.error("Not in a tracked project. Run 'clockwerk init <token>' first.");
    process.exit(1);
  }

  if (!isDaemonRunning()) {
    console.error("Daemon is not running. Run 'clockwerk up' first.");
    process.exit(1);
  }

  // Insert events at regular intervals to create a session of the desired duration
  // Same approach as tt's manual entry — events spaced 4 minutes apart
  const now = Math.floor(Date.now() / 1000);
  const startTs = now - seconds;
  const interval = 240; // 4 minutes (under 5-minute gap threshold)

  const events: ClockwerkEvent[] = [];
  for (let ts = startTs; ts <= now; ts += interval) {
    events.push({
      id: crypto.randomUUID(),
      timestamp: ts,
      event_type: "manual",
      source: "manual",
      project_token: projectConfig.project_token,
      context: {
        description,
        topic: description,
      },
      harness_session_id: `manual:${startTs}`,
    });
  }

  for (const event of events) {
    await sendEvent({ type: "event", data: event });
  }

  const dur = formatDuration(seconds);
  console.log(`[clockwerk] Logged ${dur}${description ? `: ${description}` : ""}`);
}

function parseDuration(str: string): number {
  let total = 0;
  const hourMatch = str.match(/(\d+)h/);
  const minMatch = str.match(/(\d+)m/);

  if (hourMatch) total += parseInt(hourMatch[1], 10) * 3600;
  if (minMatch) total += parseInt(minMatch[1], 10) * 60;

  // Plain number = minutes
  if (!hourMatch && !minMatch) {
    const n = parseInt(str, 10);
    if (!isNaN(n)) total = n * 60;
  }

  return total;
}

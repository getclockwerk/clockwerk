import { describe, test, expect } from "bun:test";
import { renderSessions, formatTime } from "../commands/list";
import { captureConsole } from "./helpers";
import type { LocalSession } from "@clockwerk/core";

const ANSI_RE = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g");

function stripAnsi(str: string): string {
  return str.replace(ANSI_RE, "");
}

function makeSession(startTs: number, endTs: number, source: string): LocalSession {
  return {
    id: "test-id",
    project_token: "test-token",
    start_ts: startTs,
    end_ts: endTs,
    duration_seconds: endTs - startTs,
    source,
    sync_version: 0,
    synced_version: 0,
  };
}

describe("renderSessions", () => {
  test("shows no-sessions message for empty list", () => {
    const cap = captureConsole();
    renderSessions([], "Today", "today");
    cap.restore();
    const output = cap.stdout.map(stripAnsi).join("\n");
    expect(output).toContain("No sessions for today");
  });

  test("shows label with total duration in header", () => {
    // 2h 18m = 8280 seconds
    const sessions = [makeSession(0, 8280, "claude-code")];
    const cap = captureConsole();
    renderSessions(sessions, "Today", "today");
    cap.restore();
    const output = cap.stdout.map(stripAnsi).join("\n");
    expect(output).toContain("Today (2h 18m)");
  });

  test("single-day format includes time range and source per session", () => {
    const sessions = [
      makeSession(0, 8280, "claude-code"),
      makeSession(9000, 14040, "cursor"),
    ];
    const cap = captureConsole();
    renderSessions(sessions, "Today", "today");
    cap.restore();
    const lines = cap.stdout.map(stripAnsi);
    const sessionLines = lines.filter((l) => l.includes(" - ") && l.includes(":"));
    expect(sessionLines).toHaveLength(2);
    expect(sessionLines.some((l) => l.includes("claude-code"))).toBe(true);
    expect(sessionLines.some((l) => l.includes("cursor"))).toBe(true);
  });

  test("single-day rows show duration", () => {
    // 3600 seconds = 1h 0m
    const sessions = [makeSession(0, 3600, "claude-code")];
    const cap = captureConsole();
    renderSessions(sessions, "Today", "today");
    cap.restore();
    const lines = cap.stdout.map(stripAnsi);
    const sessionLine = lines.find((l) => l.includes("claude-code"));
    expect(sessionLine).toBeDefined();
    expect(sessionLine).toContain("1h 0m");
  });

  test("multi-day format groups sessions by date", () => {
    // Two sessions on different days: Jan 1 and Jan 2 2025 (UTC)
    const day1Start = 1735689600; // 2025-01-01 00:00:00 UTC
    const day2Start = 1735776000; // 2025-01-02 00:00:00 UTC
    const sessions = [
      makeSession(day1Start, day1Start + 3600, "claude-code"),
      makeSession(day2Start, day2Start + 1800, "cursor"),
    ];
    const cap = captureConsole();
    renderSessions(sessions, "This week", "week");
    cap.restore();
    const lines = cap.stdout.map(stripAnsi);
    // Header shows total
    expect(lines[0]).toContain("This week (");
    // Should have two date sub-headers
    const dateLines = lines.filter(
      (l) => l.trim().length > 0 && !l.includes(" - ") && !l.includes("(") && l !== "",
    );
    expect(dateLines.length).toBeGreaterThanOrEqual(2);
  });

  test("multi-day rows are indented more than single-day", () => {
    const day1Start = 1735689600;
    const sessions = [makeSession(day1Start, day1Start + 3600, "claude-code")];

    const capMulti = captureConsole();
    renderSessions(sessions, "This week", "week");
    capMulti.restore();
    const multiLine = capMulti.stdout.map(stripAnsi).find((l) => l.includes(" - "));

    const capSingle = captureConsole();
    renderSessions(sessions, "Today", "today");
    capSingle.restore();
    const singleLine = capSingle.stdout.map(stripAnsi).find((l) => l.includes(" - "));

    expect(multiLine).toBeDefined();
    expect(singleLine).toBeDefined();
    const multiIndent = multiLine!.length - multiLine!.trimStart().length;
    const singleIndent = singleLine!.length - singleLine!.trimStart().length;
    expect(multiIndent).toBeGreaterThan(singleIndent);
  });
});

describe("formatTime", () => {
  test("formats unix timestamp as HH:MM", () => {
    // Use a known timestamp: 2025-01-01 09:14:00 UTC
    // Locale formatting may vary by TZ, so just check format HH:MM
    const ts = 1735722840; // 2025-01-01 09:14:00 UTC
    const result = formatTime(ts);
    expect(result).toMatch(/^\d{2}:\d{2}$/);
  });
});

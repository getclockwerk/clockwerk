import { describe, test, expect } from "bun:test";
import { escapeCsvField, sessionToCsvRow } from "../export";
import type { Session } from "@clockwerk/core";

describe("escapeCsvField", () => {
  test("returns plain string unchanged", () => {
    expect(escapeCsvField("hello")).toBe("hello");
    expect(escapeCsvField("simple text")).toBe("simple text");
  });

  test("wraps field with commas in quotes", () => {
    expect(escapeCsvField("hello,world")).toBe('"hello,world"');
  });

  test("escapes quotes by doubling them", () => {
    expect(escapeCsvField('say "hi"')).toBe('"say ""hi"""');
  });

  test("wraps field with newlines in quotes", () => {
    expect(escapeCsvField("line1\nline2")).toBe('"line1\nline2"');
  });

  test("handles field with commas and quotes", () => {
    expect(escapeCsvField('a,"b"')).toBe('"a,""b"""');
  });

  test("handles empty string", () => {
    expect(escapeCsvField("")).toBe("");
  });
});

describe("sessionToCsvRow", () => {
  const baseSession: Session = {
    id: "test-session",
    project_token: "proj_123",
    start_ts: 1700000000,
    end_ts: 1700003600,
    duration_seconds: 3600,
    source: "claude-code",
    branch: "main",
    topics: ["coding"],
    file_areas: ["src"],
    event_count: 15,
  };

  test("produces correct number of fields", () => {
    const row = sessionToCsvRow(baseSession);
    const fields = row.split(",");
    // Date,Start,End,Duration,Project,Source,Branch,Topics,File Areas,Events
    expect(fields.length).toBeGreaterThanOrEqual(10);
  });

  test("includes project token and source", () => {
    const row = sessionToCsvRow(baseSession);
    expect(row).toContain("proj_123");
    expect(row).toContain("claude-code");
  });

  test("handles missing branch", () => {
    const session = { ...baseSession, branch: undefined };
    const row = sessionToCsvRow(session);
    // Should not throw, branch field should be empty
    expect(row).toBeTruthy();
  });

  test("joins multiple topics with semicolons", () => {
    const session = { ...baseSession, topics: ["coding", "refactoring"] };
    const row = sessionToCsvRow(session);
    expect(row).toContain("coding; refactoring");
  });
});

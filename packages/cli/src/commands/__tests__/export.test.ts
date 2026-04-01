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
    project_token: "local_my-project",
    start_ts: 1700000000,
    end_ts: 1700003600,
    duration_seconds: 3600,
    source: "claude-code",
  };

  test("produces correct number of fields", () => {
    const row = sessionToCsvRow(baseSession);
    const fields = row.split(",");
    // Date,Start,End,Duration,Project,Source
    expect(fields.length).toBe(6);
  });

  test("includes project", () => {
    const row = sessionToCsvRow(baseSession);
    expect(row).toContain("local_my-project");
  });

  test("includes source", () => {
    const row = sessionToCsvRow(baseSession);
    expect(row).toContain("claude-code");
  });

  test("formats date and times correctly", () => {
    const row = sessionToCsvRow(baseSession);
    expect(row).toContain("2023-11-14");
  });
});

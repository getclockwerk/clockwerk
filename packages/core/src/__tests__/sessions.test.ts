import { describe, test, expect } from "bun:test";
import { computeSessions, mergeSessionsDuration, SESSION_GAP } from "../sessions";
import { insertEvents } from "../db";
import { createEvent, createEventSequence, createTestDb } from "./fixtures";

describe("computeSessions", () => {
  test("creates a single session from continuous events", () => {
    const db = createTestDb();
    const baseTs = 1700000000;
    // Events every 60s for 10 minutes - all within SESSION_GAP
    const events = createEventSequence(
      baseTs,
      [0, 60, 120, 180, 240, 300, 360, 420, 480, 540],
    );
    insertEvents(db, events);

    const sessions = computeSessions(db, "proj_test_123");
    expect(sessions).toHaveLength(1);
    expect(sessions[0].start_ts).toBe(baseTs);
    expect(sessions[0].end_ts).toBe(baseTs + 540);
    expect(sessions[0].event_count).toBe(10);
    db.close();
  });

  test("splits sessions at gap > SESSION_GAP", () => {
    const db = createTestDb();
    const baseTs = 1700000000;
    // Two clusters with a 10-minute gap (> 5 min SESSION_GAP)
    const events = createEventSequence(baseTs, [
      0,
      60,
      120,
      120 + SESSION_GAP + 60,
      120 + SESSION_GAP + 120,
    ]);
    insertEvents(db, events);

    const sessions = computeSessions(db, "proj_test_123");
    expect(sessions).toHaveLength(2);
    expect(sessions[0].event_count).toBe(3);
    expect(sessions[1].event_count).toBe(2);
    db.close();
  });

  test("enforces minimum 60s duration for short sessions", () => {
    const db = createTestDb();
    const baseTs = 1700000000;
    // Single event - should get padded to 60s
    const events = [createEvent({ timestamp: baseTs })];
    insertEvents(db, events);

    const sessions = computeSessions(db, "proj_test_123");
    expect(sessions).toHaveLength(1);
    expect(sessions[0].duration_seconds).toBe(60);
    expect(sessions[0].end_ts).toBe(baseTs + 60);
    db.close();
  });

  test("partitions events by branch", () => {
    const db = createTestDb();
    const baseTs = 1700000000;
    const mainEvents = createEventSequence(baseTs, [0, 60, 120], {
      context: { branch: "main" },
    });
    const featureEvents = createEventSequence(baseTs, [30, 90, 150], {
      context: { branch: "feature/abc" },
    });
    insertEvents(db, [...mainEvents, ...featureEvents]);

    const sessions = computeSessions(db, "proj_test_123");
    expect(sessions).toHaveLength(2);
    const branches = sessions.map((s) => s.branch).sort();
    expect(branches).toEqual(["feature/abc", "main"]);
    db.close();
  });

  test("returns empty for no events", () => {
    const db = createTestDb();
    const sessions = computeSessions(db, "proj_test_123");
    expect(sessions).toEqual([]);
    db.close();
  });

  test("respects since filter", () => {
    const db = createTestDb();
    const baseTs = 1700000000;
    const events = createEventSequence(baseTs, [0, 60, 120, 1000, 1060]);
    insertEvents(db, events);

    const sessions = computeSessions(db, "proj_test_123", baseTs + 500);
    // Only events at baseTs+1000 and baseTs+1060 should be included
    expect(sessions).toHaveLength(1);
    expect(sessions[0].event_count).toBe(2);
    db.close();
  });

  test("aggregates file areas from file paths", () => {
    const db = createTestDb();
    const baseTs = 1700000000;
    const events = [
      createEvent({ timestamp: baseTs, context: { file_path: "src/index.ts" } }),
      createEvent({ timestamp: baseTs + 60, context: { file_path: "src/utils.ts" } }),
      createEvent({
        timestamp: baseTs + 120,
        context: { file_path: "packages/core/db.ts" },
      }),
    ];
    insertEvents(db, events);

    const sessions = computeSessions(db, "proj_test_123");
    expect(sessions).toHaveLength(1);
    // buildSession uses first 2 path segments for areas
    // "src/index.ts" -> area "src/index.ts", "packages/core/db.ts" -> "packages/core"
    expect(sessions[0].file_areas.some((a) => a.startsWith("src/"))).toBe(true);
    expect(sessions[0].file_areas).toContain("packages/core");
    db.close();
  });

  test("filters out temp files from file lists", () => {
    const db = createTestDb();
    const baseTs = 1700000000;
    const events = [
      createEvent({ timestamp: baseTs, context: { file_path: "src/index.ts" } }),
      createEvent({ timestamp: baseTs + 60, context: { file_path: "src/temp.swp" } }),
      createEvent({ timestamp: baseTs + 120, context: { file_path: "src/backup.bak" } }),
    ];
    insertEvents(db, events);

    const sessions = computeSessions(db, "proj_test_123");
    expect(sessions[0].files_changed).toEqual(["src/index.ts"]);
    db.close();
  });
});

describe("mergeSessionsDuration", () => {
  test("returns 0 for empty input", () => {
    expect(mergeSessionsDuration([])).toBe(0);
  });

  test("returns duration of a single session", () => {
    const sessions = [
      {
        id: "s1",
        project_token: "proj",
        start_ts: 1000,
        end_ts: 2000,
        duration_seconds: 1000,
        source: "claude-code",
        topics: [],
        file_areas: [],
        event_count: 5,
      },
    ];
    expect(mergeSessionsDuration(sessions)).toBe(1000);
  });

  test("merges overlapping intervals", () => {
    const sessions = [
      {
        id: "s1",
        project_token: "proj",
        start_ts: 1000,
        end_ts: 2000,
        duration_seconds: 1000,
        source: "claude-code",
        topics: [],
        file_areas: [],
        event_count: 5,
      },
      {
        id: "s2",
        project_token: "proj",
        start_ts: 1500,
        end_ts: 2500,
        duration_seconds: 1000,
        source: "claude-code",
        topics: [],
        file_areas: [],
        event_count: 3,
      },
    ];
    // Merged: 1000-2500 = 1500s
    expect(mergeSessionsDuration(sessions)).toBe(1500);
  });

  test("handles contained intervals", () => {
    const sessions = [
      {
        id: "s1",
        project_token: "proj",
        start_ts: 1000,
        end_ts: 3000,
        duration_seconds: 2000,
        source: "claude-code",
        topics: [],
        file_areas: [],
        event_count: 10,
      },
      {
        id: "s2",
        project_token: "proj",
        start_ts: 1500,
        end_ts: 2000,
        duration_seconds: 500,
        source: "claude-code",
        topics: [],
        file_areas: [],
        event_count: 2,
      },
    ];
    // s2 is fully contained in s1, total = 2000
    expect(mergeSessionsDuration(sessions)).toBe(2000);
  });

  test("sums disjoint intervals", () => {
    const sessions = [
      {
        id: "s1",
        project_token: "proj",
        start_ts: 1000,
        end_ts: 2000,
        duration_seconds: 1000,
        source: "claude-code",
        topics: [],
        file_areas: [],
        event_count: 5,
      },
      {
        id: "s2",
        project_token: "proj",
        start_ts: 3000,
        end_ts: 4000,
        duration_seconds: 1000,
        source: "claude-code",
        topics: [],
        file_areas: [],
        event_count: 3,
      },
    ];
    expect(mergeSessionsDuration(sessions)).toBe(2000);
  });
});

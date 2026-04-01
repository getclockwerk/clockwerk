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
    db.close();
  });

  test("splits sessions at gap > SESSION_GAP", () => {
    const db = createTestDb();
    const baseTs = 1700000000;
    // Two clusters with a gap > SESSION_GAP
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

  test("partitions events by branch into separate sessions", () => {
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
    db.close();
  });

  test("returns empty for no events", () => {
    const db = createTestDb();
    const sessions = computeSessions(db, "proj_test_123");
    expect(sessions).toEqual([]);
    db.close();
  });

  test("uses custom sessionGap when provided", () => {
    const db = createTestDb();
    const baseTs = 1700000000;
    const customGap = 300; // 5 minutes
    // Events with a 400s gap - exceeds custom gap but not SESSION_GAP
    const events = createEventSequence(baseTs, [0, 60, 120, 120 + 400, 120 + 460]);
    insertEvents(db, events);

    // Without custom gap: single session (400s < SESSION_GAP of 1500s)
    const defaultSessions = computeSessions(db, "proj_test_123");
    expect(defaultSessions).toHaveLength(1);

    // With custom gap of 300s: two sessions (400s > 300s)
    const customSessions = computeSessions(db, "proj_test_123", undefined, customGap);
    expect(customSessions).toHaveLength(2);
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
    db.close();
  });

  test("picks the most frequent source as primary source", () => {
    const db = createTestDb();
    const baseTs = 1700000000;
    const events = [
      createEvent({ timestamp: baseTs, source: "claude-code" }),
      createEvent({ timestamp: baseTs + 60, source: "claude-code" }),
      createEvent({ timestamp: baseTs + 120, source: "cursor" }),
    ];
    insertEvents(db, events);

    const sessions = computeSessions(db, "proj_test_123");
    expect(sessions).toHaveLength(1);
    expect(sessions[0].source).toBe("claude-code");
    db.close();
  });

  test("session output contains minimal fields: id, project_token, start_ts, end_ts, duration_seconds, source", () => {
    const db = createTestDb();
    const baseTs = 1700000000;
    const events = [createEvent({ timestamp: baseTs })];
    insertEvents(db, events);

    const sessions = computeSessions(db, "proj_test_123");
    expect(sessions).toHaveLength(1);
    const session = sessions[0];
    expect(typeof session.id).toBe("string");
    expect(typeof session.project_token).toBe("string");
    expect(typeof session.start_ts).toBe("number");
    expect(typeof session.end_ts).toBe("number");
    expect(typeof session.duration_seconds).toBe("number");
    expect(typeof session.source).toBe("string");
    // Removed fields should not be present
    expect((session as unknown as Record<string, unknown>).branch).toBeUndefined();
    expect((session as unknown as Record<string, unknown>).topics).toBeUndefined();
    expect((session as unknown as Record<string, unknown>).event_count).toBeUndefined();
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
        project_token: "proj_test",
        start_ts: 1000,
        end_ts: 2000,
        duration_seconds: 1000,
        source: "claude-code",
      },
    ];
    expect(mergeSessionsDuration(sessions)).toBe(1000);
  });

  test("merges overlapping intervals", () => {
    const sessions = [
      {
        id: "s1",
        project_token: "proj_test",
        start_ts: 1000,
        end_ts: 2000,
        duration_seconds: 1000,
        source: "claude-code",
      },
      {
        id: "s2",
        project_token: "proj_test",
        start_ts: 1500,
        end_ts: 2500,
        duration_seconds: 1000,
        source: "claude-code",
      },
    ];
    // Merged: 1000-2500 = 1500s
    expect(mergeSessionsDuration(sessions)).toBe(1500);
  });

  test("handles contained intervals", () => {
    const sessions = [
      {
        id: "s1",
        project_token: "proj_test",
        start_ts: 1000,
        end_ts: 3000,
        duration_seconds: 2000,
        source: "claude-code",
      },
      {
        id: "s2",
        project_token: "proj_test",
        start_ts: 1500,
        end_ts: 2000,
        duration_seconds: 500,
        source: "claude-code",
      },
    ];
    // s2 is fully contained in s1, total = 2000
    expect(mergeSessionsDuration(sessions)).toBe(2000);
  });

  test("sums disjoint intervals", () => {
    const sessions = [
      {
        id: "s1",
        project_token: "proj_test",
        start_ts: 1000,
        end_ts: 2000,
        duration_seconds: 1000,
        source: "claude-code",
      },
      {
        id: "s2",
        project_token: "proj_test",
        start_ts: 3000,
        end_ts: 4000,
        duration_seconds: 1000,
        source: "claude-code",
      },
    ];
    expect(mergeSessionsDuration(sessions)).toBe(2000);
  });
});

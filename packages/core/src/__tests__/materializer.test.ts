import { describe, test, expect } from "bun:test";
import { SessionMaterializer } from "../materializer";
import { computeSessions, SESSION_GAP } from "../sessions";
import { insertEvents } from "../db";
import { createEvent, createTestDb } from "./fixtures";

function createMaterializer() {
  const db = createTestDb();
  const mat = new SessionMaterializer(db);
  return { db, mat };
}

describe("SessionMaterializer", () => {
  describe("materializeEvents", () => {
    test("creates a new session from a single event", () => {
      const { db, mat } = createMaterializer();
      const event = createEvent({ timestamp: 1700000000 });

      mat.materializeEvents([event]);
      const sessions = mat.querySessions();

      expect(sessions).toHaveLength(1);
      expect(sessions[0].project_token).toBe("proj_test_123");
      expect(sessions[0].start_ts).toBe(1700000000);
      expect(sessions[0].event_count).toBe(1);
      // Minimum duration enforced
      expect(sessions[0].duration_seconds).toBe(60);
      db.close();
    });

    test("extends an existing session with a nearby event", () => {
      const { db, mat } = createMaterializer();
      const event1 = createEvent({ timestamp: 1700000000 });
      const event2 = createEvent({ timestamp: 1700000120 }); // 2 min later

      mat.materializeEvents([event1]);
      mat.materializeEvents([event2]);
      const sessions = mat.querySessions();

      expect(sessions).toHaveLength(1);
      expect(sessions[0].event_count).toBe(2);
      expect(sessions[0].start_ts).toBe(1700000000);
      expect(sessions[0].end_ts).toBe(1700000120);
      db.close();
    });

    test("creates a new session when gap exceeds SESSION_GAP", () => {
      const { db, mat } = createMaterializer();
      const event1 = createEvent({ timestamp: 1700000000 });
      // Session 1 gets min-duration padded to end_ts = 1700000060
      // Materializer extends if end_ts >= event.timestamp - SESSION_GAP
      // So event2 must be > end_ts + SESSION_GAP
      const event2 = createEvent({ timestamp: 1700000060 + SESSION_GAP + 1 });

      mat.materializeEvents([event1]);
      mat.materializeEvents([event2]);
      const sessions = mat.querySessions();

      expect(sessions).toHaveLength(2);
      db.close();
    });

    test("handles batch of events", () => {
      const { db, mat } = createMaterializer();
      const events = [
        createEvent({ timestamp: 1700000000 }),
        createEvent({ timestamp: 1700000060 }),
        createEvent({ timestamp: 1700000120 }),
      ];

      mat.materializeEvents(events);
      const sessions = mat.querySessions();

      expect(sessions).toHaveLength(1);
      expect(sessions[0].event_count).toBe(3);
      db.close();
    });

    test("handles empty events array", () => {
      const { db, mat } = createMaterializer();
      mat.materializeEvents([]);
      const sessions = mat.querySessions();
      expect(sessions).toHaveLength(0);
      db.close();
    });

    test("accumulates metadata across events", () => {
      const { db, mat } = createMaterializer();
      const event1 = createEvent({
        timestamp: 1700000000,
        context: { tool_name: "Read", file_path: "src/index.ts", topic: "setup" },
      });
      const event2 = createEvent({
        timestamp: 1700000060,
        context: { tool_name: "Edit", file_path: "src/db.ts", topic: "database" },
      });

      mat.materializeEvents([event1, event2]);
      const sessions = mat.querySessions();

      expect(sessions[0].tools_used).toContain("Read");
      expect(sessions[0].tools_used).toContain("Edit");
      expect(sessions[0].files_changed).toContain("src/index.ts");
      expect(sessions[0].files_changed).toContain("src/db.ts");
      expect(sessions[0].topics).toContain("setup");
      expect(sessions[0].topics).toContain("database");
      db.close();
    });
  });

  describe("mergeAdjacentSessions", () => {
    test("merges sessions within SESSION_GAP", () => {
      const { db, mat } = createMaterializer();
      // Session 1: event at t=0, min-padded end_ts = t+60
      // Directly insert sessions with gap exactly at SESSION_GAP boundary
      db.run(
        `INSERT INTO sessions (id, project_token, start_ts, end_ts, duration_seconds, source, event_count, sync_version, synced_version)
         VALUES ('s1', 'proj_test_123', 1700000000, 1700000200, 200, 'claude-code', 2, 1, 0),
                ('s2', 'proj_test_123', 1700000500, 1700000700, 200, 'claude-code', 2, 1, 0)`,
      );
      // gap = 500 - 200 = 300 = SESSION_GAP, should merge (<= SESSION_GAP)

      expect(mat.querySessions()).toHaveLength(2);

      const merged = mat.mergeAdjacentSessions();
      expect(merged).toBeGreaterThanOrEqual(1);

      const sessions = mat.querySessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].event_count).toBe(4);
      db.close();
    });

    test("does not merge sessions beyond SESSION_GAP", () => {
      const { db, mat } = createMaterializer();
      // Directly insert two sessions with gap > SESSION_GAP
      const s2Start = 1700000200 + SESSION_GAP + 1;
      db.run(
        `INSERT INTO sessions (id, project_token, start_ts, end_ts, duration_seconds, source, event_count, sync_version, synced_version)
         VALUES ('s1', 'proj_test_123', 1700000000, 1700000200, 200, 'claude-code', 2, 1, 0),
                ('s2', 'proj_test_123', ${s2Start}, ${s2Start + 200}, 200, 'claude-code', 2, 1, 0)`,
      );
      // gap = s2Start - 200 = SESSION_GAP + 1 > SESSION_GAP

      mat.mergeAdjacentSessions();

      const sessions = mat.querySessions();
      expect(sessions).toHaveLength(2);
      db.close();
    });

    test("soft-deletes the merged source session", () => {
      const { db, mat } = createMaterializer();
      // Directly insert two sessions within merge range
      db.run(
        `INSERT INTO sessions (id, project_token, start_ts, end_ts, duration_seconds, source, event_count, sync_version, synced_version)
         VALUES ('s1', 'proj_test_123', 1700000000, 1700000200, 200, 'claude-code', 2, 1, 0),
                ('s2', 'proj_test_123', 1700000500, 1700000700, 200, 'claude-code', 2, 1, 0)`,
      );
      // gap = 500 - 200 = 300 = SESSION_GAP, will merge

      mat.mergeAdjacentSessions();

      const allRows = db
        .query<{ deleted_at: number | null }, []>("SELECT deleted_at FROM sessions")
        .all();
      const deleted = allRows.filter((r) => r.deleted_at !== null);
      expect(deleted).toHaveLength(1);
      db.close();
    });
  });

  describe("querySessions", () => {
    test("filters by projectToken", () => {
      const { db, mat } = createMaterializer();
      mat.materializeEvents([
        createEvent({ timestamp: 1700000000, project_token: "proj_a" }),
      ]);
      mat.materializeEvents([
        createEvent({ timestamp: 1700000000, project_token: "proj_b" }),
      ]);

      const sessionsA = mat.querySessions({ projectToken: "proj_a" });
      expect(sessionsA).toHaveLength(1);
      expect(sessionsA[0].project_token).toBe("proj_a");
      db.close();
    });

    test("filters by since timestamp", () => {
      const { db, mat } = createMaterializer();
      mat.materializeEvents([createEvent({ timestamp: 1700000000 })]);
      mat.materializeEvents([createEvent({ timestamp: 1700000000 + SESSION_GAP + 100 })]);

      const sessions = mat.querySessions({ since: 1700000000 + SESSION_GAP });
      expect(sessions).toHaveLength(1);
      db.close();
    });

    test("excludes soft-deleted sessions", () => {
      const { db, mat } = createMaterializer();
      mat.materializeEvents([createEvent({ timestamp: 1700000000 })]);
      mat.materializeEvents([createEvent({ timestamp: 1700000060 + SESSION_GAP })]);
      mat.mergeAdjacentSessions();

      const sessions = mat.querySessions();
      // Only the merged result, not the deleted source
      expect(sessions).toHaveLength(1);
      db.close();
    });
  });

  describe("backfillFromEvents", () => {
    test("backfills sessions from existing events", () => {
      const { db, mat } = createMaterializer();
      // Insert events directly (simulating pre-existing data)
      const events = [
        createEvent({ timestamp: 1700000000 }),
        createEvent({ timestamp: 1700000060 }),
        createEvent({ timestamp: 1700000120 }),
      ];
      insertEvents(db, events);

      expect(mat.needsBackfill()).toBe(true);

      mat.backfillFromEvents(computeSessions);

      expect(mat.hasAnySessions()).toBe(true);
      const sessions = mat.querySessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].event_count).toBe(3);
      db.close();
    });
  });

  describe("pruneOldEvents", () => {
    test("removes events older than cutoff", () => {
      const { db, mat } = createMaterializer();
      const now = Math.floor(Date.now() / 1000);
      const oldTs = now - 60 * 86400; // 60 days ago
      const recentTs = now - 5 * 86400; // 5 days ago

      // Insert events and only materialize the recent one
      // so the earliest session is recent, and the old event gets pruned
      const oldEvent = createEvent({ timestamp: oldTs });
      const recentEvent = createEvent({ timestamp: recentTs });
      insertEvents(db, [oldEvent, recentEvent]);
      mat.materializeEvents([recentEvent]);

      // daysCutoff = now - 30*86400 (30 days ago)
      // earliestSession - SESSION_GAP = recentTs - 300 (5 days ago - 300s)
      // cutoff = min(daysCutoff, earliestSession - SESSION_GAP) = 30 days ago
      // oldTs (60 days ago) < cutoff (30 days ago) -> pruned
      const pruned = mat.pruneOldEvents(30);
      expect(pruned).toBeGreaterThanOrEqual(1);

      const remaining = db
        .query<{ cnt: number }, []>("SELECT COUNT(*) as cnt FROM events")
        .get();
      expect(remaining!.cnt).toBe(1);
      db.close();
    });
  });
});

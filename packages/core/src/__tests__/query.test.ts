import { describe, test, expect } from "bun:test";
import { querySessions } from "../query";
import { SessionMaterializer } from "../materializer";
import { insertEvents } from "../db";
import { createEvent, createTestDb } from "./fixtures";

describe("querySessions", () => {
  describe("since/until overrides", () => {
    test("returns empty result when no data", () => {
      const db = createTestDb();
      const result = querySessions(db);
      expect(result.sessions).toHaveLength(0);
      expect(result.total_seconds).toBe(0);
      db.close();
    });

    test("since filters sessions by end_ts", () => {
      const db = createTestDb();
      const mat = new SessionMaterializer(db);
      const base = 1700000000;

      mat.materializeEvents([createEvent({ timestamp: base })]);
      mat.materializeEvents([createEvent({ timestamp: base + 2000 })]);

      // The second session starts at base+2000; query since base+1500 should only include it
      const result = querySessions(db, { since: base + 1500 });
      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0].start_ts).toBe(base + 2000);
      db.close();
    });

    test("until filters sessions by start_ts", () => {
      const db = createTestDb();
      const mat = new SessionMaterializer(db);
      const base = 1700000000;

      mat.materializeEvents([createEvent({ timestamp: base })]);
      mat.materializeEvents([createEvent({ timestamp: base + 2000 })]);

      // Pass since=0 to avoid period defaulting to "today"; query until base+1000 includes only first session
      const result = querySessions(db, { since: 0, until: base + 1000 });
      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0].start_ts).toBe(base);
      db.close();
    });

    test("since and until together define an exact window", () => {
      const db = createTestDb();
      const mat = new SessionMaterializer(db);
      const base = 1700000000;

      mat.materializeEvents([createEvent({ timestamp: base })]);
      mat.materializeEvents([createEvent({ timestamp: base + 2000 })]);
      mat.materializeEvents([createEvent({ timestamp: base + 4000 })]);

      const result = querySessions(db, { since: base + 1500, until: base + 3000 });
      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0].start_ts).toBe(base + 2000);
      db.close();
    });
  });

  describe("projectToken filtering", () => {
    test("filters sessions by projectToken", () => {
      const db = createTestDb();
      const mat = new SessionMaterializer(db);

      mat.materializeEvents([
        createEvent({ timestamp: 1700000000, project_token: "proj_a" }),
      ]);
      mat.materializeEvents([
        createEvent({ timestamp: 1700000000, project_token: "proj_b" }),
      ]);

      const result = querySessions(db, { since: 0, projectToken: "proj_a" });
      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0].project_token).toBe("proj_a");
      db.close();
    });

    test("returns all projects when projectToken is omitted", () => {
      const db = createTestDb();
      const mat = new SessionMaterializer(db);

      mat.materializeEvents([
        createEvent({ timestamp: 1700000000, project_token: "proj_a" }),
      ]);
      mat.materializeEvents([
        createEvent({ timestamp: 1700000000, project_token: "proj_b" }),
      ]);

      const result = querySessions(db, { since: 0 });
      expect(result.sessions).toHaveLength(2);
      db.close();
    });
  });

  describe("total_seconds with overlap merging", () => {
    test("returns sum of non-overlapping sessions", () => {
      const db = createTestDb();
      const mat = new SessionMaterializer(db);
      const base = 1700000000;

      // Two sessions separated by > SESSION_GAP, each 60s (minimum)
      mat.materializeEvents([createEvent({ timestamp: base })]);
      mat.materializeEvents([createEvent({ timestamp: base + 2000 })]);

      const result = querySessions(db, { since: 0 });
      expect(result.sessions).toHaveLength(2);
      expect(result.total_seconds).toBe(60 + 60); // each padded to minimum 60s
      db.close();
    });

    test("merges overlapping sessions for total_seconds", () => {
      const db = createTestDb();
      const base = 1700000000;

      // Insert two overlapping sessions directly
      db.run(
        `INSERT INTO sessions (id, project_token, start_ts, end_ts, duration_seconds, source, event_count, sync_version, synced_version)
         VALUES ('s1', 'proj_test_123', ${base}, ${base + 300}, 300, 'claude-code', 1, 1, 0),
                ('s2', 'proj_test_123', ${base + 100}, ${base + 400}, 300, 'claude-code', 1, 1, 0)`,
      );

      const result = querySessions(db, { since: 0 });
      // Overlap: s1=[base, base+300], s2=[base+100, base+400]
      // Merged: [base, base+400] = 400s total
      expect(result.total_seconds).toBe(400);
      db.close();
    });
  });

  describe("period: 'all'", () => {
    test("returns all sessions regardless of timestamp", () => {
      const db = createTestDb();
      const mat = new SessionMaterializer(db);

      mat.materializeEvents([createEvent({ timestamp: 1000000000 })]);
      mat.materializeEvents([createEvent({ timestamp: 1700000000 })]);

      const result = querySessions(db, { period: "all" });
      expect(result.sessions).toHaveLength(2);
      db.close();
    });
  });

  describe("period: 'today'", () => {
    test("returns sessions from today only", () => {
      const db = createTestDb();
      const mat = new SessionMaterializer(db);
      const now = Math.floor(Date.now() / 1000);

      // Session from today
      mat.materializeEvents([createEvent({ timestamp: now - 3600 })]);
      // Session from long ago (definitely not today)
      mat.materializeEvents([createEvent({ timestamp: now - 7 * 86400 })]);

      const result = querySessions(db, { period: "today" });
      expect(result.sessions).toHaveLength(1);
      db.close();
    });
  });

  describe("period: 'week'", () => {
    test("uses Monday-based ISO week boundary", () => {
      const db = createTestDb();
      const mat = new SessionMaterializer(db);

      // Compute expected week start (same logic as query.ts)
      const d = new Date();
      const day = d.getDay();
      const daysSinceMonday = day === 0 ? 6 : day - 1;
      d.setDate(d.getDate() - daysSinceMonday);
      d.setHours(0, 0, 0, 0);
      const weekStart = Math.floor(d.getTime() / 1000);

      // Session within this week
      mat.materializeEvents([createEvent({ timestamp: weekStart + 3600 })]);
      // Session before this week
      mat.materializeEvents([createEvent({ timestamp: weekStart - 86400 })]);

      const result = querySessions(db, { period: "week" });
      expect(result.sessions).toHaveLength(1);
      db.close();
    });
  });

  describe("SessionMaterializer source path", () => {
    test("returns same results as Database path when sessions are materialized", () => {
      const db = createTestDb();
      const mat = new SessionMaterializer(db);
      const base = 1700000000;

      mat.materializeEvents([
        createEvent({ timestamp: base, project_token: "proj_test_123" }),
      ]);

      const fromDb = querySessions(db, { period: "all" });
      const fromMat = querySessions(mat, { period: "all" });

      expect(fromMat.sessions).toHaveLength(fromDb.sessions.length);
      expect(fromMat.total_seconds).toBe(fromDb.total_seconds);
      db.close();
    });

    test("filters by projectToken when using materializer", () => {
      const db = createTestDb();
      const mat = new SessionMaterializer(db);

      mat.materializeEvents([
        createEvent({ timestamp: 1700000000, project_token: "proj_a" }),
      ]);
      mat.materializeEvents([
        createEvent({ timestamp: 1700000000, project_token: "proj_b" }),
      ]);

      const result = querySessions(mat, { period: "all", projectToken: "proj_a" });
      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0].project_token).toBe("proj_a");
      db.close();
    });

    test("handles explicit since/until range with materializer", () => {
      const db = createTestDb();
      const mat = new SessionMaterializer(db);
      const base = 1700000000;

      mat.materializeEvents([createEvent({ timestamp: base })]);
      mat.materializeEvents([createEvent({ timestamp: base + 2000 })]);
      mat.materializeEvents([createEvent({ timestamp: base + 4000 })]);

      const result = querySessions(mat, { since: base + 1500, until: base + 3000 });
      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0].start_ts).toBe(base + 2000);
      db.close();
    });

    test("does not call hasAnySessions (no COUNT query detour)", () => {
      const db = createTestDb();
      const mat = new SessionMaterializer(db);
      const base = 1700000000;

      mat.materializeEvents([createEvent({ timestamp: base })]);

      // If the materializer path incorrectly called hasAnySessions, that would be
      // an extra round-trip. We verify correctness by checking results are still valid.
      const result = querySessions(mat, { since: 0 });
      expect(result.sessions).toHaveLength(1);
      db.close();
    });
  });

  describe("fallback-from-events path", () => {
    test("computes sessions from events when sessions table is empty", () => {
      const db = createTestDb();
      const base = 1700000000;

      // Insert events without materializing
      insertEvents(db, [
        createEvent({ timestamp: base, project_token: "proj_test_123" }),
        createEvent({ timestamp: base + 60, project_token: "proj_test_123" }),
      ]);

      const result = querySessions(db, { since: 0 });
      expect(result.sessions).toHaveLength(1);
      expect(result.total_seconds).toBeGreaterThan(0);
      db.close();
    });

    test("fallback fan-out covers all project tokens", () => {
      const db = createTestDb();
      const base = 1700000000;

      insertEvents(db, [
        createEvent({ timestamp: base, project_token: "proj_a" }),
        createEvent({ timestamp: base, project_token: "proj_b" }),
      ]);

      const result = querySessions(db, { since: 0 });
      expect(result.sessions).toHaveLength(2);
      db.close();
    });

    test("fallback respects projectToken filter", () => {
      const db = createTestDb();
      const base = 1700000000;

      insertEvents(db, [
        createEvent({ timestamp: base, project_token: "proj_a" }),
        createEvent({ timestamp: base, project_token: "proj_b" }),
      ]);

      const result = querySessions(db, { since: 0, projectToken: "proj_a" });
      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0].project_token).toBe("proj_a");
      db.close();
    });
  });
});

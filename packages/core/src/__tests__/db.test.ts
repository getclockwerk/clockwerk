import { describe, test, expect } from "bun:test";
import { insertEvent, insertEvents } from "../db";
import { createEvent, createTestDb } from "./fixtures";

describe("insertEvent", () => {
  test("inserts a single event", () => {
    const db = createTestDb();
    const event = createEvent({ id: "single-1" });
    insertEvent(db, event);

    const row = db.query("SELECT * FROM events WHERE id = ?").get("single-1") as {
      id: string;
    };
    expect(row).not.toBeNull();
    expect(row.id).toBe("single-1");
    db.close();
  });

  test("deduplicates via OR IGNORE", () => {
    const db = createTestDb();
    const event = createEvent({ id: "dup-1" });
    insertEvent(db, event);
    insertEvent(db, event);

    const count = db
      .query("SELECT COUNT(*) as cnt FROM events WHERE id = ?")
      .get("dup-1") as { cnt: number };
    expect(count.cnt).toBe(1);
    db.close();
  });

  test("stores all event fields correctly", () => {
    const db = createTestDb();
    const event = createEvent({
      id: "fields-1",
      timestamp: 1700000000,
      event_type: "file_edit",
      source: "cursor",
      project_token: "proj_xyz",
      context: {
        tool_name: "Edit",
        description: "editing file",
        file_path: "src/index.ts",
        branch: "main",
        issue_id: "ABC-123",
        topic: "refactoring",
      },
      harness_session_id: "session-abc",
    });
    insertEvent(db, event);

    const row = db.query("SELECT * FROM events WHERE id = ?").get("fields-1") as Record<
      string,
      unknown
    >;
    expect(row.timestamp).toBe(1700000000);
    expect(row.event_type).toBe("file_edit");
    expect(row.source).toBe("cursor");
    expect(row.project_token).toBe("proj_xyz");
    expect(row.tool_name).toBe("Edit");
    expect(row.description).toBe("editing file");
    expect(row.file_path).toBe("src/index.ts");
    expect(row.branch).toBe("main");
    expect(row.issue_id).toBe("ABC-123");
    expect(row.topic).toBe("refactoring");
    expect(row.harness_session_id).toBe("session-abc");
    db.close();
  });
});

describe("insertEvents", () => {
  test("bulk inserts multiple events", () => {
    const db = createTestDb();
    const events = [
      createEvent({ id: "bulk-1" }),
      createEvent({ id: "bulk-2" }),
      createEvent({ id: "bulk-3" }),
    ];
    insertEvents(db, events);

    const count = db.query("SELECT COUNT(*) as cnt FROM events").get() as { cnt: number };
    expect(count.cnt).toBe(3);
    db.close();
  });

  test("deduplicates within bulk insert", () => {
    const db = createTestDb();
    const event = createEvent({ id: "bulk-dup" });
    insertEvents(db, [event, event]);

    const count = db
      .query("SELECT COUNT(*) as cnt FROM events WHERE id = ?")
      .get("bulk-dup") as { cnt: number };
    expect(count.cnt).toBe(1);
    db.close();
  });

  test("handles empty array", () => {
    const db = createTestDb();
    insertEvents(db, []);
    const count = db.query("SELECT COUNT(*) as cnt FROM events").get() as { cnt: number };
    expect(count.cnt).toBe(0);
    db.close();
  });
});

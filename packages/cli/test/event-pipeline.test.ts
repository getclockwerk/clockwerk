import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { migrateDb, insertEvents } from "@clockwerk/core";
import { createEventPipeline } from "../src/daemon/event-pipeline";
import type { ClockwerkEvent } from "@clockwerk/core";

let eventCounter = 0;

function createEvent(overrides?: Partial<ClockwerkEvent>): ClockwerkEvent {
  eventCounter++;
  return {
    id: overrides?.id ?? `evt-${eventCounter}-${crypto.randomUUID().slice(0, 8)}`,
    timestamp: overrides?.timestamp ?? Math.floor(Date.now() / 1000),
    event_type: overrides?.event_type ?? "tool_call",
    source: overrides?.source ?? "claude-code",
    project_token: overrides?.project_token ?? "proj_test_abc",
    context: {
      description: "test event",
      ...overrides?.context,
    },
  };
}

function createTestDb(): Database {
  const db = new Database(":memory:");
  migrateDb(db);
  return db;
}

describe("createEventPipeline", () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  test("ingest buffers events", () => {
    const pipeline = createEventPipeline({ db });
    const event = createEvent();
    pipeline.ingest(event);
    expect(pipeline.bufferedCount).toBe(1);
    pipeline.stop();
  });

  test("flush writes events to db and clears buffer", () => {
    const pipeline = createEventPipeline({ db });
    const event = createEvent({ timestamp: Math.floor(Date.now() / 1000) });
    pipeline.ingest(event);
    expect(pipeline.bufferedCount).toBe(1);
    pipeline.flush();
    expect(pipeline.bufferedCount).toBe(0);

    const rows = db.query("SELECT * FROM events").all();
    expect(rows).toHaveLength(1);
    pipeline.stop();
  });

  test("flush materializes events into sessions table", () => {
    const pipeline = createEventPipeline({ db });
    const event = createEvent({ timestamp: Math.floor(Date.now() / 1000) });
    pipeline.ingest(event);
    pipeline.flush();

    const sessions = pipeline.materializer.querySessions();
    expect(sessions).toHaveLength(1);
    pipeline.stop();
  });

  test("flush is no-op when buffer is empty", () => {
    const pipeline = createEventPipeline({ db });
    pipeline.flush();
    expect(pipeline.bufferedCount).toBe(0);

    const rows = db.query("SELECT * FROM events").all();
    expect(rows).toHaveLength(0);
    pipeline.stop();
  });

  test("ingest triggers flush when batch size reached", () => {
    const pipeline = createEventPipeline({ db, batchSize: 3 });
    const now = Math.floor(Date.now() / 1000);

    pipeline.ingest(createEvent({ timestamp: now }));
    pipeline.ingest(createEvent({ timestamp: now + 1 }));
    expect(pipeline.bufferedCount).toBe(2);

    pipeline.ingest(createEvent({ timestamp: now + 2 }));
    // Flush triggered at batchSize=3
    expect(pipeline.bufferedCount).toBe(0);

    const rows = db.query("SELECT * FROM events").all();
    expect(rows).toHaveLength(3);
    pipeline.stop();
  });

  test("flush retries buffer on error", () => {
    const errors: string[] = [];
    const pipeline = createEventPipeline({
      db,
      onError(context, _err) {
        errors.push(context);
      },
    });

    // Close the db to trigger a flush error
    const event = createEvent();
    pipeline.ingest(event);
    db.close();

    pipeline.flush();
    expect(errors).toContain("flush");
    // Event returned to buffer for retry
    expect(pipeline.bufferedCount).toBe(1);

    // Re-open db so afterEach cleanup doesn't double-close
    db = createTestDb();
    pipeline.stop();
  });

  test("start initializes timers and stop clears them", () => {
    const pipeline = createEventPipeline({
      db,
      flushIntervalMs: 100_000,
      mergeIntervalMs: 200_000,
      pruneIntervalMs: 300_000,
    });
    pipeline.start();
    // No error means timers started successfully
    pipeline.stop();
    // After stop, bufferedCount should be 0 (flush ran)
    expect(pipeline.bufferedCount).toBe(0);
  });

  test("stop flushes remaining events", () => {
    const pipeline = createEventPipeline({
      db,
      flushIntervalMs: 100_000, // long interval so auto-flush doesn't run
    });
    pipeline.start();
    const event = createEvent({ timestamp: Math.floor(Date.now() / 1000) });
    pipeline.ingest(event);
    expect(pipeline.bufferedCount).toBe(1);
    pipeline.stop();
    expect(pipeline.bufferedCount).toBe(0);

    const rows = db.query("SELECT * FROM events").all();
    expect(rows).toHaveLength(1);
  });

  test("start runs backfill when sessions table is empty but events exist", () => {
    const now = Math.floor(Date.now() / 1000);
    // Pre-populate events table directly (bypassing pipeline)
    insertEvents(db, [
      createEvent({ timestamp: now - 3600 }),
      createEvent({ timestamp: now - 3500 }),
    ]);

    const pipeline = createEventPipeline({ db });
    // Before start: no sessions
    expect(pipeline.materializer.hasAnySessions()).toBe(false);
    expect(pipeline.materializer.needsBackfill()).toBe(true);

    pipeline.start();

    // After start: sessions backfilled
    expect(pipeline.materializer.hasAnySessions()).toBe(true);
    pipeline.stop();
  });

  test("start skips backfill when sessions already exist", () => {
    const now = Math.floor(Date.now() / 1000);
    insertEvents(db, [createEvent({ timestamp: now - 3600 })]);

    const pipeline = createEventPipeline({ db });
    // Backfill once
    pipeline.start();
    expect(pipeline.materializer.hasAnySessions()).toBe(true);
    pipeline.stop();

    // Second pipeline instance - no backfill needed
    const pipeline2 = createEventPipeline({ db });
    expect(pipeline2.materializer.needsBackfill()).toBe(false);
    pipeline2.start();
    pipeline2.stop();
  });

  test("materializer is accessible and functional", () => {
    const pipeline = createEventPipeline({ db });
    expect(pipeline.materializer).toBeDefined();
    expect(typeof pipeline.materializer.querySessions).toBe("function");
    pipeline.stop();
  });

  test("onError callback receives merge errors", () => {
    const errors: string[] = [];
    const pipeline = createEventPipeline({
      db,
      onError(context) {
        errors.push(context);
      },
      mergeIntervalMs: 50,
    });
    pipeline.start();
    // Close db to trigger merge errors
    db.close();

    // Wait for merge timer to fire
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        // Restore db for cleanup
        db = createTestDb();
        pipeline.stop();
        expect(errors).toContain("merge");
        resolve();
      }, 100);
    });
  });
});

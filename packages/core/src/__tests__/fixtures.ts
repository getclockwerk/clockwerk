import { Database } from "bun:sqlite";
import { migrateDb } from "../db";
import type { ClockwerkEvent } from "../types";

let eventCounter = 0;

export function createEvent(overrides?: Partial<ClockwerkEvent>): ClockwerkEvent {
  eventCounter++;
  return {
    id: overrides?.id ?? `evt-${eventCounter}-${crypto.randomUUID().slice(0, 8)}`,
    timestamp: overrides?.timestamp ?? Math.floor(Date.now() / 1000),
    event_type: overrides?.event_type ?? "tool_call",
    source: overrides?.source ?? "claude-code",
    project_token: overrides?.project_token ?? "proj_test_123",
    context: {
      tool_name: "Read",
      description: "test event",
      ...overrides?.context,
    },
    harness_session_id: overrides?.harness_session_id,
  };
}

export function createEventSequence(
  baseTs: number,
  offsets: number[],
  overrides?: Partial<ClockwerkEvent>,
): ClockwerkEvent[] {
  return offsets.map((offset) =>
    createEvent({
      ...overrides,
      timestamp: baseTs + offset,
    }),
  );
}

export function createTestDb(): Database {
  const db = new Database(":memory:");
  migrateDb(db);
  return db;
}

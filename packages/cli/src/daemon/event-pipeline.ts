import type { Database } from "bun:sqlite";
import {
  insertEvents,
  computeSessions,
  SessionMaterializer,
  type ClockwerkEvent,
} from "@clockwerk/core";

export interface EventPipelineOpts {
  db: Database;
  flushIntervalMs?: number;
  mergeIntervalMs?: number;
  pruneIntervalMs?: number;
  pruneOlderThanDays?: number;
  batchSize?: number;
  onError?: (context: string, err: unknown) => void;
}

export interface EventPipeline {
  ingest(event: ClockwerkEvent): void;
  flush(): void;
  readonly materializer: SessionMaterializer;
  readonly bufferedCount: number;
  start(): void;
  stop(): void;
}

export function createEventPipeline(opts: EventPipelineOpts): EventPipeline {
  const {
    db,
    flushIntervalMs = 1_000,
    mergeIntervalMs = 30_000,
    pruneIntervalMs = 3_600_000,
    pruneOlderThanDays = 30,
    batchSize = 100,
    onError,
  } = opts;

  let buffer: ClockwerkEvent[] = [];
  let flushTimer: ReturnType<typeof setInterval> | null = null;
  let mergeTimer: ReturnType<typeof setInterval> | null = null;
  let pruneTimer: ReturnType<typeof setInterval> | null = null;

  const materializer = new SessionMaterializer(db);

  function flush(): void {
    if (buffer.length === 0) return;

    const batch = buffer;
    buffer = [];

    try {
      insertEvents(db, batch);
      materializer.materializeEvents(batch);
    } catch (err) {
      onError?.("flush", err);
      buffer = [...batch, ...buffer];
    }
  }

  function ingest(event: ClockwerkEvent): void {
    buffer.push(event);
    if (buffer.length >= batchSize) {
      flush();
    }
  }

  function start(): void {
    if (materializer.needsBackfill()) {
      materializer.backfillFromEvents(computeSessions);
    }

    flushTimer = setInterval(flush, flushIntervalMs);

    mergeTimer = setInterval(() => {
      try {
        materializer.mergeAdjacentSessions();
      } catch (err) {
        onError?.("merge", err);
      }
    }, mergeIntervalMs);

    pruneTimer = setInterval(() => {
      try {
        materializer.pruneOldEvents(pruneOlderThanDays);
      } catch (err) {
        onError?.("prune", err);
      }
    }, pruneIntervalMs);
  }

  function stop(): void {
    if (flushTimer !== null) {
      clearInterval(flushTimer);
      flushTimer = null;
    }
    if (mergeTimer !== null) {
      clearInterval(mergeTimer);
      mergeTimer = null;
    }
    if (pruneTimer !== null) {
      clearInterval(pruneTimer);
      pruneTimer = null;
    }
    try {
      materializer.mergeAdjacentSessions();
    } catch {
      // best effort
    }
    flush();
  }

  return {
    ingest,
    flush,
    get materializer() {
      return materializer;
    },
    get bufferedCount() {
      return buffer.length;
    },
    start,
    stop,
  };
}

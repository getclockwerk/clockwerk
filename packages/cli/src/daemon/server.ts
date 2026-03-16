import {
  unlinkSync,
  existsSync,
  readFileSync,
  openSync,
  writeSync,
  closeSync,
  constants,
} from "node:fs";
import { umask } from "node:process";
import {
  getDb,
  insertEvents,
  closeDb,
  getDaemonSocketPath,
  getDaemonPidPath,
  getClockwerkDir,
  getProjectRegistry,
  computeSessions,
  mergeSessionsDuration,
  SessionMaterializer,
  createWatchersFromRegistry,
  type ClockwerkEvent,
  type DaemonMessage,
  type DaemonResponse,
} from "@clockwerk/core";
import { mkdirSync } from "node:fs";
import { startPluginsFromRegistry, type PluginManager } from "./plugins";
import { initLogger, closeLogger, createLogger } from "./logger";

const log = createLogger("clockwerk");
const socketLog = createLogger("daemon");

const FLUSH_INTERVAL_MS = 1_000;
const FLUSH_BATCH_SIZE = 100;

let eventBuffer: ClockwerkEvent[] = [];
let running = false;
let pluginManager: PluginManager | null = null;
let materializer: SessionMaterializer | null = null;

function flushEvents(): void {
  if (eventBuffer.length === 0) return;

  const batch = eventBuffer;
  eventBuffer = [];

  try {
    const db = getDb();
    insertEvents(db, batch);
    // Materialize events into sessions table
    materializer?.materializeEvents(batch);
  } catch (err) {
    socketLog.error(`Failed to flush events: ${err}`);
    // Put events back in the buffer for retry
    eventBuffer = [...batch, ...eventBuffer];
  }
}

function handleQuery(method: string, params?: Record<string, unknown>): unknown {
  const db = getDb();

  switch (method) {
    case "status": {
      return {
        running: true,
        pid: process.pid,
        buffered_events: eventBuffer.length,
        plugins: pluginManager?.getStats() ?? [],
      };
    }

    case "sessions": {
      const period = (params?.period as string) ?? "today";
      const now = Math.floor(Date.now() / 1000);
      let since: number;

      let until: number | undefined;

      switch (period) {
        case "today": {
          const d = new Date();
          d.setHours(0, 0, 0, 0);
          since = Math.floor(d.getTime() / 1000);
          break;
        }
        case "yesterday": {
          const d = new Date();
          d.setHours(0, 0, 0, 0);
          until = Math.floor(d.getTime() / 1000);
          d.setDate(d.getDate() - 1);
          since = Math.floor(d.getTime() / 1000);
          break;
        }
        case "week": {
          const d = new Date();
          const day = d.getDay();
          // getDay(): 0=Sun, 1=Mon, ..., 6=Sat
          // Go back to Monday: Mon=0, Tue=1, ..., Sun=6
          const daysSinceMonday = day === 0 ? 6 : day - 1;
          d.setDate(d.getDate() - daysSinceMonday);
          d.setHours(0, 0, 0, 0);
          since = Math.floor(d.getTime() / 1000);
          break;
        }
        case "month": {
          const d = new Date();
          d.setDate(1);
          d.setHours(0, 0, 0, 0);
          since = Math.floor(d.getTime() / 1000);
          break;
        }
        case "all":
          since = 0;
          break;
        default:
          since = now - 86400;
      }

      const projectToken = params?.project_token as string | undefined;

      // Read from materialized sessions table
      if (materializer) {
        const sessions = materializer.querySessions({
          projectToken: projectToken ?? undefined,
          since: since || undefined,
          until,
        });
        const totalSeconds = mergeSessionsDuration(sessions);
        return { sessions, total_seconds: totalSeconds };
      }

      // Fallback to compute from events (pre-backfill)
      if (!projectToken) {
        const tokens = db
          .query<{ project_token: string }, [number]>(
            "SELECT DISTINCT project_token FROM events WHERE timestamp >= ?",
          )
          .all(since)
          .map((r) => r.project_token);

        const allSessions = tokens.flatMap((t) => computeSessions(db, t, since));
        const totalSeconds = mergeSessionsDuration(allSessions);
        return { sessions: allSessions, total_seconds: totalSeconds };
      }

      const sessions = computeSessions(db, projectToken, since);
      const totalSeconds = mergeSessionsDuration(sessions);
      return { sessions, total_seconds: totalSeconds };
    }

    case "update_session": {
      const sessionId = params?.session_id as string | undefined;
      if (!sessionId) return { error: "session_id is required" };

      const description = params?.description as string | undefined;
      const summary = params?.summary as string | undefined;

      if (!materializer) return { error: "Materializer not initialized" };

      const updated = materializer.updateSession(sessionId, { description, summary });
      if (!updated) return { error: `Session not found: ${sessionId}` };

      return { ok: true, session: updated };
    }

    case "delete_session": {
      const sessionId = params?.session_id as string | undefined;
      if (!sessionId) return { error: "session_id is required" };

      if (!materializer) return { error: "Materializer not initialized" };

      const deleted = materializer.deleteSession(sessionId);
      if (!deleted) return { error: `Session not found: ${sessionId}` };

      return { ok: true };
    }

    case "restore_session": {
      const sessionId = params?.session_id as string | undefined;
      if (!sessionId) return { error: "session_id is required" };

      if (!materializer) return { error: "Materializer not initialized" };

      const restored = materializer.restoreSession(sessionId);
      if (!restored) return { error: `Deleted session not found: ${sessionId}` };

      return { ok: true };
    }

    default:
      return { error: `Unknown method: ${method}` };
  }
}

const MAX_MESSAGE_SIZE = 64 * 1024; // 64 KB

function validateEvent(data: unknown): data is ClockwerkEvent {
  if (typeof data !== "object" || data === null) return false;
  const e = data as Record<string, unknown>;
  if (typeof e.id !== "string") return false;
  if (typeof e.timestamp !== "number") return false;
  const now = Math.floor(Date.now() / 1000);
  if (e.timestamp < now - 86400 || e.timestamp > now + 3600) return false;
  if (typeof e.event_type !== "string") return false;
  if (typeof e.source !== "string") return false;
  if (typeof e.project_token !== "string") return false;
  if (typeof e.context !== "object" || e.context === null) return false;
  return true;
}

function handleMessage(raw: string): string | null {
  if (raw.length > MAX_MESSAGE_SIZE) return null;

  let msg: DaemonMessage;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }

  if (msg.type === "event") {
    if (!validateEvent(msg.data)) return null;
    eventBuffer.push(msg.data);
    if (eventBuffer.length >= FLUSH_BATCH_SIZE) {
      flushEvents();
    }
    return null; // fire-and-forget, no response
  }

  if (msg.type === "query") {
    const result = handleQuery(msg.method, msg.params);
    const response: DaemonResponse = {
      type: "response",
      id: msg.id,
      data: result,
    };
    return JSON.stringify(response);
  }

  return null;
}

export function startDaemon(opts?: { foreground?: boolean }): void {
  initLogger({ foreground: opts?.foreground ?? false });
  const socketPath = getDaemonSocketPath();
  const pidPath = getDaemonPidPath();
  const clockwerkDir = getClockwerkDir();

  if (!existsSync(clockwerkDir)) {
    mkdirSync(clockwerkDir, { recursive: true, mode: 0o700 });
  }

  // Kill any existing daemon to prevent orphans
  if (existsSync(pidPath)) {
    try {
      const existingPid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
      if (existingPid !== process.pid) {
        process.kill(existingPid, "SIGTERM");
        // Wait up to 3s for graceful shutdown (lets watchers/children clean up)
        const start = Date.now();
        while (Date.now() - start < 3000) {
          try {
            process.kill(existingPid, 0);
            Bun.sleepSync(50);
          } catch {
            break; // Process is gone
          }
        }
        // Force kill process group if still alive (catches orphaned children)
        try {
          process.kill(-existingPid, "SIGKILL");
        } catch {
          try {
            process.kill(existingPid, "SIGKILL");
          } catch {
            /* already gone */
          }
        }
      }
    } catch {
      // Process doesn't exist, stale PID file
    }
    // Remove stale PID file so we can atomically claim it
    try {
      unlinkSync(pidPath);
    } catch {
      /* may already be removed */
    }
  }

  // Clean up stale socket
  if (existsSync(socketPath)) {
    unlinkSync(socketPath);
  }

  // Atomically claim the PID file (O_EXCL fails if another process created it first)
  try {
    const fd = openSync(
      pidPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    writeSync(fd, process.pid.toString());
    closeSync(fd);
  } catch {
    log.error("Another daemon is already starting. Exiting.");
    process.exit(1);
  }

  // Initialize database
  const db = getDb();

  // Initialize session materializer
  materializer = new SessionMaterializer(db);

  // Backfill sessions table from events if needed (first start after upgrade)
  if (materializer.needsBackfill()) {
    log.info("Backfilling sessions table from events...");
    materializer.backfillFromEvents(computeSessions);
    log.info("Backfill complete.");
  }

  // Start flush interval
  const flushTimer = setInterval(flushEvents, FLUSH_INTERVAL_MS);

  // Start periodic session merge (every 30s)
  const mergeTimer = setInterval(() => {
    try {
      materializer?.mergeAdjacentSessions();
    } catch (err) {
      socketLog.error(`Failed to merge sessions: ${err}`);
    }
  }, 30_000);

  // Prune old events periodically (every hour, 30+ day old events)
  const pruneTimer = setInterval(() => {
    try {
      const pruned = materializer?.pruneOldEvents(30);
      if (pruned && pruned > 0) {
        log.info(`Pruned ${pruned} old events.`);
      }
    } catch (err) {
      socketLog.error(`Failed to prune events: ${err}`);
    }
  }, 3_600_000);

  // Start file watchers for registered projects
  const registry = getProjectRegistry();
  const watchers = createWatchersFromRegistry(registry, {
    onHeartbeat(event) {
      eventBuffer.push(event);
      if (eventBuffer.length >= FLUSH_BATCH_SIZE) {
        flushEvents();
      }
    },
    onLog(level, prefix, message) {
      createLogger(prefix)[level](message);
    },
  });

  // Start plugins for registered projects
  pluginManager = startPluginsFromRegistry(registry, {
    onEvent(event) {
      eventBuffer.push(event);
      if (eventBuffer.length >= FLUSH_BATCH_SIZE) {
        flushEvents();
      }
    },
  });

  // Start Unix socket server (restrict to owner-only via umask)
  const prevUmask = umask(0o177);
  const server = Bun.listen({
    unix: socketPath,
    socket: {
      data(_socket, data) {
        const lines = data.toString().split("\n").filter(Boolean);
        for (const line of lines) {
          const response = handleMessage(line);
          if (response) {
            _socket.write(response + "\n");
          }
        }
      },
      open(_socket) {
        // Connection opened
      },
      close(_socket) {
        // Connection closed
      },
      error(_socket, err) {
        socketLog.error(`Socket error: ${err}`);
      },
    },
  });
  umask(prevUmask);

  running = true;
  log.info(`Daemon started (pid: ${process.pid})`);
  log.info(`Listening on ${socketPath}`);

  // Graceful shutdown
  const shutdown = () => {
    if (!running) return;
    running = false;
    log.info("Shutting down...");

    clearInterval(flushTimer);
    clearInterval(mergeTimer);
    clearInterval(pruneTimer);
    // Final merge before shutdown
    try {
      materializer?.mergeAdjacentSessions();
    } catch {
      /* best effort */
    }
    for (const w of watchers) w.stop();
    pluginManager?.stop();
    flushEvents(); // Final flush
    server.stop();
    closeDb();

    if (existsSync(socketPath)) unlinkSync(socketPath);
    if (existsSync(pidPath)) unlinkSync(pidPath);

    log.info("Daemon stopped.");
    closeLogger();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

export function isDaemonRunning(): boolean {
  const pidPath = getDaemonPidPath();
  if (!existsSync(pidPath)) return false;

  try {
    const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
    // Check if process is alive
    process.kill(pid, 0);
    return true;
  } catch {
    // Stale PID file - clean up
    if (existsSync(pidPath)) unlinkSync(pidPath);
    return false;
  }
}

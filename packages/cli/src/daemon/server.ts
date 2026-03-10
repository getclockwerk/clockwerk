import {
  unlinkSync,
  existsSync,
  readFileSync,
  openSync,
  writeSync,
  closeSync,
  chmodSync,
  constants,
} from "node:fs";
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
  createWatchersFromRegistry,
  type ClockwerkEvent,
  type DaemonMessage,
  type DaemonResponse,
} from "@clockwerk/core";
import { mkdirSync } from "node:fs";
import { startSync, stopSync, resetWatermarks } from "./sync";
import { startPluginsFromRegistry, type PluginManager } from "./plugins";
import { initLogger, closeLogger, createLogger } from "./logger";

const log = createLogger("clockwerk");
const socketLog = createLogger("daemon");

const FLUSH_INTERVAL_MS = 1_000;
const FLUSH_BATCH_SIZE = 100;

let eventBuffer: ClockwerkEvent[] = [];
let running = false;
let pluginManager: PluginManager | null = null;

function flushEvents(): void {
  if (eventBuffer.length === 0) return;

  const batch = eventBuffer;
  eventBuffer = [];

  try {
    const db = getDb();
    insertEvents(db, batch);
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

      switch (period) {
        case "today": {
          const d = new Date();
          d.setHours(0, 0, 0, 0);
          since = Math.floor(d.getTime() / 1000);
          break;
        }
        case "week": {
          const d = new Date();
          d.setDate(d.getDate() - d.getDay() + 1); // Monday
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
        default:
          since = now - 86400;
      }

      const projectToken = params?.project_token as string | undefined;
      if (!projectToken) {
        // Return sessions for all projects
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

    case "reset-watermarks": {
      resetWatermarks(db);
      return { ok: true };
    }

    default:
      return { error: `Unknown method: ${method}` };
  }
}

function handleMessage(raw: string): string | null {
  let msg: DaemonMessage;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }

  if (msg.type === "event") {
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

  // Start flush interval
  const flushTimer = setInterval(flushEvents, FLUSH_INTERVAL_MS);

  // Start cloud sync
  startSync(db);

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

  // Start Unix socket server (restrict to owner-only after creation)
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

  // Restrict socket to owner-only access
  chmodSync(socketPath, 0o600);

  running = true;
  log.info(`Daemon started (pid: ${process.pid})`);
  log.info(`Listening on ${socketPath}`);

  // Graceful shutdown
  const shutdown = () => {
    if (!running) return;
    running = false;
    log.info("Shutting down...");

    clearInterval(flushTimer);
    for (const w of watchers) w.stop();
    pluginManager?.stop();
    stopSync();
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
    // Stale PID file — clean up
    if (existsSync(pidPath)) unlinkSync(pidPath);
    return false;
  }
}

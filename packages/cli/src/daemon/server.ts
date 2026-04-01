import {
  unlinkSync,
  existsSync,
  readFileSync,
  openSync,
  writeSync,
  closeSync,
  constants,
} from "node:fs";
import * as nodefs from "node:fs";
import { join } from "node:path";
import { umask } from "node:process";
import { spawn } from "node:child_process";
import {
  getDb,
  closeDb,
  getDaemonSocketPath,
  getDaemonPidPath,
  getClockwerkDir,
  getProjectRegistry,
  querySessions,
  createWatchersFromRegistry,
  type Period,
  type ClockwerkEvent,
  type DaemonMessage,
  type DaemonResponse,
} from "@clockwerk/core";
import { mkdirSync } from "node:fs";
import { startPluginsFromRegistry, type PluginSupervisor } from "./plugins";
import { initLogger, closeLogger, createLogger } from "./logger";
import { PluginManager } from "../plugin-manager";
import { createEventPipeline, type EventPipeline } from "./event-pipeline";
import { createUpgradeDetector } from "./upgrade-detector";

const log = createLogger("clockwerk");
const socketLog = createLogger("daemon");

const PLUGIN_CHECK_INTERVAL_MS = 86_400_000; // 24 hours

let running = false;
let pluginManager: PluginSupervisor | null = null;
let pipeline: EventPipeline | null = null;

function handleQuery(method: string, params?: Record<string, unknown>): unknown {
  const db = getDb();

  switch (method) {
    case "status": {
      return {
        running: true,
        pid: process.pid,
        buffered_events: pipeline?.bufferedCount ?? 0,
        plugins: pluginManager?.getStats() ?? [],
      };
    }

    case "sessions": {
      const result = querySessions(pipeline?.materializer ?? db, {
        period: (params?.period as Period) ?? "today",
        projectToken: params?.project_token as string | undefined,
      });
      return { sessions: result.sessions, total_seconds: result.total_seconds };
    }

    case "update_session": {
      return { ok: true };
    }

    case "delete_session": {
      const sessionId = params?.session_id as string | undefined;
      if (!sessionId) return { error: "session_id is required" };

      if (!pipeline) return { error: "Materializer not initialized" };

      const deleted = pipeline.materializer.deleteSession(sessionId);
      if (!deleted) return { error: `Session not found: ${sessionId}` };

      return { ok: true };
    }

    case "restore_session": {
      const sessionId = params?.session_id as string | undefined;
      if (!sessionId) return { error: "session_id is required" };

      if (!pipeline) return { error: "Materializer not initialized" };

      const restored = pipeline.materializer.restoreSession(sessionId);
      if (!restored) return { error: `Deleted session not found: ${sessionId}` };

      return { ok: true };
    }

    case "link_issue": {
      const projectToken = params?.project_token as string | undefined;
      const branch = params?.branch as string | undefined;
      const issueId = params?.issue_id as string | undefined;
      const issueTitle = (params?.issue_title as string | undefined) ?? null;

      if (!projectToken || !branch || !issueId) {
        return { error: "project_token, branch, and issue_id are required" };
      }

      db.run(
        `INSERT INTO branch_links (project_token, branch, issue_id, issue_title, linked_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(project_token, branch) DO UPDATE SET
           issue_id = excluded.issue_id,
           issue_title = excluded.issue_title,
           linked_at = excluded.linked_at`,
        [projectToken, branch, issueId, issueTitle, Math.floor(Date.now() / 1000)],
      );

      const result = db.run(
        `UPDATE sessions
         SET issue_id = ?, issue_title = ?, sync_version = sync_version + 1
         WHERE project_token = ? AND branch = ? AND issue_id IS NULL AND deleted_at IS NULL`,
        [issueId, issueTitle, projectToken, branch],
      );

      return { ok: true, updated_sessions: result.changes };
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
    pipeline?.ingest(msg.data);
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

  // Initialize event pipeline (materializer + timers)
  pipeline = createEventPipeline({
    db,
    onError(context, err) {
      if (context === "flush") {
        socketLog.error(`Failed to flush events: ${err}`);
      } else if (context === "merge") {
        socketLog.error(`Failed to merge sessions: ${err}`);
      } else if (context === "prune") {
        socketLog.error(`Failed to prune events: ${err}`);
      }
    },
  });

  const needsBackfill = pipeline.materializer.needsBackfill();
  if (needsBackfill) {
    log.info("Backfilling sessions table from events...");
  }
  pipeline.start();
  if (needsBackfill) {
    log.info("Backfill complete.");
  }

  // Start file watchers for registered projects
  const registry = getProjectRegistry();
  const watchers = createWatchersFromRegistry(registry, {
    onHeartbeat(event) {
      pipeline?.ingest(event);
    },
    onLog(level, prefix, message) {
      createLogger(prefix)[level](message);
    },
  });

  // Start plugins for registered projects
  const manager = new PluginManager({
    fs: nodefs,
    fetch: globalThis.fetch,
    pluginsDir: join(getClockwerkDir(), "plugins"),
  });
  pluginManager = startPluginsFromRegistry(
    registry,
    {
      onEvent(event) {
        pipeline?.ingest(event);
      },
    },
    manager,
  );

  // Plugin update check: run now and every 24 hours. Never auto-installs.
  function runPluginUpdateCheck(): void {
    manager
      .checkUpdates()
      .then((results) => {
        const updates = results
          .filter((r) => r.hasUpdate && r.latestVersion !== null)
          .map((r) => ({
            name: r.name,
            installedVersion: r.installedVersion,
            latestVersion: r.latestVersion as string,
          }));
        manager.saveUpdateCache({ checkedAt: Date.now(), updates });
        if (updates.length > 0) {
          log.info(`Plugin updates available: ${updates.map((u) => u.name).join(", ")}`);
        }
      })
      .catch((err: unknown) => {
        log.warn(`Plugin update check failed: ${String(err)}`);
      });
  }
  runPluginUpdateCheck();
  const pluginCheckTimer = setInterval(runPluginUpdateCheck, PLUGIN_CHECK_INTERVAL_MS);

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
  const shutdown = (spawnUpgrade = false) => {
    if (!running) return;
    running = false;
    log.info("Shutting down...");

    upgradeDetector.stop();
    clearInterval(pluginCheckTimer);
    for (const w of watchers) w.stop();
    pluginManager?.stop();
    pipeline?.stop();
    pipeline = null;
    server.stop();
    closeDb();

    if (existsSync(socketPath)) unlinkSync(socketPath);
    if (existsSync(pidPath)) unlinkSync(pidPath);

    if (spawnUpgrade) {
      const child = spawn(process.execPath, ["up", "--foreground"], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      log.info("Daemon stopped for upgrade.");
    } else {
      log.info("Daemon stopped.");
    }

    closeLogger();
    process.exit(0);
  };

  const upgradeDetector = createUpgradeDetector({
    onUpgradeDetected() {
      log.info("Binary upgrade detected, restarting daemon...");
      shutdown(true);
    },
  });
  upgradeDetector.start();

  process.on("SIGINT", () => shutdown());
  process.on("SIGTERM", () => shutdown());
}

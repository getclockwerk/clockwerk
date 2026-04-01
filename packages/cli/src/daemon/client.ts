import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { spawn } from "node:child_process";
import {
  getDaemonSocketPath,
  getDaemonPidPath,
  sendEvent,
  queryDaemon,
  type ClockwerkEvent,
} from "@clockwerk/core";
import { DaemonNotRunningError } from "./errors";

export type WhenDown = "auto-start" | "require" | "skip";
export { DaemonNotRunningError };

export interface DaemonClient {
  /** Fire-and-forget event. Defaults whenDown to "auto-start" (optimized for hook). */
  send(event: ClockwerkEvent, opts?: { whenDown?: WhenDown }): Promise<boolean>;

  /** Query daemon. Defaults whenDown to "require" (optimized for export/log/studio). */
  query<T>(
    method: string,
    params?: Record<string, unknown>,
    opts?: { whenDown?: WhenDown },
  ): Promise<T | null>;

  /** Check daemon status without side effects. */
  isRunning(): boolean;

  /** Get daemon PID, or null. */
  pid(): number | null;

  /** Ensure daemon is running, spawning if necessary. Returns success. */
  ensureRunning(): Promise<boolean>;

  /** Graceful shutdown: SIGTERM -> poll -> SIGKILL. */
  stop(): Promise<void>;
}

interface DaemonDeps {
  existsSync: (path: string) => boolean;
  readFileSync: (path: string, enc: "utf-8") => string;
  unlinkSync: (path: string) => void;
  spawn: typeof spawn;
  getDaemonPidPath: () => string;
  getDaemonSocketPath: () => string;
  sendEvent: (msg: { type: "event"; data: ClockwerkEvent }) => Promise<boolean>;
  queryDaemon: (
    method: string,
    params?: Record<string, unknown>,
  ) => Promise<{ data: unknown }>;
}

export function createDaemonClient(deps: DaemonDeps): DaemonClient {
  function readPid(): number | null {
    const pidPath = deps.getDaemonPidPath();
    if (!deps.existsSync(pidPath)) return null;
    try {
      const raw = deps.readFileSync(pidPath, "utf-8").trim();
      const pid = parseInt(raw, 10);
      return isNaN(pid) ? null : pid;
    } catch {
      return null;
    }
  }

  function checkIsRunning(): boolean {
    const pid = readPid();
    if (pid === null) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      // Stale PID file - clean up
      const pidPath = deps.getDaemonPidPath();
      if (deps.existsSync(pidPath)) deps.unlinkSync(pidPath);
      return false;
    }
  }

  async function doEnsureRunning(): Promise<boolean> {
    if (checkIsRunning()) return true;

    const scriptPath = process.argv[1];
    const isFromSource = scriptPath?.match(/\.[tj]sx?$/);
    const daemonArgs = isFromSource
      ? [scriptPath, "up", "--foreground"]
      : ["up", "--foreground"];

    const child = deps.spawn(process.execPath, daemonArgs, {
      detached: true,
      stdio: "ignore",
    });
    child.unref();

    // Poll for socket to confirm daemon is ready (up to 3s)
    const socketPath = deps.getDaemonSocketPath();
    for (let i = 0; i < 30; i++) {
      await new Promise<void>((r) => setTimeout(r, 100));
      if (deps.existsSync(socketPath) && checkIsRunning()) {
        return true;
      }
    }
    return false;
  }

  return {
    isRunning: checkIsRunning,

    pid(): number | null {
      return readPid();
    },

    async ensureRunning(): Promise<boolean> {
      return doEnsureRunning();
    },

    async send(event: ClockwerkEvent, opts?: { whenDown?: WhenDown }): Promise<boolean> {
      const policy = opts?.whenDown ?? "auto-start";

      if (!checkIsRunning()) {
        if (policy === "require") throw new DaemonNotRunningError();
        if (policy === "skip") return false;
        // auto-start
        const started = await doEnsureRunning();
        if (!started) return false;
      }

      return deps.sendEvent({ type: "event", data: event });
    },

    async query<T>(
      method: string,
      params?: Record<string, unknown>,
      opts?: { whenDown?: WhenDown },
    ): Promise<T | null> {
      const policy = opts?.whenDown ?? "require";

      if (!checkIsRunning()) {
        if (policy === "require") throw new DaemonNotRunningError();
        if (policy === "skip") return null;
        // auto-start
        const started = await doEnsureRunning();
        if (!started) throw new DaemonNotRunningError();
      }

      const res = await deps.queryDaemon(method, params);
      return res.data as T;
    },

    async stop(): Promise<void> {
      const pid = readPid();
      if (pid === null) return;

      const pidPath = deps.getDaemonPidPath();
      const socketPath = deps.getDaemonSocketPath();

      try {
        process.kill(pid, "SIGTERM");

        for (let i = 0; i < 20; i++) {
          await new Promise<void>((r) => setTimeout(r, 100));
          if (!checkIsRunning()) return;
        }

        process.kill(pid, "SIGKILL");
      } catch {
        // Process already gone - clean up stale files
        if (deps.existsSync(pidPath)) deps.unlinkSync(pidPath);
        if (deps.existsSync(socketPath)) deps.unlinkSync(socketPath);
      }
    },
  };
}

export const daemon: DaemonClient = createDaemonClient({
  existsSync,
  readFileSync,
  unlinkSync,
  spawn,
  getDaemonPidPath,
  getDaemonSocketPath,
  sendEvent,
  queryDaemon,
});

import {
  openSync,
  writeSync,
  fstatSync,
  ftruncateSync,
  readSync,
  closeSync,
} from "node:fs";
import { getDaemonLogPath } from "@clockwerk/core";

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

const MAX_LOG_SIZE = 2 * 1024 * 1024; // 2 MB
const KEEP_SIZE = 1 * 1024 * 1024; // keep last 1 MB after rotation

let logFd: number | null = null;
let foreground = false;

/**
 * Initialize the daemon logger.
 * In foreground mode, also writes to stderr. Always writes to the log file.
 */
export function initLogger(opts: { foreground: boolean }): void {
  foreground = opts.foreground;
  const logPath = getDaemonLogPath();
  logFd = openSync(logPath, "a", 0o600);
}

export function closeLogger(): void {
  if (logFd !== null) {
    closeSync(logFd);
    logFd = null;
  }
}

function rotateIfNeeded(): void {
  if (logFd === null) return;

  try {
    const stat = fstatSync(logFd);
    if (stat.size <= MAX_LOG_SIZE) return;

    // Read last KEEP_SIZE bytes
    const readSize = Math.min(KEEP_SIZE, stat.size);
    const buf = Buffer.alloc(readSize);
    readSync(logFd, buf, 0, readSize, stat.size - readSize);

    // Find first newline to avoid partial line
    const firstNewline = buf.indexOf(0x0a);
    const keep = firstNewline >= 0 ? buf.subarray(firstNewline + 1) : buf;

    // Truncate and rewrite
    ftruncateSync(logFd, 0);
    writeSync(logFd, keep, 0, keep.length, 0);
  } catch {
    // Best-effort rotation
  }
}

function write(level: LogLevel, prefix: string, message: string): void {
  const ts = new Date().toISOString();
  const line = `${ts} ${level.padEnd(5)} [${prefix}] ${message}\n`;

  if (logFd !== null) {
    writeSync(logFd, line);
    rotateIfNeeded();
  }

  if (foreground) {
    process.stderr.write(line);
  }
}

export interface Logger {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export function createLogger(prefix: string): Logger {
  return {
    debug: (msg) => write("DEBUG", prefix, msg),
    info: (msg) => write("INFO", prefix, msg),
    warn: (msg) => write("WARN", prefix, msg),
    error: (msg) => write("ERROR", prefix, msg),
  };
}

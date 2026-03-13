import {
  existsSync,
  readFileSync,
  statSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import { getDaemonLogPath } from "@clockwerk/core";
import { error, pc } from "../ui";

function colorize(line: string): string {
  // Format: 2026-03-10T14:32:01.123Z INFO  [sync] Synced 3 sessions
  const match = line.match(/^(\S+)\s+(DEBUG|INFO|WARN|ERROR)\s+(\[\S+\])\s+(.*)/);
  if (!match) return line;

  const [, ts, level, prefix, msg] = match;
  const levelFn =
    level === "ERROR"
      ? pc.red
      : level === "WARN"
        ? pc.yellow
        : level === "DEBUG"
          ? pc.dim
          : (s: string) => s;

  return `${pc.dim(ts)} ${levelFn(level.padEnd(5))} ${pc.cyan(prefix)} ${msg}`;
}

function tailLines(content: string, n: number): string[] {
  const lines = content.split("\n").filter(Boolean);
  return lines.slice(-n);
}

function filterByLevel(lines: string[], level: string): string[] {
  const levels = ["DEBUG", "INFO", "WARN", "ERROR"];
  const minIndex = levels.indexOf(level.toUpperCase());
  if (minIndex === -1) return lines;

  return lines.filter((line) => {
    const match = line.match(/^\S+\s+(DEBUG|INFO|WARN|ERROR)\s/);
    if (!match) return true;
    return levels.indexOf(match[1]) >= minIndex;
  });
}

async function followLog(logPath: string, level: string | null): Promise<void> {
  const file = Bun.file(logPath);
  let offset = (await file.exists()) ? file.size : 0;

  // Print existing tail first
  if (offset > 0) {
    const content = readFileSync(logPath, "utf-8");
    let lines = tailLines(content, 20);
    if (level) lines = filterByLevel(lines, level);
    for (const line of lines) {
      process.stdout.write(colorize(line) + "\n");
    }
    offset = statSync(logPath).size;
  }

  // Poll for new content (200ms interval)
  const fd = openSync(logPath, "r");
  const buf = Buffer.alloc(8192);

  process.stdout.write(pc.dim(`--- following ${logPath} (ctrl-c to quit) ---`) + "\n");

  const poll = setInterval(() => {
    try {
      const stat = statSync(logPath);
      if (stat.size < offset) {
        // File was rotated/truncated
        offset = 0;
      }
      if (stat.size === offset) return;

      const bytesToRead = Math.min(stat.size - offset, buf.length);
      const bytesRead = readSync(fd, buf, 0, bytesToRead, offset);
      if (bytesRead === 0) return;

      offset += bytesRead;
      const chunk = buf.subarray(0, bytesRead).toString("utf-8");
      const lines = chunk.split("\n").filter(Boolean);

      for (const line of lines) {
        if (level) {
          const filtered = filterByLevel([line], level);
          if (filtered.length === 0) continue;
        }
        process.stdout.write(colorize(line) + "\n");
      }
    } catch {
      // File may have been removed
    }
  }, 200);

  // Handle graceful exit
  process.on("SIGINT", () => {
    clearInterval(poll);
    closeSync(fd);
    process.exit(0);
  });

  // Keep alive
  await new Promise(() => {});
}

export default async function logs(args: string[]): Promise<void> {
  const logPath = getDaemonLogPath();

  if (!existsSync(logPath)) {
    error("No log file found. Is the daemon running?");
    console.error(pc.dim(`Expected: ${logPath}`));
    process.exit(1);
  }

  // Parse flags
  const follow = args.includes("-f") || args.includes("--follow");
  let lines = 50;
  let level: string | null = null;

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "-n" || args[i] === "--lines") && args[i + 1]) {
      lines = parseInt(args[i + 1], 10) || 50;
      i++;
    }
    if ((args[i] === "--level" || args[i] === "-l") && args[i + 1]) {
      level = args[i + 1].toUpperCase();
      i++;
    }
  }

  if (follow) {
    await followLog(logPath, level);
    return;
  }

  // Static tail
  const content = readFileSync(logPath, "utf-8");
  let output = tailLines(content, lines);
  if (level) output = filterByLevel(output, level);

  for (const line of output) {
    process.stdout.write(colorize(line) + "\n");
  }
}

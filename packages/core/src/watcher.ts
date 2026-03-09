import { watch, type FSWatcher } from "node:fs";
import { readFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { platform } from "node:os";
import { Subprocess } from "bun";
import type { ClockwerkEvent, ProjectConfig, WatchConfig } from "./types";

const DEFAULT_INTERVAL = 30;

const TEMP_PATTERNS = [".tmp.", ".temp."];

/** Check if a file path looks like a temp/transient file. */
function isTempPath(filePath: string): boolean {
  const basename = filePath.split("/").pop() ?? filePath;
  if (basename.endsWith(".tmp") || basename.endsWith(".temp")) return true;
  for (const p of TEMP_PATTERNS) {
    if (basename.includes(p)) return true;
  }
  if (/\.\d+\.tmp$/.test(basename)) return true;
  return false;
}

const BUILTIN_EXCLUDE = [
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".output",
  "__pycache__",
  ".cache",
  ".turbo",
  "coverage",
  "target",
  ".DS_Store",
];

const BUILTIN_EXCLUDE_EXTENSIONS = [
  ".pyc",
  ".pyo",
  ".lock",
  ".log",
  ".tmp",
  ".swp",
  ".swo",
  ".sqlite",
  ".sqlite-wal",
  ".sqlite-shm",
];

interface WatcherCallbacks {
  onHeartbeat: (event: ClockwerkEvent) => void;
}

export class FileWatcher {
  private fsWatcher: FSWatcher | null = null;
  private inotifyProc: Subprocess | null = null;
  private touchedFiles = new Set<string>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private gitignorePatterns: string[] = [];
  private extraExclude: string[];
  private interval: number;
  private stopped = false;

  constructor(
    private projectDir: string,
    private projectToken: string,
    private watchConfig: WatchConfig,
    private callbacks: WatcherCallbacks,
  ) {
    this.interval = watchConfig.interval || DEFAULT_INTERVAL;
    this.extraExclude = watchConfig.exclude || [];
    this.loadGitignore();
  }

  start(): void {
    if (platform() === "darwin") {
      this.startFsWatch();
    } else {
      this.startInotify();
    }

    this.heartbeatTimer = setInterval(() => this.emitHeartbeat(), this.interval * 1000);
  }

  stop(): void {
    this.stopped = true;
    if (this.fsWatcher) {
      this.fsWatcher.close();
      this.fsWatcher = null;
    }
    if (this.inotifyProc) {
      this.inotifyProc.kill();
      this.inotifyProc = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.touchedFiles.clear();
  }

  private startFsWatch(): void {
    try {
      this.fsWatcher = watch(
        this.projectDir,
        { recursive: true },
        (_eventType, filename) => {
          if (!filename) return;
          if (this.shouldIgnore(filename)) return;
          this.touchedFiles.add(filename);
        },
      );
    } catch (err) {
      console.error(
        `[watcher] Failed to watch ${this.projectDir}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  private startInotify(): void {
    // Build exclude regex for inotifywait from built-in + gitignore patterns
    const excludeDirs = [
      ...BUILTIN_EXCLUDE,
      ...this.gitignorePatterns.filter((p) => !p.includes("*")),
    ];
    const excludeRegex = excludeDirs.map((d) => `(^|/)${d}(/|$)`).join("|");

    const args = [
      "inotifywait",
      "-m",
      "-r",
      "-e",
      "close_write,create,moved_to",
      "--format",
      "%w%f",
    ];

    if (excludeRegex) {
      args.push("--exclude", excludeRegex);
    }

    args.push(this.projectDir);

    try {
      this.inotifyProc = Bun.spawn(args, {
        stdout: "pipe",
        stderr: "ignore",
      });

      this.readInotifyOutput();
    } catch (err) {
      console.error(
        `[watcher] Failed to start inotifywait for ${this.projectDir}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  private async readInotifyOutput(): Promise<void> {
    const stdout = this.inotifyProc?.stdout;
    if (!stdout || typeof stdout === "number") return;

    const reader = stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (!this.stopped) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const absPath = line.trim();
          if (!absPath) continue;

          const relPath = relative(this.projectDir, absPath);
          if (this.shouldIgnore(relPath)) continue;
          this.touchedFiles.add(relPath);
        }
      }
    } catch {
      // Process was killed or stream ended
    }
  }

  private emitHeartbeat(): void {
    if (this.touchedFiles.size === 0) return;

    const files = [...this.touchedFiles].filter((f) => !isTempPath(f));
    this.touchedFiles.clear();

    if (files.length === 0) return;

    // Derive topic from most common top-level directory
    const areaCounts = new Map<string, number>();
    for (const f of files) {
      const parts = f.split("/");
      const area = parts.slice(0, Math.min(2, parts.length)).join("/");
      areaCounts.set(area, (areaCounts.get(area) ?? 0) + 1);
    }
    let topic: string | undefined;
    let maxCount = 0;
    for (const [area, count] of areaCounts) {
      if (count > maxCount) {
        topic = area;
        maxCount = count;
      }
    }

    // Get current branch
    let branch: string | undefined;
    try {
      const result = Bun.spawnSync([
        "git",
        "-C",
        this.projectDir,
        "rev-parse",
        "--abbrev-ref",
        "HEAD",
      ]);
      branch = result.stdout.toString().trim() || undefined;
    } catch {
      // Not a git repo
    }

    // Extract issue ID from branch
    let issueId: string | undefined;
    if (branch) {
      const match = branch.match(/[A-Z]+-\d+/i);
      if (match) issueId = match[0].toUpperCase();
    }

    const event: ClockwerkEvent = {
      id: crypto.randomUUID(),
      timestamp: Math.floor(Date.now() / 1000),
      event_type: "heartbeat",
      source: "file-watch",
      project_token: this.projectToken,
      context: {
        file_path: files.slice(0, 20).join(", "),
        branch,
        issue_id: issueId,
        topic,
        description: `${files.length} file${files.length === 1 ? "" : "s"} changed`,
      },
    };

    this.callbacks.onHeartbeat(event);
  }

  private shouldIgnore(filename: string): boolean {
    const parts = filename.split("/");

    // Check built-in directory exclusions
    for (const part of parts) {
      if (BUILTIN_EXCLUDE.includes(part)) return true;
    }

    // Check built-in extension exclusions
    for (const ext of BUILTIN_EXCLUDE_EXTENSIONS) {
      if (filename.endsWith(ext)) return true;
    }

    // Ignore lock files and temp files (e.g. .lock-XXXXX.tmp, .~lock.file#)
    const basename = parts[parts.length - 1];
    if (
      basename.startsWith(".lock") ||
      basename.startsWith(".~lock") ||
      basename.startsWith("~") ||
      basename.includes(".tmp.") ||
      basename.includes(".temp.") ||
      /\.\d+\.tmp$/.test(basename)
    ) {
      return true;
    }

    // Check extra exclusions from config (simple glob matching)
    for (const pattern of this.extraExclude) {
      if (matchSimpleGlob(filename, pattern)) return true;
    }

    // Check .gitignore patterns
    for (const pattern of this.gitignorePatterns) {
      if (matchSimpleGlob(filename, pattern)) return true;
    }

    return false;
  }

  private loadGitignore(): void {
    const gitignorePath = join(this.projectDir, ".gitignore");
    if (!existsSync(gitignorePath)) return;

    try {
      const content = readFileSync(gitignorePath, "utf-8");
      this.gitignorePatterns = content
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"))
        .map((line) => (line.endsWith("/") ? line.slice(0, -1) : line));
    } catch {
      // Ignore read errors
    }
  }
}

/**
 * Simple glob matching for ignore patterns.
 * Supports: * (any chars), leading / (root only), directory names.
 */
function matchSimpleGlob(filepath: string, pattern: string): boolean {
  // Directory name match (e.g., "dist" matches "src/dist/file.ts")
  if (!pattern.includes("/") && !pattern.includes("*")) {
    return filepath.split("/").includes(pattern);
  }

  // Extension match (e.g., "*.generated.ts")
  if (pattern.startsWith("*.")) {
    return filepath.endsWith(pattern.slice(1));
  }

  // Path prefix match (e.g., "data/")
  if (!pattern.includes("*")) {
    return filepath.startsWith(pattern) || filepath.includes("/" + pattern);
  }

  return false;
}

/**
 * Create watchers for all registered projects that have watch enabled.
 */
export function createWatchersFromRegistry(
  registry: Array<{ project_token: string; directory: string }>,
  callbacks: WatcherCallbacks,
): FileWatcher[] {
  const watchers: FileWatcher[] = [];

  for (const entry of registry) {
    const configPath = join(entry.directory, ".clockwerk");
    if (!existsSync(configPath)) continue;

    let config: ProjectConfig;
    try {
      config = JSON.parse(readFileSync(configPath, "utf-8"));
    } catch {
      continue;
    }

    // Default: watch is enabled unless explicitly disabled
    const watchConfig: WatchConfig = config.watch ?? {
      enabled: true,
      interval: DEFAULT_INTERVAL,
      exclude: [],
    };

    if (!watchConfig.enabled) continue;
    if (!existsSync(entry.directory)) continue;

    const watcher = new FileWatcher(
      entry.directory,
      entry.project_token,
      watchConfig,
      callbacks,
    );
    watcher.start();
    watchers.push(watcher);

    console.log(
      `[watcher] Watching ${entry.directory} (every ${watchConfig.interval || DEFAULT_INTERVAL}s)`,
    );
  }

  return watchers;
}

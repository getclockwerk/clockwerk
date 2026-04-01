import { resolve, join, isAbsolute } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { ProjectConfig, ProjectRegistryEntry } from "./types";

const PROJECT_CONFIG_FILE = ".clockwerk";

export function getClockwerkDir(): string {
  return resolve(process.env.HOME ?? "~", ".clockwerk");
}

export function getDaemonSocketPath(): string {
  return resolve(getClockwerkDir(), "daemon.sock");
}

export function getDaemonPidPath(): string {
  return resolve(getClockwerkDir(), "daemon.pid");
}

export function getDaemonLogPath(): string {
  return resolve(getClockwerkDir(), "daemon.log");
}

export function getDeviceId(): string {
  const clockwerkDir = getClockwerkDir();
  const deviceIdPath = resolve(clockwerkDir, "device-id");
  if (existsSync(deviceIdPath)) {
    return readFileSync(deviceIdPath, "utf-8").trim();
  }
  if (!existsSync(clockwerkDir)) {
    mkdirSync(clockwerkDir, { recursive: true, mode: 0o700 });
  }
  const id = randomUUID();
  writeFileSync(deviceIdPath, id + "\n", { mode: 0o600 });
  return id;
}

/**
 * Walk up from `startDir` to find the nearest .clockwerk config file.
 */
export function findProjectConfig(startDir: string): ProjectConfig | null {
  let dir = resolve(startDir);
  const root = resolve("/");

  while (dir !== root) {
    const configPath = join(dir, PROJECT_CONFIG_FILE);
    if (existsSync(configPath)) {
      try {
        return JSON.parse(readFileSync(configPath, "utf-8"));
      } catch {
        return null;
      }
    }
    dir = resolve(dir, "..");
  }

  return null;
}

export function findProjectConfigPath(startDir: string): string | null {
  let dir = resolve(startDir);
  const root = resolve("/");

  while (dir !== root) {
    const configPath = join(dir, PROJECT_CONFIG_FILE);
    if (existsSync(configPath)) return configPath;
    dir = resolve(dir, "..");
  }

  return null;
}

export function findProjectRoot(startDir: string): string | null {
  const configPath = findProjectConfigPath(startDir);
  if (!configPath) return null;
  return resolve(configPath, "..");
}

export function saveProjectConfig(dir: string, config: ProjectConfig): void {
  const configPath = join(dir, PROJECT_CONFIG_FILE);
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
}

export function getProjectRegistry(): ProjectRegistryEntry[] {
  const registryPath = resolve(getClockwerkDir(), "projects.json");
  if (!existsSync(registryPath)) return [];
  try {
    const entries: ProjectRegistryEntry[] = JSON.parse(
      readFileSync(registryPath, "utf-8"),
    );
    return entries.filter((e) => existsSync(e.directory));
  } catch {
    return [];
  }
}

export function registerProject(entry: ProjectRegistryEntry): void {
  if (!entry.project_token || typeof entry.project_token !== "string") {
    throw new Error("Invalid project_token");
  }
  if (!entry.directory || !isAbsolute(entry.directory)) {
    throw new Error("directory must be an absolute path");
  }
  const clockwerkDir = getClockwerkDir();
  const registryPath = resolve(clockwerkDir, "projects.json");
  if (!existsSync(clockwerkDir)) {
    mkdirSync(clockwerkDir, { recursive: true, mode: 0o700 });
  }
  const registry = getProjectRegistry().filter((e) => e.directory !== entry.directory);
  registry.push(entry);
  writeFileSync(registryPath, JSON.stringify(registry, null, 2) + "\n");
}

/**
 * Given an absolute file path, find the registry entry whose directory is the
 * longest prefix match. Uses a path-boundary check so `/dev/time` won't match
 * `/dev/time-extra`. Pass a pre-loaded entries array to avoid a second file read.
 */
export function resolveFromEntries(
  absolutePath: string,
  entries: ProjectRegistryEntry[],
): ProjectRegistryEntry | null {
  let best: ProjectRegistryEntry | null = null;
  let bestLen = 0;

  for (const entry of entries) {
    const dir = entry.directory;
    if (
      absolutePath.startsWith(dir) &&
      (absolutePath.length === dir.length || absolutePath[dir.length] === "/") &&
      dir.length > bestLen
    ) {
      best = entry;
      bestLen = dir.length;
    }
  }

  return best;
}

/**
 * Given an absolute file path, find the project registry entry whose directory
 * is the longest prefix match. Reads the registry internally.
 */
export function resolveProjectFromPath(
  absolutePath: string,
): ProjectRegistryEntry | null {
  return resolveFromEntries(absolutePath, getProjectRegistry());
}

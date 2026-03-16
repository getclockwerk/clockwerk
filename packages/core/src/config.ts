import { resolve, join } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { ProjectConfig, ProjectRegistryEntry, UserConfig } from "./types";

const CLOCKWERK_DIR = resolve(process.env.HOME ?? "~", ".clockwerk");
const DEVICE_ID_PATH = resolve(CLOCKWERK_DIR, "device-id");
const USER_CONFIG_PATH = resolve(CLOCKWERK_DIR, "config.json");
const PROJECT_CONFIG_FILE = ".clockwerk";

export function getClockwerkDir(): string {
  return CLOCKWERK_DIR;
}

export function getDaemonSocketPath(): string {
  return resolve(CLOCKWERK_DIR, "daemon.sock");
}

export function getDaemonPidPath(): string {
  return resolve(CLOCKWERK_DIR, "daemon.pid");
}

export function getDaemonLogPath(): string {
  return resolve(CLOCKWERK_DIR, "daemon.log");
}

export function getDeviceId(): string {
  if (existsSync(DEVICE_ID_PATH)) {
    return readFileSync(DEVICE_ID_PATH, "utf-8").trim();
  }
  if (!existsSync(CLOCKWERK_DIR)) {
    mkdirSync(CLOCKWERK_DIR, { recursive: true, mode: 0o700 });
  }
  const id = randomUUID();
  writeFileSync(DEVICE_ID_PATH, id + "\n", { mode: 0o600 });
  return id;
}

export function getUserConfig(): UserConfig | null {
  if (!existsSync(USER_CONFIG_PATH)) return null;
  try {
    return JSON.parse(readFileSync(USER_CONFIG_PATH, "utf-8"));
  } catch {
    return null;
  }
}

export function saveUserConfig(config: UserConfig): void {
  if (!existsSync(CLOCKWERK_DIR)) {
    mkdirSync(CLOCKWERK_DIR, { recursive: true, mode: 0o700 });
  }
  writeFileSync(USER_CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", {
    mode: 0o600,
  });
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

const REGISTRY_PATH = resolve(CLOCKWERK_DIR, "projects.json");

export function getProjectRegistry(): ProjectRegistryEntry[] {
  if (!existsSync(REGISTRY_PATH)) return [];
  try {
    return JSON.parse(readFileSync(REGISTRY_PATH, "utf-8"));
  } catch {
    return [];
  }
}

export function registerProject(entry: ProjectRegistryEntry): void {
  if (!existsSync(CLOCKWERK_DIR)) {
    mkdirSync(CLOCKWERK_DIR, { recursive: true, mode: 0o700 });
  }
  const registry = getProjectRegistry().filter((e) => e.directory !== entry.directory);
  registry.push(entry);
  writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2) + "\n");
}

export function unregisterProject(directory: string): void {
  const registry = getProjectRegistry().filter((e) => e.directory !== directory);
  writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2) + "\n");
}

/**
 * Given an absolute file path, find the project registry entry whose directory
 * is the longest prefix match. Uses a path-boundary check so `/dev/time` won't
 * match `/dev/time-extra`.
 */
export function resolveProjectFromPath(
  absolutePath: string,
  registry?: ProjectRegistryEntry[],
): ProjectRegistryEntry | null {
  const entries = registry ?? getProjectRegistry();
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

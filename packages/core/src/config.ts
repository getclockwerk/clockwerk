import { resolve, join } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import type { ProjectConfig, ProjectRegistryEntry, UserConfig } from "./types";

const CLOCKWERK_DIR = resolve(process.env.HOME ?? "~", ".clockwerk");
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

// --- User config (from `clockwerk login`) ---

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

// --- Project config (from `clockwerk init`) ---

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

// --- Project registry (tracks all initialized project directories) ---

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

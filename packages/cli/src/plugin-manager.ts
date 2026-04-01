import { join } from "node:path";
import * as nodefs from "node:fs";
import {
  EVENT_TYPES,
  PluginManifestSchema,
  type PluginManifest,
  type PluginConfig,
  type ProjectConfig,
  type EventContext,
} from "@clockwerk/core";

export { EVENT_TYPES } from "@clockwerk/core";

const GITHUB_RAW_BASE =
  "https://raw.githubusercontent.com/getclockwerk/clockwerk/main/plugins";

export const PLUGIN_NAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/** Parse a stdout line into event context. JSON lines get field extraction, plain text becomes description. */
export function parseLine(line: string): EventContext {
  try {
    const parsed = JSON.parse(line);
    if (typeof parsed !== "object" || parsed === null) {
      return { description: line.slice(0, 200) };
    }
    const context: EventContext = {};
    if (typeof parsed.description === "string")
      context.description = parsed.description.slice(0, 200);
    if (typeof parsed.file_path === "string") context.file_path = parsed.file_path;
    if (typeof parsed.branch === "string") context.branch = parsed.branch;
    if (typeof parsed.issue_id === "string") context.issue_id = parsed.issue_id;
    if (typeof parsed.topic === "string") context.topic = parsed.topic;
    if (typeof parsed.tool_name === "string") context.tool_name = parsed.tool_name;
    // Default description to the raw line if not provided
    if (!context.description) context.description = line.slice(0, 200);
    return context;
  } catch {
    return { description: line.slice(0, 200) };
  }
}

export type PluginResult<T> = { ok: true; data: T } | { ok: false; error: string };

export interface InstallResult {
  name: string;
  version: string;
  displayName: string;
  description: string;
  scriptPath: string;
}

export interface RemoveResult {
  removedFromDisk: boolean;
  removedFromConfig: boolean;
}

export interface UpdateCheck {
  name: string;
  installedVersion: string;
  latestVersion: string | null;
  hasUpdate: boolean;
}

export interface InstalledPluginInfo {
  name: string;
  kind: "registry" | "inline";
  manifest?: PluginManifest;
  config: PluginConfig;
  active: boolean;
}

export interface PluginUpdateCacheEntry {
  name: string;
  installedVersion: string;
  latestVersion: string;
}

export interface PluginUpdateCache {
  checkedAt: number;
  updates: PluginUpdateCacheEntry[];
}

export interface PluginManagerDeps {
  fs: typeof nodefs;
  fetch: typeof globalThis.fetch;
  pluginsDir: string;
}

export class PluginManager {
  private fs: typeof nodefs;
  private fetch: typeof globalThis.fetch;
  readonly pluginsDir: string;

  constructor(deps: PluginManagerDeps) {
    this.fs = deps.fs;
    this.fetch = deps.fetch;
    this.pluginsDir = deps.pluginsDir;
  }

  private pluginDir(name: string): string {
    return join(this.pluginsDir, name);
  }

  private isInstalled(name: string): boolean {
    return this.fs.existsSync(join(this.pluginDir(name), "plugin.json"));
  }

  private readConfig(projectDir: string): ProjectConfig | null {
    const configPath = join(projectDir, ".clockwerk");
    if (!this.fs.existsSync(configPath)) return null;
    try {
      const raw = this.fs.readFileSync(configPath, "utf-8") as string;
      return JSON.parse(raw) as ProjectConfig;
    } catch {
      return null;
    }
  }

  private writeConfig(projectDir: string, config: ProjectConfig): void {
    this.fs.writeFileSync(
      join(projectDir, ".clockwerk"),
      JSON.stringify(config, null, 2) + "\n",
    );
  }

  private manifestToConfig(manifest: PluginManifest): PluginConfig {
    const config: PluginConfig = {
      name: manifest.name,
      command: manifest.command,
      event_type: manifest.event_type,
      source: manifest.source,
    };
    if (manifest.interval !== undefined) config.interval = manifest.interval;
    return config;
  }

  private async fetchFromRegistry(
    name: string,
  ): Promise<PluginResult<{ manifest: PluginManifest; script: string }>> {
    let manifestRes: Response;
    try {
      manifestRes = await this.fetch(`${GITHUB_RAW_BASE}/${name}/plugin.json`);
    } catch (e) {
      return {
        ok: false,
        error: `Network error fetching plugin "${name}": ${e instanceof Error ? e.message : String(e)}`,
      };
    }

    if (manifestRes.status === 404) {
      return {
        ok: false,
        error: `Plugin "${name}" not found in the Clockwerk registry.`,
      };
    }
    if (!manifestRes.ok) {
      return {
        ok: false,
        error: `Failed to fetch plugin manifest for "${name}" (HTTP ${manifestRes.status}).`,
      };
    }

    let raw: unknown;
    try {
      raw = await manifestRes.json();
    } catch {
      return {
        ok: false,
        error: `Malformed manifest for plugin "${name}": not valid JSON.`,
      };
    }

    const parseResult = PluginManifestSchema.safeParse(raw);
    if (!parseResult.success) {
      const issues = parseResult.error.issues.map((i) => i.message).join(", ");
      return { ok: false, error: `Malformed manifest for plugin "${name}": ${issues}` };
    }
    const manifest = parseResult.data;

    let scriptRes: Response;
    try {
      scriptRes = await this.fetch(`${GITHUB_RAW_BASE}/${name}/plugin.sh`);
    } catch (e) {
      return {
        ok: false,
        error: `Network error fetching plugin script for "${name}": ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    if (!scriptRes.ok) {
      return {
        ok: false,
        error: `Failed to fetch plugin script for "${name}" (HTTP ${scriptRes.status}).`,
      };
    }

    const script = await scriptRes.text();
    return { ok: true, data: { manifest, script } };
  }

  private writePluginFiles(
    name: string,
    manifest: PluginManifest,
    script: string,
  ): string {
    const dir = this.pluginDir(name);
    this.fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    this.fs.writeFileSync(
      join(dir, "plugin.json"),
      JSON.stringify(manifest, null, 2) + "\n",
    );
    const scriptPath = join(dir, "plugin.sh");
    this.fs.writeFileSync(scriptPath, script);
    this.fs.chmodSync(scriptPath, 0o755);
    return scriptPath;
  }

  async install(name: string, projectDir: string): Promise<PluginResult<InstallResult>> {
    if (name.length < 2 || name.length > 64 || !PLUGIN_NAME_RE.test(name)) {
      return {
        ok: false,
        error: `Invalid plugin name "${name}". Name must be 2-64 characters, lowercase alphanumeric with hyphens only.`,
      };
    }

    const config = this.readConfig(projectDir);
    if (!config) {
      return {
        ok: false,
        error: "No .clockwerk config found. Run 'clockwerk init' first.",
      };
    }

    const fetchResult = await this.fetchFromRegistry(name);
    if (!fetchResult.ok) return fetchResult;

    const { manifest, script } = fetchResult.data;
    const scriptPath = this.writePluginFiles(name, manifest, script);

    if (!config.plugins) config.plugins = [];
    const existingIdx = config.plugins.findIndex(
      (p) => (typeof p === "string" ? p : p.name) === name,
    );
    if (existingIdx >= 0) {
      config.plugins[existingIdx] = name;
    } else {
      config.plugins.push(name);
    }
    this.writeConfig(projectDir, config);

    return {
      ok: true,
      data: {
        name: manifest.name,
        version: manifest.version,
        displayName: manifest.display_name,
        description: manifest.description,
        scriptPath,
      },
    };
  }

  addInline(pluginConfig: PluginConfig, projectDir: string): PluginResult<undefined> {
    if (!(EVENT_TYPES as ReadonlyArray<string>).includes(pluginConfig.event_type)) {
      return { ok: false, error: `Invalid event type "${pluginConfig.event_type}".` };
    }

    const config = this.readConfig(projectDir);
    if (!config) {
      return {
        ok: false,
        error: "No .clockwerk config found. Run 'clockwerk init' first.",
      };
    }

    if (!config.plugins) config.plugins = [];
    const existing = config.plugins.find(
      (p) => (typeof p === "string" ? p : p.name) === pluginConfig.name,
    );
    if (existing) {
      return {
        ok: false,
        error: `Plugin "${pluginConfig.name}" already exists. Remove it first to reconfigure.`,
      };
    }

    config.plugins.push(pluginConfig);
    this.writeConfig(projectDir, config);

    return { ok: true, data: undefined };
  }

  remove(name: string, projectDir: string | null): PluginResult<RemoveResult> {
    let removedFromDisk = false;
    let removedFromConfig = false;

    const dir = this.pluginDir(name);
    if (this.fs.existsSync(dir)) {
      this.fs.rmSync(dir, { recursive: true, force: true });
      removedFromDisk = true;
    }

    if (projectDir) {
      const config = this.readConfig(projectDir);
      if (config?.plugins && config.plugins.length > 0) {
        const before = config.plugins.length;
        config.plugins = config.plugins.filter(
          (p) => (typeof p === "string" ? p : p.name) !== name,
        );
        if (config.plugins.length < before) {
          if (config.plugins.length === 0) delete config.plugins;
          this.writeConfig(projectDir, config);
          removedFromConfig = true;
        }
      }
    }

    if (!removedFromDisk && !removedFromConfig) {
      return { ok: false, error: `Plugin "${name}" not found.` };
    }

    return { ok: true, data: { removedFromDisk, removedFromConfig } };
  }

  async update(name: string): Promise<PluginResult<InstallResult>> {
    if (!this.isInstalled(name)) {
      return { ok: false, error: `Plugin "${name}" is not installed.` };
    }

    const fetchResult = await this.fetchFromRegistry(name);
    if (!fetchResult.ok) return fetchResult;

    const { manifest, script } = fetchResult.data;
    const scriptPath = this.writePluginFiles(name, manifest, script);

    return {
      ok: true,
      data: {
        name: manifest.name,
        version: manifest.version,
        displayName: manifest.display_name,
        description: manifest.description,
        scriptPath,
      },
    };
  }

  async checkUpdates(): Promise<UpdateCheck[]> {
    if (!this.fs.existsSync(this.pluginsDir)) return [];

    const results: UpdateCheck[] = [];
    for (const name of this.fs.readdirSync(this.pluginsDir) as string[]) {
      const manifestPath = join(this.pluginsDir, name, "plugin.json");
      if (!this.fs.existsSync(manifestPath)) continue;

      let installedVersion: string;
      try {
        const raw = JSON.parse(
          this.fs.readFileSync(manifestPath, "utf-8") as string,
        ) as unknown;
        const parseResult = PluginManifestSchema.safeParse(raw);
        if (!parseResult.success) continue;
        installedVersion = parseResult.data.version;
      } catch {
        continue;
      }

      try {
        const res = await this.fetch(`${GITHUB_RAW_BASE}/${name}/plugin.json`);
        if (!res.ok) {
          results.push({ name, installedVersion, latestVersion: null, hasUpdate: false });
          continue;
        }
        const raw = (await res.json()) as unknown;
        const parseResult = PluginManifestSchema.safeParse(raw);
        if (!parseResult.success) {
          results.push({ name, installedVersion, latestVersion: null, hasUpdate: false });
          continue;
        }
        const latestVersion = parseResult.data.version;
        results.push({
          name,
          installedVersion,
          latestVersion,
          hasUpdate: latestVersion !== installedVersion,
        });
      } catch {
        results.push({ name, installedVersion, latestVersion: null, hasUpdate: false });
      }
    }

    return results;
  }

  list(projectDir: string | null): InstalledPluginInfo[] {
    const activeNames = new Set<string>();
    let projectPlugins: (PluginConfig | string)[] = [];

    if (projectDir) {
      const config = this.readConfig(projectDir);
      projectPlugins = config?.plugins ?? [];
      for (const p of projectPlugins) {
        activeNames.add(typeof p === "string" ? p : p.name);
      }
    }

    const result: InstalledPluginInfo[] = [];
    const registryNames = new Set<string>();

    if (this.fs.existsSync(this.pluginsDir)) {
      for (const name of this.fs.readdirSync(this.pluginsDir) as string[]) {
        const manifestPath = join(this.pluginsDir, name, "plugin.json");
        if (!this.fs.existsSync(manifestPath)) continue;
        try {
          const raw = JSON.parse(
            this.fs.readFileSync(manifestPath, "utf-8") as string,
          ) as unknown;
          const parseResult = PluginManifestSchema.safeParse(raw);
          if (parseResult.success) {
            const manifest = parseResult.data;
            registryNames.add(name);
            result.push({
              name,
              kind: "registry",
              manifest,
              config: this.manifestToConfig(manifest),
              active: activeNames.has(name),
            });
          }
        } catch {
          // Skip malformed entries
        }
      }
    }

    for (const p of projectPlugins) {
      if (typeof p !== "string" && !registryNames.has(p.name)) {
        result.push({
          name: p.name,
          kind: "inline",
          config: p,
          active: true,
        });
      }
    }

    return result;
  }

  resolve(entry: string | PluginConfig): { config: PluginConfig; cwd: string } | null {
    if (typeof entry === "string") {
      const dir = this.pluginDir(entry);
      const manifestPath = join(dir, "plugin.json");
      if (!this.fs.existsSync(manifestPath)) return null;
      try {
        const raw = JSON.parse(
          this.fs.readFileSync(manifestPath, "utf-8") as string,
        ) as unknown;
        const parseResult = PluginManifestSchema.safeParse(raw);
        if (!parseResult.success) return null;
        return { config: this.manifestToConfig(parseResult.data), cwd: dir };
      } catch {
        return null;
      }
    }
    // Inline plugin - no dedicated install directory; caller provides cwd
    return { config: entry, cwd: "" };
  }

  loadUpdateCache(): PluginUpdateCache | null {
    const cachePath = join(this.pluginsDir, "..", "plugin-update-check.json");
    try {
      const raw = JSON.parse(
        this.fs.readFileSync(cachePath, "utf-8") as string,
      ) as unknown;
      if (
        raw !== null &&
        typeof raw === "object" &&
        "checkedAt" in raw &&
        "updates" in raw &&
        typeof (raw as Record<string, unknown>).checkedAt === "number" &&
        Array.isArray((raw as Record<string, unknown>).updates)
      ) {
        return raw as PluginUpdateCache;
      }
      return null;
    } catch {
      return null;
    }
  }

  saveUpdateCache(cache: PluginUpdateCache): void {
    const dir = join(this.pluginsDir, "..");
    this.fs.mkdirSync(dir, { recursive: true });
    const cachePath = join(this.pluginsDir, "..", "plugin-update-check.json");
    this.fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2) + "\n");
  }
}

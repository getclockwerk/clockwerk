import { readFileSync, existsSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { Subprocess } from "bun";
import type { ClockwerkEvent, PluginConfig, ProjectConfig } from "@clockwerk/core";
import { createLogger } from "./logger";
import { parseLine, type PluginManager } from "../plugin-manager";

interface PluginCallbacks {
  onEvent: (event: ClockwerkEvent) => void;
}

export interface PluginStats {
  name: string;
  source: string;
  running: boolean;
  eventCount: number;
  lastEventTs: number | null;
}

export class PluginProcess {
  private proc: Subprocess | null = null;
  private stopped = false;
  private lastEventTs = 0;
  private backoffMs = 1000;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private startedAt = 0;
  private _eventCount = 0;
  private _lastEventTime: number | null = null;
  private log;

  constructor(
    private config: PluginConfig,
    private projectToken: string,
    private projectDir: string,
    private callbacks: PluginCallbacks,
    private spawnDir?: string,
  ) {
    this.log = createLogger(`plugin:${config.name}`);
  }

  get name(): string {
    return this.config.name;
  }

  get directory(): string {
    return this.projectDir;
  }

  start(): void {
    this.spawn();
  }

  stop(): void {
    this.stopped = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
  }

  isRunning(): boolean {
    return this.proc !== null && !this.stopped;
  }

  getStats(): PluginStats {
    return {
      name: this.config.name,
      source: this.config.source,
      running: this.isRunning(),
      eventCount: this._eventCount,
      lastEventTs: this._lastEventTime,
    };
  }

  private spawn(): void {
    if (this.stopped) return;

    try {
      this.proc = Bun.spawn(["sh", "-c", this.config.command], {
        stdout: "pipe",
        stderr: "pipe",
        cwd: this.spawnDir ?? this.projectDir,
      });
      this.startedAt = Date.now();

      this.readStdout();
      this.readStderr();

      // Handle process exit
      this.proc.exited.then(() => {
        this.proc = null;
        this.scheduleRestart();
      });
    } catch (err) {
      this.log.error(`Failed to start: ${err instanceof Error ? err.message : err}`);
      this.proc = null;
      this.scheduleRestart();
    }
  }

  private async readStdout(): Promise<void> {
    const stdout = this.proc?.stdout;
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
          const trimmed = line.trim();
          if (!trimmed) continue;
          this.parseAndEmit(trimmed);
        }
      }
    } catch {
      // Process was killed or stream ended
    }
  }

  private async readStderr(): Promise<void> {
    const stderr = this.proc?.stderr;
    if (!stderr || typeof stderr === "number") return;

    const reader = stderr.getReader();
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
          const trimmed = line.trim();
          if (!trimmed) continue;
          this.log.warn(trimmed);
        }
      }
    } catch {
      // Process was killed or stream ended
    }
  }

  private parseAndEmit(line: string): void {
    const now = Math.floor(Date.now() / 1000);
    const interval = this.config.interval ?? 1;
    if (now - this.lastEventTs < interval) return;

    const context = parseLine(line);

    const event: ClockwerkEvent = {
      id: crypto.randomUUID(),
      timestamp: now,
      event_type: this.config.event_type,
      source: this.config.source,
      project_token: this.projectToken,
      context,
    };

    this.lastEventTs = now;
    this._eventCount++;
    this._lastEventTime = now;
    this.callbacks.onEvent(event);
  }

  private scheduleRestart(): void {
    if (this.stopped) return;

    const uptime = Date.now() - this.startedAt;
    if (uptime > 30_000) this.backoffMs = 1000; // reset on healthy run

    this.log.warn(`Exited. Restarting in ${this.backoffMs}ms...`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.spawn();
    }, this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, 60_000);
  }
}

export class PluginSupervisor {
  private plugins: PluginProcess[] = [];
  private configWatchers: FSWatcher[] = [];

  constructor(
    private registry: Array<{ project_token: string; directory: string }>,
    private callbacks: PluginCallbacks,
    private pluginManager: PluginManager,
  ) {}

  start(): void {
    this.loadPlugins();
    this.watchConfigs();
  }

  stop(): void {
    for (const w of this.configWatchers) w.close();
    this.configWatchers = [];
    for (const p of this.plugins) p.stop();
    this.plugins = [];
  }

  getStats(): PluginStats[] {
    return this.plugins.map((p) => p.getStats());
  }

  private loadPlugins(): void {
    for (const entry of this.registry) {
      const plugins = this.loadProjectPlugins(entry);
      this.plugins.push(...plugins);
    }
  }

  private loadProjectPlugins(entry: {
    project_token: string;
    directory: string;
  }): PluginProcess[] {
    const configPath = join(entry.directory, ".clockwerk");
    if (!existsSync(configPath)) return [];

    let config: ProjectConfig;
    try {
      config = JSON.parse(readFileSync(configPath, "utf-8"));
    } catch {
      return [];
    }

    if (!config.plugins || config.plugins.length === 0) return [];
    if (!existsSync(entry.directory)) return [];

    const log = createLogger("plugins");
    const plugins: PluginProcess[] = [];
    for (const pluginEntry of config.plugins) {
      let pluginConfig: PluginConfig;
      let spawnDir: string | undefined;

      if (typeof pluginEntry === "string") {
        const resolved = this.pluginManager.resolve(pluginEntry);
        if (!resolved) {
          log.error(
            `Plugin "${pluginEntry}" is not installed. Run 'clockwerk plugin add ${pluginEntry}' to install it.`,
          );
          continue;
        }
        pluginConfig = resolved.config;
        spawnDir = resolved.cwd || undefined;
      } else {
        pluginConfig = pluginEntry;
      }

      const plugin = new PluginProcess(
        pluginConfig,
        entry.project_token,
        entry.directory,
        this.callbacks,
        spawnDir,
      );
      plugin.start();
      plugins.push(plugin);
      createLogger(`plugin:${pluginConfig.name}`).info(`Started for ${entry.directory}`);
    }
    return plugins;
  }

  private watchConfigs(): void {
    for (const entry of this.registry) {
      const configPath = join(entry.directory, ".clockwerk");
      if (!existsSync(configPath)) continue;

      let debounce: ReturnType<typeof setTimeout> | null = null;

      try {
        const watcher = watch(configPath, () => {
          // Debounce - editors often write multiple times
          if (debounce) clearTimeout(debounce);
          debounce = setTimeout(() => {
            debounce = null;
            this.reloadProject(entry);
          }, 500);
        });
        this.configWatchers.push(watcher);
      } catch {
        // Config file may not be watchable, that's fine
      }
    }
  }

  private pluginsLog = createLogger("plugins");

  private reloadProject(entry: { project_token: string; directory: string }): void {
    this.pluginsLog.info(`Config changed for ${entry.directory}, reloading plugins...`);

    // Stop existing plugins for this project
    const existing = this.plugins.filter((p) => p.directory === entry.directory);
    for (const p of existing) p.stop();
    this.plugins = this.plugins.filter((p) => p.directory !== entry.directory);

    // Start new plugins from updated config
    const newPlugins = this.loadProjectPlugins(entry);
    this.plugins.push(...newPlugins);

    if (newPlugins.length === 0) {
      this.pluginsLog.info(`No plugins configured for ${entry.directory}`);
    }
  }
}

export function startPluginsFromRegistry(
  registry: Array<{ project_token: string; directory: string }>,
  callbacks: PluginCallbacks,
  pluginManager: PluginManager,
): PluginSupervisor {
  const supervisor = new PluginSupervisor(registry, callbacks, pluginManager);
  supervisor.start();
  return supervisor;
}

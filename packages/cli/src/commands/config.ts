import {
  findProjectConfig,
  findProjectConfigPath,
  saveProjectConfig,
  SESSION_GAP,
} from "@clockwerk/core";
import { resolve } from "node:path";
import { success, error, kv, heading, dim, pc } from "../ui";

export default async function config(args: string[]): Promise<void> {
  const cwd = process.cwd();
  const configPath = findProjectConfigPath(cwd);
  const projectConfig = findProjectConfig(cwd);

  if (!configPath || !projectConfig) {
    error("No .clockwerk config found. Run 'clockwerk init' first.");
    process.exit(1);
  }

  const projectDir = resolve(configPath, "..");
  const subcommand = args[0];

  if (!subcommand) {
    showConfig(projectConfig, configPath);
    return;
  }

  if (subcommand === "name") {
    const name = args.slice(1).join(" ").trim();
    if (!name) {
      error("Usage: clockwerk config name <project-name>");
      process.exit(1);
    }
    projectConfig.project_name = name;
    saveProjectConfig(projectDir, projectConfig);
    success(`Project name set to "${name}"`);
    return;
  }

  if (subcommand === "set") {
    setConfigValue(projectDir, projectConfig, args[1], args[2]);
    return;
  }

  error(`Unknown subcommand: ${subcommand}`);
  dim("Usage: clockwerk config [name <name> | set <key> <value>]");
  process.exit(1);
}

function showConfig(
  config: ReturnType<typeof findProjectConfig> & {},
  configPath: string,
): void {
  heading("Clockwerk project config");
  dim(configPath);
  console.log();

  if (config.project_name) {
    kv("Project", config.project_name);
  }

  const harnesses = Object.entries(config.harnesses).filter(([, v]) => v);
  if (harnesses.length > 0) {
    heading("Harnesses");
    for (const [id] of harnesses) {
      console.log(`    ${id}`);
    }
  }

  const sessionGap = config.session_gap ?? SESSION_GAP;
  kv("session_gap", `${sessionGap}s`);

  if (config.watch) {
    heading("File watcher");
    kv("enabled", config.watch.enabled ? pc.green("on") : pc.red("off"), 4);
    if (config.watch.interval) kv("interval", `${config.watch.interval}s`, 4);
  }

  if (config.plugins && config.plugins.length > 0) {
    heading("Plugins");
    for (const p of config.plugins) {
      if (typeof p === "string") {
        console.log(`    ${p} ${pc.dim("(registry)")}`);
      } else {
        console.log(`    ${p.name} ${pc.dim(`(${p.source})`)}`);
      }
    }
  }

  console.log();
}

const VALID_KEYS: Record<
  string,
  (config: ReturnType<typeof findProjectConfig> & {}, value: string) => void
> = {
  session_gap: (c, v) => {
    const n = parseInt(v, 10);
    if (isNaN(n) || n < 1) {
      error("session_gap must be a positive number (seconds).");
      process.exit(1);
    }
    c.session_gap = n;
  },
  "watch.enabled": (c, v) => {
    if (!c.watch) c.watch = { enabled: true, interval: 30, exclude: [] };
    c.watch.enabled = parseBool(v);
  },
  "watch.interval": (c, v) => {
    const n = parseInt(v, 10);
    if (isNaN(n) || n < 1) {
      error("Interval must be a positive number (seconds).");
      process.exit(1);
    }
    if (!c.watch) c.watch = { enabled: true, interval: 30, exclude: [] };
    c.watch.interval = n;
  },
};

function setConfigValue(
  projectDir: string,
  config: ReturnType<typeof findProjectConfig> & {},
  key: string | undefined,
  value: string | undefined,
): void {
  if (!key || value === undefined) {
    error("Usage: clockwerk config set <key> <value>");
    console.error();
    dim("Available keys:");
    for (const k of Object.keys(VALID_KEYS)) {
      console.error(`  ${k}`);
    }
    process.exit(1);
  }

  const setter = VALID_KEYS[key];
  if (!setter) {
    error(`Unknown config key: ${key}`);
    console.error();
    dim("Available keys:");
    for (const k of Object.keys(VALID_KEYS)) {
      console.error(`  ${k}`);
    }
    process.exit(1);
  }

  setter(config, value);
  saveProjectConfig(projectDir, config);
  success(`Set ${key} = ${value}`);
}

function parseBool(v: string): boolean {
  const lower = v.toLowerCase();
  if (["true", "on", "yes", "1"].includes(lower)) return true;
  if (["false", "off", "no", "0"].includes(lower)) return false;
  error(`Invalid boolean value: ${v} (use true/false, on/off, yes/no, 1/0)`);
  process.exit(1);
}

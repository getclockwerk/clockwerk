import {
  findProjectConfig,
  findProjectConfigPath,
  saveProjectConfig,
  isLocalToken,
} from "@clockwerk/core";
import { resolve } from "node:path";
import { confirm, close } from "../prompt";

export default async function config(args: string[]): Promise<void> {
  const cwd = process.cwd();
  const configPath = findProjectConfigPath(cwd);
  const projectConfig = findProjectConfig(cwd);

  if (!configPath || !projectConfig) {
    console.error("No .clockwerk config found. Run 'clockwerk init' first.");
    process.exit(1);
  }

  const projectDir = resolve(configPath, "..");
  const subcommand = args[0];

  if (!subcommand) {
    showConfig(projectConfig, configPath);
    return;
  }

  if (subcommand === "privacy") {
    await editPrivacy(projectDir, projectConfig);
    close();
    return;
  }

  if (subcommand === "name") {
    const name = args.slice(1).join(" ").trim();
    if (!name) {
      console.error("Usage: clockwerk config name <project-name>");
      process.exit(1);
    }
    projectConfig.project_name = name;
    saveProjectConfig(projectDir, projectConfig);
    console.log(`Project name set to "${name}".`);
    return;
  }

  if (subcommand === "set") {
    setConfigValue(projectDir, projectConfig, args[1], args[2]);
    return;
  }

  console.error(`Unknown subcommand: ${subcommand}`);
  console.error("Usage: clockwerk config [privacy | name <name> | set <key> <value>]");
  process.exit(1);
}

function showConfig(
  config: ReturnType<typeof findProjectConfig> & {},
  configPath: string,
): void {
  const isLocal = isLocalToken(config.project_token);

  console.log(`\n  Clockwerk project config (${configPath})\n`);
  if (config.project_name) {
    console.log(`  Project:     ${config.project_name}`);
  }
  console.log(`  Token:       ${config.project_token}${isLocal ? " (local)" : ""}`);
  if (config.api_url) {
    console.log(`  API:         ${config.api_url}`);
  }

  console.log(`\n  Privacy (cloud sync):`);
  console.log(`    sync_paths:        ${config.privacy.sync_paths ? "on" : "off"}`);
  console.log(`    sync_branches:     ${config.privacy.sync_branches ? "on" : "off"}`);
  console.log(
    `    sync_descriptions: ${config.privacy.sync_descriptions ? "on" : "off"}`,
  );

  const harnesses = Object.entries(config.harnesses).filter(([, v]) => v);
  if (harnesses.length > 0) {
    console.log(`\n  Harnesses:`);
    for (const [id] of harnesses) {
      console.log(`    ${id}`);
    }
  }

  if (config.watch) {
    console.log(`\n  File watcher: ${config.watch.enabled ? "on" : "off"}`);
    if (config.watch.interval) console.log(`    interval: ${config.watch.interval}s`);
  }

  if (config.plugins && config.plugins.length > 0) {
    console.log(`\n  Plugins:`);
    for (const p of config.plugins) {
      console.log(`    ${p.name} (${p.source})`);
    }
  }

  console.log("");
}

async function editPrivacy(
  projectDir: string,
  config: ReturnType<typeof findProjectConfig> & {},
): Promise<void> {
  console.log("\n  Privacy settings — what gets synced to the cloud?\n");

  config.privacy.sync_paths = await confirm(
    `    File paths         [currently ${config.privacy.sync_paths ? "on" : "off"}]`,
    config.privacy.sync_paths,
  );
  config.privacy.sync_branches = await confirm(
    `    Branch names       [currently ${config.privacy.sync_branches ? "on" : "off"}]`,
    config.privacy.sync_branches,
  );
  config.privacy.sync_descriptions = await confirm(
    `    Tool descriptions  [currently ${config.privacy.sync_descriptions ? "on" : "off"}]`,
    config.privacy.sync_descriptions,
  );

  saveProjectConfig(projectDir, config);
  console.log("\n  ✓ Privacy settings updated.\n");
}

const VALID_KEYS: Record<
  string,
  (config: ReturnType<typeof findProjectConfig> & {}, value: string) => void
> = {
  "privacy.sync_paths": (c, v) => {
    c.privacy.sync_paths = parseBool(v);
  },
  "privacy.sync_branches": (c, v) => {
    c.privacy.sync_branches = parseBool(v);
  },
  "privacy.sync_descriptions": (c, v) => {
    c.privacy.sync_descriptions = parseBool(v);
  },
  "watch.enabled": (c, v) => {
    if (!c.watch) c.watch = { enabled: true, interval: 30, exclude: [] };
    c.watch.enabled = parseBool(v);
  },
  "watch.interval": (c, v) => {
    const n = parseInt(v, 10);
    if (isNaN(n) || n < 1) {
      console.error("Interval must be a positive number (seconds).");
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
    console.error("Usage: clockwerk config set <key> <value>");
    console.error(`\nAvailable keys:`);
    for (const k of Object.keys(VALID_KEYS)) {
      console.error(`  ${k}`);
    }
    process.exit(1);
  }

  const setter = VALID_KEYS[key];
  if (!setter) {
    console.error(`Unknown config key: ${key}`);
    console.error(`\nAvailable keys:`);
    for (const k of Object.keys(VALID_KEYS)) {
      console.error(`  ${k}`);
    }
    process.exit(1);
  }

  setter(config, value);
  saveProjectConfig(projectDir, config);
  console.log(`Set ${key} = ${value}`);
}

function parseBool(v: string): boolean {
  const lower = v.toLowerCase();
  if (["true", "on", "yes", "1"].includes(lower)) return true;
  if (["false", "off", "no", "0"].includes(lower)) return false;
  console.error(`Invalid boolean value: ${v} (use true/false, on/off, yes/no, 1/0)`);
  process.exit(1);
}

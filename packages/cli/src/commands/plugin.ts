import { resolve, join } from "node:path";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  copyFileSync,
  readFileSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import * as fs from "node:fs";
import {
  findProjectConfig,
  findProjectConfigPath,
  isValidSource,
  getClockwerkDir,
  type PluginConfig,
  type EventType,
} from "@clockwerk/core";
import { parseLine, PluginManager, PLUGIN_NAME_RE, EVENT_TYPES } from "../plugin-manager";
import { success, error, info, dim, pc, spinner } from "../ui";

const manager = new PluginManager({
  fs,
  fetch: globalThis.fetch,
  pluginsDir: join(getClockwerkDir(), "plugins"),
});

const TEMPLATES: Record<string, Omit<PluginConfig, "name">> = {
  "docker-logs": {
    command:
      'docker events --filter "type=container" --format "{{.Action}} {{.Actor.Attributes.name}}"',
    event_type: "manual",
    source: "plugin:docker",
    interval: 5,
  },
  "figma-activity": {
    command: "./plugin.sh",
    event_type: "file_edit",
    source: "plugin:figma",
    interval: 30,
  },
  "git-activity": {
    command: "fswatch .git/refs --recursive",
    event_type: "git_commit",
    source: "plugin:git-activity",
    interval: 5,
  },
  "ci-status": {
    command:
      'while true; do gh run list --limit 1 --json status,name,conclusion --jq ".[] | .name + \\" \\" + (.conclusion // .status)"; sleep 60; done',
    event_type: "manual",
    source: "plugin:ci",
    interval: 60,
  },
};

function printUsage(): void {
  const templateNames = Object.keys(TEMPLATES).join(", ");
  console.log(`
clockwerk plugin - Manage custom event plugins

Usage:
  clockwerk plugin add <name>                    Install plugin from the Clockwerk registry
  clockwerk plugin add <name> --command <cmd>    Add inline plugin with custom command
  clockwerk plugin add <name> --template <name>  Add inline plugin from a starter template
  clockwerk plugin remove <name>
  clockwerk plugin list
  clockwerk plugin update
  clockwerk plugin test <name>
  clockwerk plugin create <name>                 Scaffold a new plugin for contribution

Options for 'add' (inline mode):
  --command <cmd>       Command to run (stdout lines become events)
  --template <name>     Use a starter template: ${templateNames}
  --event-type <type>   Event type (default: "manual")
                        Valid: ${EVENT_TYPES.join(", ")}
  --source <source>     Source identifier (default: "plugin:<name>")
  --interval <seconds>  Min seconds between events (default: 1)

Examples:
  clockwerk plugin add git-activity
  clockwerk plugin add deploy-tracker --command "tail -f /var/log/deploy.log"
  clockwerk plugin add figma --command "fswatch ~/designs" --event-type file_edit --interval 5
  clockwerk plugin add docker --template docker-logs
  clockwerk plugin test deploy-tracker
  clockwerk plugin remove deploy-tracker
  clockwerk plugin create my-plugin
`);
}

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--") && i + 1 < args.length) {
      flags[args[i].slice(2)] = args[i + 1];
      i++;
    }
  }
  return flags;
}

async function add(args: string[]): Promise<void> {
  const name = args[0];
  if (!name || name.startsWith("--")) {
    error("Plugin name is required.");
    dim("Usage: clockwerk plugin add <name>");
    process.exit(1);
  }

  const flags = parseFlags(args.slice(1));
  const isInlineMode = !!(flags["command"] || flags["template"]);

  if (isInlineMode) {
    await addInline(name, flags);
  } else {
    await addFromRegistry(name);
  }
}

async function addFromRegistry(name: string): Promise<void> {
  const cwd = process.cwd();
  const configPath = findProjectConfigPath(cwd);
  if (!configPath) {
    error("No .clockwerk config found. Run 'clockwerk init' first.");
    process.exit(1);
  }

  const projectDir = resolve(configPath, "..");
  const spin = spinner(`Fetching plugin "${name}" from registry...`);
  const result = await manager.install(name, projectDir);
  spin.stop();

  if (!result.ok) {
    error(result.error);
    process.exit(1);
  }

  success(`Plugin "${name}" v${result.data.version} installed.`);
  console.log(`  ${result.data.displayName} - ${result.data.description}`);
  console.log(`  installed to: ${result.data.scriptPath}`);
  dim("\nThe daemon will pick up this plugin automatically.");
}

async function addInline(name: string, flags: Record<string, string>): Promise<void> {
  let command = flags["command"];
  let eventType = flags["event-type"] as EventType | undefined;
  let source = flags["source"];
  let interval = flags["interval"] ? parseInt(flags["interval"], 10) : undefined;

  if (flags["template"]) {
    const template = TEMPLATES[flags["template"]];
    if (!template) {
      error(`Unknown template "${flags["template"]}".`);
      dim(`Available: ${Object.keys(TEMPLATES).join(", ")}`);
      process.exit(1);
    }
    command = command ?? template.command;
    eventType = eventType ?? template.event_type;
    source = source ?? template.source;
    interval = interval ?? template.interval;
  }

  if (!command) {
    error("--command or --template is required.");
    dim('Example: clockwerk plugin add my-plugin --command "tail -f log.txt"');
    process.exit(1);
  }

  eventType = eventType ?? "manual";

  source = source ?? `plugin:${name}`;

  if (!isValidSource(source)) {
    error(
      `Invalid source "${source}". Must be 2-64 chars, lowercase alphanumeric with hyphens/colons.`,
    );
    process.exit(1);
  }

  if (interval !== undefined && (isNaN(interval) || interval < 0)) {
    error("--interval must be a non-negative number.");
    process.exit(1);
  }

  const cwd = process.cwd();
  const configPath = findProjectConfigPath(cwd);
  if (!configPath) {
    error("No .clockwerk config found. Run 'clockwerk init' first.");
    process.exit(1);
  }

  const projectDir = resolve(configPath, "..");

  const pluginConfig: PluginConfig = {
    name,
    command,
    event_type: eventType,
    source,
  };
  if (interval !== undefined) pluginConfig.interval = interval;

  const result = manager.addInline(pluginConfig, projectDir);
  if (!result.ok) {
    error(result.error);
    process.exit(1);
  }

  success(`Plugin "${name}" added.`);
  console.log(`  command:    ${command}`);
  console.log(`  event_type: ${eventType}`);
  console.log(`  source:     ${source}`);
  if (interval !== undefined) console.log(`  interval:   ${interval}s`);
  dim("\nThe daemon will pick up this plugin automatically.");
}

async function remove(args: string[]): Promise<void> {
  const name = args[0];
  if (!name) {
    error("Plugin name is required.");
    dim("Usage: clockwerk plugin remove <name>");
    process.exit(1);
  }

  const cwd = process.cwd();
  const configPath = findProjectConfigPath(cwd);
  const projectDir = configPath ? resolve(configPath, "..") : null;

  const result = manager.remove(name, projectDir);
  if (!result.ok) {
    error(result.error);
    process.exit(1);
  }

  success(`Plugin "${name}" removed.`);
  if (result.data.removedFromConfig)
    dim("The daemon will pick up this change automatically.");
}

async function list(_args: string[]): Promise<void> {
  const cwd = process.cwd();
  const configPath = findProjectConfigPath(cwd);
  const projectDir = configPath ? resolve(configPath, "..") : null;

  const plugins = manager.list(projectDir);
  const registryPlugins = plugins.filter((p) => p.kind === "registry");
  const inlinePlugins = plugins.filter((p) => p.kind === "inline");

  if (plugins.length === 0) {
    info("No plugins installed or configured.");
    dim(`Install from registry: clockwerk plugin add <name>`);
    dim(`Add inline plugin:     clockwerk plugin add <name> --command <cmd>`);
    dim(`\nRegistry plugins are stored in: ${manager.pluginsDir}`);
    return;
  }

  if (registryPlugins.length > 0) {
    info(`Registry plugins (${registryPlugins.length}):\n`);
    for (const p of registryPlugins) {
      const statusBadge = p.active ? pc.green("[active]") : pc.dim("[not active]");
      console.log(`  ${p.name} ${pc.dim(`v${p.manifest!.version}`)} ${statusBadge}`);
      console.log(`    ${p.manifest!.description}`);
      console.log(
        `    event_type: ${p.manifest!.event_type}  source: ${p.manifest!.source}`,
      );
      if (p.manifest!.interval) console.log(`    interval:   ${p.manifest!.interval}s`);
      console.log();
    }
  }

  if (inlinePlugins.length > 0) {
    info(`Inline plugins (${inlinePlugins.length}):\n`);
    for (const p of inlinePlugins) {
      console.log(`  ${p.name}`);
      console.log(`    command:    ${p.config.command}`);
      console.log(`    event_type: ${p.config.event_type}`);
      console.log(`    source:     ${p.config.source}`);
      if (p.config.interval) console.log(`    interval:   ${p.config.interval}s`);
      console.log();
    }
  }
}

async function test(args: string[]): Promise<void> {
  const name = args[0];
  if (!name) {
    error("Plugin name is required.");
    dim("Usage: clockwerk plugin test <name>");
    process.exit(1);
  }

  const cwd = process.cwd();
  const config = findProjectConfig(cwd);
  if (!config) {
    error("No .clockwerk config found.");
    process.exit(1);
  }

  const pluginEntry = (config.plugins ?? []).find(
    (p) => (typeof p === "string" ? p : p.name) === name,
  );
  if (!pluginEntry) {
    error(`Plugin "${name}" not found.`);
    process.exit(1);
  }

  const configPath = findProjectConfigPath(cwd)!;
  const projectDir = resolve(configPath, "..");

  const resolved = manager.resolve(pluginEntry);
  if (!resolved) {
    error(
      `Plugin "${name}" is not installed. Run 'clockwerk plugin add ${name}' to install it.`,
    );
    process.exit(1);
  }

  const plugin = resolved.config;
  const spawnDir = resolved.cwd || projectDir;

  info(`Testing plugin "${name}"...`);
  console.log(`  command:    ${plugin.command}`);
  console.log(`  event_type: ${plugin.event_type}`);
  console.log(`  source:     ${plugin.source}`);
  console.log(`  interval:   ${plugin.interval ?? 1}s`);
  console.log(`\nListening for output (Ctrl+C to stop):\n`);

  const proc = Bun.spawn(["sh", "-c", plugin.command], {
    stdout: "pipe",
    stderr: "pipe",
    cwd: spawnDir,
  });

  let eventCount = 0;
  let lastEventTs = 0;
  const interval = plugin.interval ?? 1;

  // Read stderr in background
  (async () => {
    const stderr = proc.stderr;
    if (!stderr || typeof stderr === "number") return;
    const reader = stderr.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.trim()) console.error(`  ${pc.red("stderr:")} ${line.trim()}`);
        }
      }
    } catch {
      /* stream ended */
    }
  })();

  // Read stdout and show parsed events
  const stdout = proc.stdout;
  if (!stdout || typeof stdout === "number") {
    error("Could not read plugin stdout.");
    process.exit(1);
  }

  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const cleanup = () => {
    proc.kill();
    console.log(`\n\nTest complete. ${eventCount} event(s) would have been recorded.`);
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        const now = Math.floor(Date.now() / 1000);
        const throttled = now - lastEventTs < interval;

        const context = parseLine(trimmed);
        eventCount++;

        const time = new Date().toLocaleTimeString("en-GB", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        });

        if (throttled) {
          console.log(`  ${pc.yellow(`${time} [throttled]`)} ${trimmed}`);
        } else {
          lastEventTs = now;
          console.log(`  ${pc.green(`${time} [event]`)}`);
          console.log(`    type:        ${plugin.event_type}`);
          console.log(`    source:      ${plugin.source}`);
          if (context.description) console.log(`    description: ${context.description}`);
          if (context.file_path) console.log(`    file_path:   ${context.file_path}`);
          if (context.branch) console.log(`    branch:      ${context.branch}`);
          if (context.topic) console.log(`    topic:       ${context.topic}`);
        }
      }
    }
  } catch {
    // Stream ended
  }

  cleanup();
}

async function update(_args: string[]): Promise<void> {
  const { confirm } = await import("../prompt");

  const spin = spinner("Checking for plugin updates...");
  let checks: Awaited<ReturnType<typeof manager.checkUpdates>>;
  try {
    checks = await manager.checkUpdates();
    spin.stop();
  } catch (e) {
    spin.stop();
    error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }

  const available = checks.filter((c) => c.hasUpdate && c.latestVersion !== null);

  if (available.length === 0) {
    info("All plugins are up to date.");
    return;
  }

  info(`${available.length} plugin update(s) available:\n`);
  for (const c of available) {
    console.log(
      `  ${c.name}: ${pc.dim(c.installedVersion)} -> ${pc.bold(c.latestVersion!)}`,
    );
  }
  console.log();

  let anyUpdated = false;
  for (const c of available) {
    const yes = await confirm(
      `Update ${c.name} from v${c.installedVersion} to v${c.latestVersion!}?`,
      false,
    );
    if (!yes) {
      dim(`Skipping ${c.name}.`);
      continue;
    }

    const spin2 = spinner(`Updating "${c.name}"...`);
    const result = await manager.update(c.name);
    spin2.stop();

    if (!result.ok) {
      error(`Failed to update "${c.name}": ${result.error}`);
    } else {
      success(`Plugin "${c.name}" updated to v${result.data.version}.`);
      anyUpdated = true;
    }
  }

  if (anyUpdated) {
    dim(
      "\nRestart the daemon to load the updated plugin files: clockwerk down && clockwerk up",
    );
  }
}

async function create(args: string[]): Promise<void> {
  const name = args[0];
  if (!name || name.startsWith("--")) {
    error("Plugin name is required.");
    dim("Usage: clockwerk plugin create <name>");
    process.exit(1);
  }

  if (name.length < 2 || name.length > 64 || !PLUGIN_NAME_RE.test(name)) {
    error(`Invalid plugin name "${name}".`);
    dim("Name must be 2-64 characters, lowercase alphanumeric with hyphens only.");
    process.exit(1);
  }

  const cwd = process.cwd();
  const templateDir = resolve(cwd, "plugins", "_template");
  const destDir = resolve(cwd, "plugins", name);

  if (!existsSync(templateDir)) {
    error(`Template not found at plugins/_template/`);
    dim("Run this command from the clockwerk repository root.");
    process.exit(1);
  }

  if (existsSync(destDir)) {
    error(`Plugin directory "plugins/${name}" already exists.`);
    process.exit(1);
  }

  mkdirSync(destDir, { recursive: true });

  for (const file of readdirSync(templateDir)) {
    copyFileSync(resolve(templateDir, file), resolve(destDir, file));
  }

  const manifestPath = resolve(destDir, "plugin.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as Record<
    string,
    unknown
  >;
  manifest.name = name;
  manifest.source = `plugin:${name}`;
  manifest.display_name = name
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  chmodSync(resolve(destDir, "plugin.sh"), 0o755);

  success(`Plugin "${name}" scaffolded at plugins/${name}/`);
  console.log();
  console.log(`  Next steps:`);
  console.log(
    `  1. Edit plugins/${name}/plugin.json  - fill in description, author, event_type`,
  );
  console.log(`  2. Write your logic in plugins/${name}/plugin.sh`);
  console.log(`  3. Open a pull request to contribute it to the registry`);
}

const SUBCOMMANDS: Record<string, (args: string[]) => Promise<void>> = {
  add,
  remove,
  list,
  update,
  test,
  create,
};

export default async function plugin(args: string[]): Promise<void> {
  const sub = args[0];

  if (!sub || sub === "--help" || sub === "-h") {
    printUsage();
    return;
  }

  const handler = SUBCOMMANDS[sub];
  if (!handler) {
    error(`Unknown subcommand: ${sub}`);
    printUsage();
    process.exit(1);
  }

  await handler(args.slice(1));
}

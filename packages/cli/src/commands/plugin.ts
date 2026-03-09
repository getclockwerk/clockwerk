import { resolve } from "node:path";
import {
  findProjectConfig,
  findProjectConfigPath,
  saveProjectConfig,
  type PluginConfig,
  type EventType,
} from "@clockwerk/core";
import { parseLine } from "../daemon/plugins";

const VALID_EVENT_TYPES: EventType[] = [
  "tool_call",
  "file_edit",
  "file_read",
  "chat_message",
  "completion_accept",
  "git_commit",
  "manual",
  "heartbeat",
];

const TEMPLATES: Record<string, Omit<PluginConfig, "name">> = {
  "docker-logs": {
    command:
      'docker events --filter "type=container" --format "{{.Action}} {{.Actor.Attributes.name}}"',
    event_type: "manual",
    source: "plugin:docker",
    interval: 5,
  },
  "npm-scripts": {
    command: 'inotifywait -m -e close_write package.json --format "%w%f"',
    event_type: "file_edit",
    source: "plugin:npm",
    interval: 10,
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
clockwerk plugin — Manage custom event plugins

Usage:
  clockwerk plugin add <name> --command <cmd> [options]
  clockwerk plugin add <name> --template <template>
  clockwerk plugin remove <name>
  clockwerk plugin list
  clockwerk plugin test <name>

Options for 'add':
  --command <cmd>       Command to run (stdout lines become events) [required unless --template]
  --template <name>     Use a starter template: ${templateNames}
  --event-type <type>   Event type (default: "manual")
                        Valid: ${VALID_EVENT_TYPES.join(", ")}
  --source <source>     Source identifier (default: "plugin:<name>")
  --interval <seconds>  Min seconds between events (default: 1)

Examples:
  clockwerk plugin add deploy-tracker --command "tail -f /var/log/deploy.log"
  clockwerk plugin add figma --command "fswatch ~/designs" --event-type file_edit --interval 5
  clockwerk plugin add docker --template docker-logs
  clockwerk plugin test deploy-tracker
  clockwerk plugin remove deploy-tracker
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
    console.error("Error: Plugin name is required.");
    console.error("Usage: clockwerk plugin add <name> --command <cmd>");
    process.exit(1);
  }

  const flags = parseFlags(args.slice(1));

  // Handle templates
  let command = flags["command"];
  let eventType = flags["event-type"] as EventType | undefined;
  let source = flags["source"];
  let interval = flags["interval"] ? parseInt(flags["interval"], 10) : undefined;

  if (flags["template"]) {
    const template = TEMPLATES[flags["template"]];
    if (!template) {
      console.error(`Error: Unknown template "${flags["template"]}".`);
      console.error(`Available: ${Object.keys(TEMPLATES).join(", ")}`);
      process.exit(1);
    }
    // Template provides defaults, flags override
    command = command ?? template.command;
    eventType = eventType ?? template.event_type;
    source = source ?? template.source;
    interval = interval ?? template.interval;
  }

  if (!command) {
    console.error("Error: --command or --template is required.");
    console.error('Example: clockwerk plugin add my-plugin --command "tail -f log.txt"');
    process.exit(1);
  }

  eventType = eventType ?? "manual";
  if (!VALID_EVENT_TYPES.includes(eventType)) {
    console.error(`Error: Invalid event type "${eventType}".`);
    console.error(`Valid types: ${VALID_EVENT_TYPES.join(", ")}`);
    process.exit(1);
  }

  source = source ?? `plugin:${name}`;

  if (interval !== undefined && (isNaN(interval) || interval < 0)) {
    console.error("Error: --interval must be a non-negative number.");
    process.exit(1);
  }

  const cwd = process.cwd();
  const configPath = findProjectConfigPath(cwd);
  if (!configPath) {
    console.error("Error: No .clockwerk config found. Run 'clockwerk init' first.");
    process.exit(1);
  }

  const projectDir = resolve(configPath, "..");
  const config = findProjectConfig(cwd)!;

  if (!config.plugins) config.plugins = [];

  // Check for duplicate
  const existing = config.plugins.find((p) => p.name === name);
  if (existing) {
    console.error(
      `Error: Plugin "${name}" already exists. Remove it first to reconfigure.`,
    );
    process.exit(1);
  }

  const plugin: PluginConfig = {
    name,
    command,
    event_type: eventType,
    source,
  };
  if (interval !== undefined) plugin.interval = interval;

  config.plugins.push(plugin);
  saveProjectConfig(projectDir, config);

  console.log(`[clockwerk] Plugin "${name}" added.`);
  console.log(`  command:    ${command}`);
  console.log(`  event_type: ${eventType}`);
  console.log(`  source:     ${source}`);
  if (interval !== undefined) console.log(`  interval:   ${interval}s`);
  console.log(`\nThe daemon will pick up this plugin automatically.`);
}

async function remove(args: string[]): Promise<void> {
  const name = args[0];
  if (!name) {
    console.error("Usage: clockwerk plugin remove <name>");
    process.exit(1);
  }

  const cwd = process.cwd();
  const configPath = findProjectConfigPath(cwd);
  if (!configPath) {
    console.error("Error: No .clockwerk config found.");
    process.exit(1);
  }

  const projectDir = resolve(configPath, "..");
  const config = findProjectConfig(cwd)!;

  if (!config.plugins || config.plugins.length === 0) {
    console.error("No plugins configured.");
    process.exit(1);
  }

  const before = config.plugins.length;
  config.plugins = config.plugins.filter((p) => p.name !== name);

  if (config.plugins.length === before) {
    console.error(`Plugin "${name}" not found.`);
    process.exit(1);
  }

  if (config.plugins.length === 0) delete config.plugins;

  saveProjectConfig(projectDir, config);
  console.log(`[clockwerk] Plugin "${name}" removed.`);
  console.log(`\nThe daemon will pick up this change automatically.`);
}

async function list(_args: string[]): Promise<void> {
  const cwd = process.cwd();
  const config = findProjectConfig(cwd);
  if (!config) {
    console.error("Error: No .clockwerk config found.");
    process.exit(1);
  }

  const plugins = config.plugins ?? [];
  if (plugins.length === 0) {
    console.log("No plugins configured.");
    console.log("Add one with: clockwerk plugin add <name> --command <cmd>");
    console.log(`\nOr use a template: clockwerk plugin add <name> --template <template>`);
    console.log(`Available templates: ${Object.keys(TEMPLATES).join(", ")}`);
    return;
  }

  console.log(`Plugins (${plugins.length}):\n`);
  for (const p of plugins) {
    console.log(`  ${p.name}`);
    console.log(`    command:    ${p.command}`);
    console.log(`    event_type: ${p.event_type}`);
    console.log(`    source:     ${p.source}`);
    if (p.interval) console.log(`    interval:   ${p.interval}s`);
    console.log();
  }
}

async function test(args: string[]): Promise<void> {
  const name = args[0];
  if (!name) {
    console.error("Usage: clockwerk plugin test <name>");
    process.exit(1);
  }

  const cwd = process.cwd();
  const config = findProjectConfig(cwd);
  if (!config) {
    console.error("Error: No .clockwerk config found.");
    process.exit(1);
  }

  const plugin = (config.plugins ?? []).find((p) => p.name === name);
  if (!plugin) {
    console.error(`Plugin "${name}" not found.`);
    process.exit(1);
  }

  const configPath = findProjectConfigPath(cwd)!;
  const projectDir = resolve(configPath, "..");

  console.log(`Testing plugin "${name}"...`);
  console.log(`  command:    ${plugin.command}`);
  console.log(`  event_type: ${plugin.event_type}`);
  console.log(`  source:     ${plugin.source}`);
  console.log(`  interval:   ${plugin.interval ?? 1}s`);
  console.log(`\nListening for output (Ctrl+C to stop):\n`);

  const proc = Bun.spawn(["sh", "-c", plugin.command], {
    stdout: "pipe",
    stderr: "pipe",
    cwd: projectDir,
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
          if (line.trim()) console.error(`  \x1b[31mstderr:\x1b[0m ${line.trim()}`);
        }
      }
    } catch {
      /* stream ended */
    }
  })();

  // Read stdout and show parsed events
  const stdout = proc.stdout;
  if (!stdout || typeof stdout === "number") {
    console.error("Error: Could not read plugin stdout.");
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
          console.log(`  \x1b[33m${time} [throttled]\x1b[0m ${trimmed}`);
        } else {
          lastEventTs = now;
          console.log(`  \x1b[32m${time} [event]\x1b[0m`);
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

const SUBCOMMANDS: Record<string, (args: string[]) => Promise<void>> = {
  add,
  remove,
  list,
  test,
};

export default async function plugin(args: string[]): Promise<void> {
  const sub = args[0];

  if (!sub || sub === "--help" || sub === "-h") {
    printUsage();
    return;
  }

  const handler = SUBCOMMANDS[sub];
  if (!handler) {
    console.error(`Unknown subcommand: ${sub}`);
    printUsage();
    process.exit(1);
  }

  await handler(args.slice(1));
}

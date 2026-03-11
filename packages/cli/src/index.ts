#!/usr/bin/env bun

const command = process.argv[2];
const args = process.argv.slice(3);

const COMMANDS: Record<string, () => Promise<void>> = {
  login: () => import("./commands/login").then((m) => m.default(args)),
  logout: () => import("./commands/logout").then((m) => m.default()),
  up: () => import("./commands/up").then((m) => m.default(args)),
  down: () => import("./commands/down").then((m) => m.default(args)),
  logs: () => import("./commands/logs").then((m) => m.default(args)),
  status: () => import("./commands/status").then((m) => m.default(args)),
  init: () => import("./commands/init").then((m) => m.default(args)),
  link: () => import("./commands/link").then((m) => m.default()),
  config: () => import("./commands/config").then((m) => m.default(args)),
  hook: () => import("./commands/hook").then((m) => m.default(args)),
  log: () => import("./commands/log").then((m) => m.default(args)),
  mcp: () => import("./commands/mcp").then((m) => m.default(args)),
  plugin: () => import("./commands/plugin").then((m) => m.default(args)),
  export: () => import("./commands/export").then((m) => m.default(args)),
  "sync-reset": () => import("./commands/sync-reset").then((m) => m.default()),
  update: () => import("./commands/update").then((m) => m.default()),
  help: () => printHelp(),
};

async function printHelp(): Promise<void> {
  console.log(`
clockwerk — AI-native time tracking

Usage: clockwerk <command> [options]

Commands:
  login             Authenticate with getclockwerk.com
  logout            Log out and remove saved credentials
  up                Start the daemon
  down              Stop the daemon
  logs              Show daemon logs (-f to follow, -n <lines>, --level <level>)
  status            Show tracking status
  init [token]      Initialize project in current directory
  link              Link local project to cloud dashboard
  config            View project config
  config privacy    Edit privacy settings interactively
  config name <n>   Set project name
  config set <k> <v> Set a config value (e.g. privacy.sync_paths true)
  hook <source>     Log a hook event (used by AI tool integrations)
  hook install      Auto-detect and install hooks for AI tools
  hook install <id> Install hook for a specific tool (claude-code, codex, aider)
  log <dur> [desc]  Manually log time (e.g. clockwerk log 2h "meeting")
  export            Export sessions (--format csv|json, --since, --all, -o)
  mcp serve         Start MCP server (for Claude Code, Cursor, etc.)
  plugin            Manage custom event plugins (add, remove, list)
  update            Update clockwerk to the latest version
  help              Show this help message
`);
}

async function main(): Promise<void> {
  if (!command || command === "--help" || command === "-h") {
    await printHelp();
    process.exit(0);
  }

  const handler = COMMANDS[command];
  if (!handler) {
    console.error(`Unknown command: ${command}`);
    console.error(`Run 'clockwerk help' for usage.`);
    process.exit(1);
  }

  await handler();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

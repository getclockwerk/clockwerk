#!/usr/bin/env bun

import pc from "picocolors";

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
  list: () => import("./commands/list").then((m) => m.default(args)),
  log: () => import("./commands/log").then((m) => m.default(args)),
  mcp: () => import("./commands/mcp").then((m) => m.default(args)),
  plugin: () => import("./commands/plugin").then((m) => m.default(args)),
  export: () => import("./commands/export").then((m) => m.default(args)),
  push: () => import("./commands/push").then((m) => m.default(args)),
  pull: () => import("./commands/pull").then((m) => m.default(args)),
  sync: () => import("./commands/sync").then((m) => m.default(args)),
  studio: () => import("./commands/studio").then((m) => m.default(args)),
  help: () => printHelp(),
};

async function printHelp(): Promise<void> {
  const d = pc.dim;
  const b = pc.bold;

  console.log(`
${b("clockwerk")} ${d("- AI-native time tracking")}

${d("Usage:")} clockwerk <command> [options]

${b("Auth")}
  login              ${d("Authenticate with getclockwerk.com")}
  logout             ${d("Log out and remove saved credentials")}

${b("Tracking")}
  up                 ${d("Start the daemon")}
  down               ${d("Stop the daemon")}
  status             ${d("Show tracking status")}
  init [token]       ${d("Initialize project in current directory")}
  link               ${d("Link local project to cloud dashboard")}
  list <period>      ${d("List sessions (today, yesterday, week, month)")}
  log <dur> [desc]   ${d('Manually log time (e.g. clockwerk log 2h "meeting")')}

${b("Data")}
  logs               ${d("Show daemon logs (-f to follow, -n <lines>, --level)")}
  config             ${d("View or set project config")}
  export             ${d("Export sessions (--format csv|json, --since, --all, -o)")}
  push               ${d("Push local sessions to the cloud (-d descriptions, -s summaries)")}
  pull               ${d("Pull sessions from other devices (Pro)")}
  sync               ${d("Pull + push (shorthand for both)")}

${b("Integrations")}
  hook install       ${d("Auto-detect and install hooks for AI tools")}
  mcp serve          ${d("Start MCP server (for Claude Code, Cursor, etc.)")}
  plugin             ${d("Manage custom event plugins (add, remove, list)")}
  studio             ${d("Open Clockwerk Studio (local web UI)")}

${b("Other")}
  help               ${d("Show this help message")}
`);
}

async function main(): Promise<void> {
  if (!command || command === "--help" || command === "-h") {
    await printHelp();
    process.exit(0);
  }

  const handler = COMMANDS[command];
  if (!handler) {
    console.error(`${pc.red("✗")} Unknown command: ${command}`);
    console.error(pc.dim("Run 'clockwerk help' for usage."));
    process.exit(1);
  }

  await handler();
}

main().catch((err) => {
  console.error(`${pc.red("✗")} ${err}`);
  process.exit(1);
});

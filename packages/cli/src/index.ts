#!/usr/bin/env bun

import pc from "picocolors";
import { resolve } from "node:path";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

declare const __CLOCKWERK_VERSION__: string | undefined;

const VERSION =
  typeof __CLOCKWERK_VERSION__ !== "undefined" ? __CLOCKWERK_VERSION__ : "dev";

const CHECK_INTERVAL = 86400_000; // 24 hours
const SKIP_UPDATE_COMMANDS = new Set([
  "version",
  "--version",
  "-v",
  "help",
  "--help",
  "-h",
  "mcp",
]);

function isNewer(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return true;
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return false;
  }
  return false;
}

async function checkForUpdate(): Promise<void> {
  if (VERSION === "dev") return;

  try {
    const dir = resolve(process.env.HOME ?? "~", ".clockwerk");
    const cachePath = resolve(dir, "update-check.json");

    // Read cache
    let cache: { latest?: string; checkedAt?: number } = {};
    try {
      cache = JSON.parse(readFileSync(cachePath, "utf-8"));
    } catch {
      // No cache file yet
    }

    const now = Date.now();
    let latest = cache.latest;

    // Fetch if cache is stale
    if (!cache.checkedAt || now - cache.checkedAt > CHECK_INTERVAL) {
      const res = await fetch("https://registry.npmjs.org/@getclockwerk/cli/latest", {
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        const data = (await res.json()) as { version?: string };
        latest = data.version;
        mkdirSync(dir, { recursive: true });
        writeFileSync(cachePath, JSON.stringify({ latest, checkedAt: now }));
      }
    }

    if (latest && latest !== VERSION && isNewer(latest, VERSION)) {
      console.error(
        `\n${pc.yellow("!")} Update available: ${pc.dim(VERSION)} -> ${pc.bold(latest)}`,
      );
      console.error(pc.dim("  Run: bun add -g @getclockwerk/cli@latest"));
    }
  } catch {
    // Never fail the command over an update check
  }
}

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
  issue: () => import("./commands/issue").then((m) => m.default(args)),
  sync: () => import("./commands/sync").then((m) => m.default(args)),
  studio: () => import("./commands/studio").then((m) => m.default(args)),
  help: () => printHelp(),
};

async function printHelp(): Promise<void> {
  const d = pc.dim;
  const b = pc.bold;

  console.log(`
${b("clockwerk")} ${d(`v${VERSION} - local work history engine`)}

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
  issue              ${d("Link current branch to an issue (link, unlink, show)")}

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

  if (command === "version" || command === "--version" || command === "-v") {
    console.log(VERSION);
    process.exit(0);
  }

  const handler = COMMANDS[command];
  if (!handler) {
    console.error(`${pc.red("✗")} Unknown command: ${command}`);
    console.error(pc.dim("Run 'clockwerk help' for usage."));
    process.exit(1);
  }

  await handler();

  if (!SKIP_UPDATE_COMMANDS.has(command)) {
    await checkForUpdate();
  }
}

main().catch((err) => {
  console.error(`${pc.red("✗")} ${err}`);
  process.exit(1);
});

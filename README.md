<p align="center">
  <img src="https://getclockwerk.com/banner.svg" alt="clockwerk" width="100%" />
</p>

<h3 align="center">A local work history engine for developers.</h3>

<p align="center">
  Clockwerk reconstructs your development history from tool activity.<br/>
  Stored on your machine. No timers. No manual entry.
</p>

<p align="center">
  <a href="https://github.com/getclockwerk/clockwerk/releases"><img src="https://img.shields.io/github/v/release/getclockwerk/clockwerk?label=version&color=111" alt="Version" /></a>
  <a href="https://github.com/getclockwerk/clockwerk/blob/main/LICENSE"><img src="https://img.shields.io/github/license/getclockwerk/clockwerk?color=111" alt="License" /></a>
</p>

<p align="center">
  <a href="https://getclockwerk.com">Website</a> &middot;
  <a href="https://getclockwerk.com/docs">Docs</a> &middot;
  <a href="https://getclockwerk.com/pricing">Pricing</a> &middot;
  <a href="https://github.com/getclockwerk/clockwerk/releases">Releases</a>
</p>

---

## How it works

Hooks in your AI tools fire on every interaction. Each one sends a timestamped event to the Clockwerk daemon, which stores it in local SQLite. A gap-based algorithm groups events into sessions - stop working for 5 minutes and that's a session boundary.

Everything stays local. Cloud sync is optional and only sends timestamps, duration, and source - never keystrokes or content.

## Install

```sh
curl -fsSL https://getclockwerk.com/install.sh | sh
```

Or with a package manager:

```sh
bun add -g @getclockwerk/cli     # bun
npm install -g @getclockwerk/cli  # npm
```

## Quick start

```sh
clockwerk login            # authenticate (optional, for cloud sync)
clockwerk init             # set up a project in the current directory
clockwerk up               # start the daemon
```

That's it. Sessions appear automatically as you work.

## Commands

```
Auth
  login                    Authenticate with getclockwerk.com
  logout                   Log out and remove saved credentials

Tracking
  up                       Start the daemon
  down                     Stop the daemon
  status                   Show tracking status
  init [token]             Initialize project in current directory
  list <period>            List sessions (today, yesterday, week, month)
  log <dur> [desc]         Manually log time (e.g. clockwerk log 2h "meeting")

Data
  push                     Push local sessions to the cloud
  pull                     Pull sessions from other devices
  sync                     Pull + push (shorthand for both)
  export                   Export sessions (--format csv|json)

Integrations
  hook install             Auto-detect and install hooks for AI tools
  mcp serve                Start MCP server (for Claude Code, Cursor, etc.)
  plugin                   Manage custom event plugins (add, remove, list)
  studio                   Open Clockwerk Studio (local web UI)
```

## Integrations

Clockwerk hooks into your existing tools. No config needed - `clockwerk init` detects and installs them automatically.

| Tool           | Status    |
| -------------- | --------- |
| Claude Code    | Supported |
| Cursor         | Supported |
| GitHub Copilot | Beta      |

The built-in MCP server lets your AI tools query your work history directly - sessions, reports, time logs, all through natural conversation.

## Architecture

```
~/.clockwerk/
  clockwerk.db       Local SQLite (events + materialized sessions)
  daemon.sock        Unix socket for daemon communication
  daemon.pid         Daemon process ID
  config.json        User credentials (optional, for cloud sync)

.clockwerk           Per-project config (token, harnesses, plugins)
```

**Packages:**

- `@clockwerk/core` - Event schema, SQLite, session computation, config
- `@clockwerk/cli` - CLI, daemon, hooks, plugins, MCP server, sync
- `@clockwerk/hooks` - Hook adapters for AI tools

## Links

- [Documentation](https://getclockwerk.com/docs)
- [Pricing](https://getclockwerk.com/pricing)
- [Website](https://getclockwerk.com)

## License

MIT

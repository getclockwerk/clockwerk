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
  <a href="https://github.com/getclockwerk/clockwerk/releases">Releases</a>
</p>

---

## How it works

Hooks in your AI tools fire on every interaction. Each one sends a timestamped event to the Clockwerk daemon, which stores it in local SQLite. A gap-based algorithm groups events into sessions - stop working for 5 minutes and that's a session boundary.

Everything stays local.

## Install

```sh
bun add -g @getclockwerk/cli     # bun
npm install -g @getclockwerk/cli  # npm
```

## Quick start

```sh
clockwerk init             # set up a project in the current directory
clockwerk up               # start the daemon
```

That's it. Sessions appear automatically as you work.

## Commands

```
Tracking
  up                       Start the daemon
  down                     Stop the daemon
  status                   Show tracking status
  init                     Initialize project in current directory
  list <period>            List sessions (today, yesterday, week, month)
  log <dur> [desc]         Manually log time (e.g. clockwerk log 2h "meeting")

Data
  logs                     Show daemon logs (-f to follow)
  config                   View or set project config
  export                   Export sessions (--format csv|json)

Integrations
  hook install             Auto-detect and install hooks for AI tools
  plugin                   Manage custom event plugins (add, remove, list)
  studio                   Open Clockwerk Studio (local web UI)
```

## Autonomous tracking

When running AI agents in headless or autonomous mode, set `CLOCKWERK_SOURCE` to distinguish those sessions from interactive ones:

```sh
CLOCKWERK_SOURCE=claude-code-autonomous claude -p "Run the test suite and fix any failures"
```

The source value is stored with each session and shown in `clockwerk list` output. Any lowercase alphanumeric value with hyphens or colons (2-64 chars) is accepted.

If `CLOCKWERK_SOURCE` is not set, the source defaults to the hook adapter (`claude-code`, `cursor`, `copilot`).

## Integrations

Clockwerk hooks into your existing tools. No config needed - `clockwerk init` detects and installs them automatically.

| Tool           | Status    |
| -------------- | --------- |
| Claude Code    | Supported |
| Cursor         | Supported |
| GitHub Copilot | Beta      |

## Architecture

```
~/.clockwerk/
  clockwerk.db       Local SQLite (events + materialized sessions)
  daemon.sock        Unix socket for daemon communication
  daemon.pid         Daemon process ID

.clockwerk           Per-project config (token, harnesses, plugins)
```

**Packages:**

- `@clockwerk/core` - Event schema, SQLite, session computation, config
- `@clockwerk/cli` - CLI, daemon, hooks, plugins

## Links

- [Documentation](https://getclockwerk.com/docs)
- [Website](https://getclockwerk.com)

## License

MIT

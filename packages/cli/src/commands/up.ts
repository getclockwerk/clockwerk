import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { getDaemonSocketPath } from "@clockwerk/core";
import { isDaemonRunning, startDaemon } from "../daemon/server";
import { error, info, spinner } from "../ui";

export default async function up(_args: string[]): Promise<void> {
  if (isDaemonRunning()) {
    info("Daemon is already running.");
    return;
  }

  const foreground = _args.includes("--foreground") || _args.includes("-f");

  if (foreground) {
    startDaemon({ foreground: true });
    return;
  }

  // Spawn daemon in background - re-exec the current entry point
  // When running from source (bun run index.ts), argv[1] is the script path.
  // When running as a compiled binary, argv[1] is the first CLI arg (e.g. "up").
  const scriptPath = process.argv[1];
  const isFromSource = scriptPath?.match(/\.[tj]sx?$/);
  const daemonArgs = isFromSource
    ? [scriptPath, "up", "--foreground"]
    : ["up", "--foreground"];

  const child = spawn(process.execPath, daemonArgs, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  // Poll for socket to confirm daemon is ready (up to 3s)
  const spin = spinner("Starting daemon");
  const socketPath = getDaemonSocketPath();
  let started = false;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (existsSync(socketPath) && isDaemonRunning()) {
      started = true;
      break;
    }
  }

  if (started) {
    spin.stop("Daemon started");
  } else {
    spin.stop();
    error("Failed to start daemon.");
    process.exit(1);
  }
}

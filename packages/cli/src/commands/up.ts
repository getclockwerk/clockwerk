import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { getDaemonSocketPath } from "@clockwerk/core";
import { isDaemonRunning, startDaemon } from "../daemon/server";

export default async function up(_args: string[]): Promise<void> {
  if (isDaemonRunning()) {
    console.log("[clockwerk] Daemon is already running.");
    return;
  }

  const foreground = _args.includes("--foreground") || _args.includes("-f");

  if (foreground) {
    startDaemon({ foreground: true });
    return;
  }

  // Spawn daemon in background — re-exec the current binary
  const child = spawn(process.execPath, ["up", "--foreground"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  // Poll for socket to confirm daemon is ready (up to 3s)
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
    console.log("[clockwerk] Daemon started in background.");
  } else {
    console.error("[clockwerk] Failed to start daemon.");
    process.exit(1);
  }
}

import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { getDaemonPidPath, getDaemonSocketPath } from "@clockwerk/core";
import { isDaemonRunning } from "../daemon/server";

export default async function down(_args: string[]): Promise<void> {
  if (!isDaemonRunning()) {
    console.log("[clockwerk] Daemon is not running.");
    return;
  }

  const pidPath = getDaemonPidPath();
  const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);

  try {
    process.kill(pid, "SIGTERM");
    console.log("[clockwerk] Sent shutdown signal to daemon.");

    // Wait for graceful shutdown
    let attempts = 0;
    while (attempts < 20) {
      await new Promise((r) => setTimeout(r, 100));
      if (!isDaemonRunning()) {
        console.log("[clockwerk] Daemon stopped.");
        return;
      }
      attempts++;
    }

    // Force kill if still running
    console.log("[clockwerk] Force killing daemon...");
    process.kill(pid, "SIGKILL");
  } catch {
    // Process already gone — clean up stale files
    if (existsSync(pidPath)) unlinkSync(pidPath);
    const socketPath = getDaemonSocketPath();
    if (existsSync(socketPath)) unlinkSync(socketPath);
    console.log("[clockwerk] Daemon stopped.");
  }
}

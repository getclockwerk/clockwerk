import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { getDaemonPidPath, getDaemonSocketPath } from "@clockwerk/core";
import { isDaemonRunning } from "../daemon/server";
import { success, info, warn } from "../ui";

export default async function down(_args: string[]): Promise<void> {
  if (!isDaemonRunning()) {
    info("Daemon is not running.");
    return;
  }

  const pidPath = getDaemonPidPath();
  const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);

  try {
    process.kill(pid, "SIGTERM");

    let attempts = 0;
    while (attempts < 20) {
      await new Promise((r) => setTimeout(r, 100));
      if (!isDaemonRunning()) {
        success("Daemon stopped");
        return;
      }
      attempts++;
    }

    warn("Force killing daemon...");
    process.kill(pid, "SIGKILL");
  } catch {
    // Process already gone - clean up stale files
    if (existsSync(pidPath)) unlinkSync(pidPath);
    const socketPath = getDaemonSocketPath();
    if (existsSync(socketPath)) unlinkSync(socketPath);
    success("Daemon stopped");
  }
}

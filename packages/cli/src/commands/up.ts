import { spawn } from "node:child_process";
import { isDaemonRunning, startDaemon } from "../daemon/server";

export default async function up(_args: string[]): Promise<void> {
  if (isDaemonRunning()) {
    console.log("[clockwerk] Daemon is already running.");
    return;
  }

  const foreground = _args.includes("--foreground") || _args.includes("-f");

  if (foreground) {
    startDaemon();
    return;
  }

  // Spawn daemon in background
  const child = spawn(
    "bun",
    ["run", import.meta.dir + "/../index.ts", "up", "--foreground"],
    {
      detached: true,
      stdio: "ignore",
    },
  );
  child.unref();

  // Wait a moment for the daemon to start
  await new Promise((r) => setTimeout(r, 200));

  if (isDaemonRunning()) {
    console.log("[clockwerk] Daemon started in background.");
  } else {
    console.error("[clockwerk] Failed to start daemon.");
    process.exit(1);
  }
}

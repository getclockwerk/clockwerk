import { startDaemon } from "../daemon/server";
import { daemon } from "../daemon/client";
import { error, info, spinner } from "../ui";

export default async function up(_args: string[]): Promise<void> {
  if (daemon.isRunning()) {
    info("Daemon is already running.");
    return;
  }

  const foreground = _args.includes("--foreground") || _args.includes("-f");

  if (foreground) {
    startDaemon({ foreground: true });
    return;
  }

  const spin = spinner("Starting daemon");
  const started = await daemon.ensureRunning();

  if (started) {
    spin.stop("Daemon started");
  } else {
    spin.stop();
    error("Failed to start daemon.");
    process.exit(1);
  }
}

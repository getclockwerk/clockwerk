import { queryDaemon } from "../daemon/client";
import { isDaemonRunning } from "../daemon/server";

export default async function syncReset(): Promise<void> {
  if (!isDaemonRunning()) {
    console.error("Daemon is not running. Start it with 'clockwerk up' first.");
    process.exit(1);
  }

  try {
    await queryDaemon("reset-watermarks");
    console.log("Sync watermarks reset. All events will be re-synced on next cycle.");
  } catch (err) {
    console.error("Failed to reset watermarks:", err);
    process.exit(1);
  }
}

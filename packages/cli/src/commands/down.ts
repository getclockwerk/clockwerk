import { daemon } from "../daemon/client";
import { success, info } from "../ui";

export default async function down(_args: string[]): Promise<void> {
  if (!daemon.isRunning()) {
    info("Daemon is not running.");
    return;
  }

  await daemon.stop();
  success("Daemon stopped");
}

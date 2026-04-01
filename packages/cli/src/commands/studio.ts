import { daemon } from "../daemon/client";
import { error } from "../ui";

export default async function studio(args: string[]): Promise<void> {
  if (!daemon.isRunning()) {
    error("Daemon is not running. Start it with 'clockwerk up'.");
    process.exit(1);
  }

  const portArg = args.find((a) => a.startsWith("--port=") || a.startsWith("-p="));
  const port = portArg ? parseInt(portArg.split("=")[1], 10) : 3111;

  const { startStudio } = await import("@clockwerk/studio");
  await startStudio(port);

  // Open browser
  const url = `http://localhost:${port}`;
  const { exec } = await import("node:child_process");
  const openCmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
  exec(`${openCmd} ${url}`);
}

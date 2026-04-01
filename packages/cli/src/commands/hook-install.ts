import { error, info, dim } from "../ui";
import { type ToolDescriptor, getTools, detectTools, installTool } from "./hook-registry";

/** Detect which hook targets are available on this system */
export function detectTargets(): ToolDescriptor[] {
  return detectTools();
}

/** Install a single hook target */
export function installTarget(target: ToolDescriptor): void {
  const bin = "clockwerk";
  try {
    installTool(target, bin);
  } catch (err) {
    error(`${target.name} - failed: ${err instanceof Error ? err.message : err}`);
  }
}

export function installHooks(targetId?: string): void {
  const bin = "clockwerk";
  const tools = getTools();
  const ids = tools.map((t) => t.id);

  if (targetId) {
    const target = tools.find((t) => t.id === targetId);
    if (!target) {
      error(`Unknown hook target: ${targetId}`);
      error(`Available: ${ids.join(", ")}`);
      process.exit(1);
    }

    info(`Installing clockwerk hook for ${target.name} (binary: ${bin}):\n`);
    try {
      installTool(target, bin);
    } catch (err) {
      error(`${target.name} - failed: ${err instanceof Error ? err.message : err}`);
    }
  } else {
    const detected = detectTools();

    if (detected.length === 0) {
      info("No supported AI tools detected.");
      dim(`Available: ${ids.join(", ")}`);
      dim("Install a specific one: clockwerk hook install <name>");
      return;
    }

    info(`Installing clockwerk hooks (binary: ${bin}):\n`);

    for (const target of detected) {
      try {
        installTool(target, bin);
      } catch (err) {
        error(`${target.name} - failed: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  dim(`\nDone. Run 'clockwerk up' to start tracking.`);
}

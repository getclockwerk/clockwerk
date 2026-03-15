import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { success, error, info, dim } from "../ui";

const HOME = process.env.HOME ?? "~";

export interface HookTarget {
  id: string;
  name: string;
  configPath: string;
  detect: () => boolean;
  install: (bin: string) => void;
}

const TARGETS: HookTarget[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    configPath: resolve(HOME, ".claude", "settings.json"),
    detect: () => existsSync(resolve(HOME, ".claude")),
    install(bin) {
      const path = this.configPath;
      let config: Record<string, unknown> = {};

      if (existsSync(path)) {
        try {
          config = JSON.parse(readFileSync(path, "utf-8"));
        } catch {
          /* start fresh */
        }
      }

      const hooks = (config.hooks ?? {}) as Record<string, unknown[]>;
      const postToolUse = (hooks.PostToolUse ?? []) as Record<string, unknown>[];

      // Check if already installed (support both old flat format and new nested format)
      const alreadyInstalled = postToolUse.some((h) => {
        if (typeof h.command === "string" && h.command.includes("clockwerk hook"))
          return true;
        const nested = h.hooks as Record<string, unknown>[] | undefined;
        return nested?.some(
          (n) => typeof n.command === "string" && n.command.includes("clockwerk hook"),
        );
      });
      if (alreadyInstalled) {
        success("Claude Code - already installed");
        return;
      }

      postToolUse.push({
        matcher: ".*",
        hooks: [
          {
            type: "command",
            command: `${bin} hook claude-code`,
            timeout: 5,
          },
        ],
      });

      hooks.PostToolUse = postToolUse;
      config.hooks = hooks;

      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
      success("Claude Code - installed PostToolUse hook");
    },
  },
  {
    id: "cursor",
    name: "Cursor",
    configPath: resolve(HOME, ".cursor", "hooks.json"),
    detect: () => existsSync(resolve(HOME, ".cursor")),
    install(bin) {
      const path = this.configPath;
      let config: Record<string, unknown> = { version: 1, hooks: {} };

      if (existsSync(path)) {
        try {
          config = JSON.parse(readFileSync(path, "utf-8"));
        } catch {
          /* start fresh */
        }
      }

      const hooks = (config.hooks ?? {}) as Record<string, unknown[]>;
      const postToolUse = (hooks.postToolUse ?? []) as Record<string, unknown>[];

      const alreadyInstalled = postToolUse.some(
        (h) => typeof h.bash === "string" && h.bash.includes("clockwerk hook"),
      );
      if (alreadyInstalled) {
        success("Cursor - already installed");
        return;
      }

      postToolUse.push({
        type: "command",
        bash: `${bin} hook cursor`,
        timeoutSec: 5,
      });

      hooks.postToolUse = postToolUse;
      config.hooks = hooks;
      config.version = 1;

      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
      success("Cursor - installed postToolUse hook");
    },
  },
  {
    id: "copilot",
    name: "Copilot CLI",
    configPath: resolve(".github", "hooks", "clockwerk.json"),
    detect: () => existsSync(resolve(HOME, ".copilot")),
    install(bin) {
      const path = this.configPath;
      let config: Record<string, unknown> = { version: 1, hooks: {} };

      if (existsSync(path)) {
        try {
          config = JSON.parse(readFileSync(path, "utf-8"));
        } catch {
          /* start fresh */
        }
      }

      const hooks = (config.hooks ?? {}) as Record<string, unknown[]>;
      const postToolUse = (hooks.postToolUse ?? []) as Record<string, unknown>[];

      const alreadyInstalled = postToolUse.some(
        (h) => typeof h.bash === "string" && h.bash.includes("clockwerk hook"),
      );
      if (alreadyInstalled) {
        success("Copilot CLI - already installed");
        return;
      }

      postToolUse.push({
        type: "command",
        bash: `${bin} hook copilot`,
        timeoutSec: 5,
      });

      hooks.postToolUse = postToolUse;
      config.hooks = hooks;
      config.version = 1;

      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
      success("Copilot CLI - installed postToolUse hook");
    },
  },
];

/** Detect which hook targets are available on this system */
export function detectTargets(): HookTarget[] {
  return TARGETS.filter((t) => t.detect());
}

/** Install a single hook target */
export function installTarget(target: HookTarget): void {
  const bin = "clockwerk";
  try {
    target.install(bin);
  } catch (err) {
    error(`${target.name} - failed: ${err instanceof Error ? err.message : err}`);
  }
}

export function installHooks(targetId?: string): void {
  const bin = "clockwerk";
  const ids = TARGETS.map((t) => t.id);

  if (targetId) {
    const target = TARGETS.find((t) => t.id === targetId);
    if (!target) {
      error(`Unknown hook target: ${targetId}`);
      error(`Available: ${ids.join(", ")}`);
      process.exit(1);
    }

    info(`Installing clockwerk hook for ${target.name} (binary: ${bin}):\n`);
    try {
      target.install(bin);
    } catch (err) {
      error(`${target.name} - failed: ${err instanceof Error ? err.message : err}`);
    }
  } else {
    const detected = TARGETS.filter((t) => t.detect());

    if (detected.length === 0) {
      info("No supported AI tools detected.");
      dim(`Available: ${ids.join(", ")}`);
      dim("Install a specific one: clockwerk hook install <name>");
      return;
    }

    info(`Installing clockwerk hooks (binary: ${bin}):\n`);

    for (const target of detected) {
      try {
        target.install(bin);
      } catch (err) {
        error(`${target.name} - failed: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  dim(`\nDone. Run 'clockwerk up' to start tracking.`);
}

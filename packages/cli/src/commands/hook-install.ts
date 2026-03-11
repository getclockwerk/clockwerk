import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

const HOME = process.env.HOME ?? "~";

export interface HookTarget {
  id: string;
  name: string;
  configPath: string;
  detect: () => boolean;
  install: (bin: string) => void;
}

function getClockwerkBin(): string {
  // If running as a compiled binary, use the binary path
  // Otherwise fall back to "clockwerk" and assume it's in PATH
  const execPath = process.execPath;
  if (execPath.endsWith("clockwerk") || execPath.includes("clockwerk")) {
    return execPath;
  }
  return "clockwerk";
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
        console.log(`    ✓ Claude Code — already installed`);
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
      console.log(`    ✓ Claude Code — installed PostToolUse hook`);
    },
  },
  {
    id: "codex",
    name: "Codex CLI",
    configPath: resolve(HOME, ".codex", "config.toml"),
    detect: () => existsSync(resolve(HOME, ".codex")),
    install(bin) {
      const path = this.configPath;
      let content = "";

      if (existsSync(path)) {
        content = readFileSync(path, "utf-8");
      }

      if (content.includes("clockwerk hook")) {
        console.log(`    ✓ Codex CLI — already installed`);
        return;
      }

      const notifyLine = `notify = ["${bin}", "hook", "codex"]\n`;
      content = content ? content.trimEnd() + "\n" + notifyLine : notifyLine;

      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
      console.log(`    ✓ Codex CLI — installed notify hook`);
    },
  },
  {
    id: "aider",
    name: "Aider",
    configPath: resolve(HOME, ".aider.conf.yml"),
    detect: () =>
      existsSync(resolve(HOME, ".aider.conf.yml")) || existsSync(resolve(HOME, ".aider")),
    install(bin) {
      const path = this.configPath;
      let content = "";

      if (existsSync(path)) {
        content = readFileSync(path, "utf-8");
      }

      if (content.includes("clockwerk hook")) {
        console.log(`    ✓ Aider — already installed`);
        return;
      }

      const line = `notifications-command: ${bin} hook aider\n`;
      content = content ? content.trimEnd() + "\n" + line : line;

      writeFileSync(path, content);
      console.log(`    ✓ Aider — installed notifications hook`);
    },
  },
];

/** Detect which hook targets are available on this system */
export function detectTargets(): HookTarget[] {
  return TARGETS.filter((t) => t.detect());
}

/** Install a single hook target */
export function installTarget(target: HookTarget): void {
  const bin = getClockwerkBin();
  try {
    target.install(bin);
  } catch (err) {
    console.error(
      `    ! ${target.name} — failed: ${err instanceof Error ? err.message : err}`,
    );
  }
}

export function installHooks(targetId?: string): void {
  const bin = getClockwerkBin();
  const ids = TARGETS.map((t) => t.id);

  if (targetId) {
    const target = TARGETS.find((t) => t.id === targetId);
    if (!target) {
      console.error(`Unknown hook target: ${targetId}`);
      console.error(`Available: ${ids.join(", ")}`);
      process.exit(1);
    }

    console.log(`Installing clockwerk hook for ${target.name} (binary: ${bin}):\n`);
    try {
      target.install(bin);
    } catch (err) {
      console.error(
        `  [!] ${target.name} — failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  } else {
    const detected = TARGETS.filter((t) => t.detect());

    if (detected.length === 0) {
      console.log("No supported AI tools detected.");
      console.log(`Available: ${ids.join(", ")}`);
      console.log("Install a specific one: clockwerk hook install <name>");
      return;
    }

    console.log(`Installing clockwerk hooks (binary: ${bin}):\n`);

    for (const target of detected) {
      try {
        target.install(bin);
      } catch (err) {
        console.error(
          `  [!] ${target.name} — failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }

  console.log(`\nDone. Run 'clockwerk up' to start tracking.`);
}

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

const HOME = process.env.HOME ?? "~";

interface McpTarget {
  id: string;
  name: string;
  configPath: string;
  detect: () => boolean;
  install: (bin: string) => void;
}

function getClockwerkBin(): string {
  const execPath = process.execPath;
  if (execPath.endsWith("clockwerk") || execPath.includes("clockwerk")) {
    return execPath;
  }
  return "clockwerk";
}

function readJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return {};
  }
}

function writeJson(path: string, data: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}

const TARGETS: McpTarget[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    configPath: resolve(HOME, ".claude.json"),
    detect: () => existsSync(resolve(HOME, ".claude")),
    install(bin) {
      const path = this.configPath;
      const config = readJson(path);
      const servers = (config.mcpServers ?? {}) as Record<string, unknown>;

      if (servers.clockwerk) {
        console.log("    ✓ Claude Code — already installed");
        return;
      }

      servers.clockwerk = {
        type: "stdio",
        command: bin,
        args: ["mcp", "serve"],
      };

      config.mcpServers = servers;
      writeJson(path, config);
      console.log("    ✓ Claude Code — added MCP server to ~/.claude.json");
    },
  },
  {
    id: "cursor",
    name: "Cursor",
    configPath: resolve(HOME, ".cursor", "mcp.json"),
    detect: () => existsSync(resolve(HOME, ".cursor")),
    install(bin) {
      const path = this.configPath;
      const config = readJson(path);
      const servers = (config.mcpServers ?? {}) as Record<string, unknown>;

      if (servers.clockwerk) {
        console.log("    ✓ Cursor — already installed");
        return;
      }

      servers.clockwerk = {
        command: bin,
        args: ["mcp", "serve"],
      };

      config.mcpServers = servers;
      writeJson(path, config);
      console.log("    ✓ Cursor — added MCP server to mcp.json");
    },
  },
];

export function installMcp(targetId?: string): void {
  const bin = getClockwerkBin();
  const ids = TARGETS.map((t) => t.id);

  if (targetId) {
    const target = TARGETS.find((t) => t.id === targetId);
    if (!target) {
      console.error(`Unknown target: ${targetId}`);
      console.error(`Available: ${ids.join(", ")}`);
      process.exit(1);
    }

    console.log(`Installing Clockwerk MCP server for ${target.name} (binary: ${bin}):\n`);
    try {
      target.install(bin);
    } catch (err) {
      console.error(
        `    ! ${target.name} — failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  } else {
    const detected = TARGETS.filter((t) => t.detect());

    if (detected.length === 0) {
      console.log("No supported AI tools detected.");
      console.log(`Available: ${ids.join(", ")}`);
      console.log("Install for a specific tool: clockwerk mcp install <name>");
      return;
    }

    console.log(`Installing Clockwerk MCP server (binary: ${bin}):\n`);

    for (const target of detected) {
      try {
        target.install(bin);
      } catch (err) {
        console.error(
          `    ! ${target.name} — failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }

  console.log("\nDone. Restart your AI tool to connect.");
}

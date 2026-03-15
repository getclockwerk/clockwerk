import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { success, error, info, dim } from "../ui";

const HOME = process.env.HOME ?? "~";

interface McpTarget {
  id: string;
  name: string;
  configPath: string;
  detect: () => boolean;
  install: (bin: string) => void;
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
        success("Claude Code - already installed");
        return;
      }

      servers.clockwerk = {
        type: "stdio",
        command: bin,
        args: ["mcp", "serve"],
      };

      config.mcpServers = servers;
      writeJson(path, config);
      success("Claude Code - added MCP server to ~/.claude.json");
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
        success("Cursor - already installed");
        return;
      }

      servers.clockwerk = {
        command: bin,
        args: ["mcp", "serve"],
      };

      config.mcpServers = servers;
      writeJson(path, config);
      success("Cursor - added MCP server to mcp.json");
    },
  },
];

export function installMcp(targetId?: string): void {
  const bin = "clockwerk";
  const ids = TARGETS.map((t) => t.id);

  if (targetId) {
    const target = TARGETS.find((t) => t.id === targetId);
    if (!target) {
      error(`Unknown target: ${targetId}`);
      error(`Available: ${ids.join(", ")}`);
      process.exit(1);
    }

    info(`Installing Clockwerk MCP server for ${target.name} (binary: ${bin}):\n`);
    try {
      target.install(bin);
    } catch (err) {
      error(`${target.name} - failed: ${err instanceof Error ? err.message : err}`);
    }
  } else {
    const detected = TARGETS.filter((t) => t.detect());

    if (detected.length === 0) {
      info("No supported AI tools detected.");
      info(`Available: ${ids.join(", ")}`);
      dim("Install for a specific tool: clockwerk mcp install <name>");
      return;
    }

    info(`Installing Clockwerk MCP server (binary: ${bin}):\n`);

    for (const target of detected) {
      try {
        target.install(bin);
      } catch (err) {
        error(`${target.name} - failed: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  dim("\nDone. Restart your AI tool to connect.");
}

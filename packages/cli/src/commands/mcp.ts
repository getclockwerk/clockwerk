import { startMcpServer } from "../mcp/server";
import { installMcp } from "./mcp-install";

export default async function mcp(_args: string[]): Promise<void> {
  const subcommand = _args[0];

  switch (subcommand) {
    case "serve":
      return startMcpServer();
    case "install":
      return installMcp(_args[1]);
    default:
      console.error("Usage:");
      console.error("  clockwerk mcp serve     Start the MCP server (stdio transport)");
      console.error(
        "  clockwerk mcp install   Configure AI tools to use the Clockwerk MCP server",
      );
      process.exit(1);
  }
}

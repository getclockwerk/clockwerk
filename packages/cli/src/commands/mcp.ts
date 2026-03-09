import { startMcpServer } from "../mcp/server";

export default async function mcp(_args: string[]): Promise<void> {
  const subcommand = _args[0];

  if (subcommand !== "serve") {
    console.error("Usage: clockwerk mcp serve");
    console.error("  Starts the MCP server (stdio transport)");
    process.exit(1);
  }

  await startMcpServer();
}

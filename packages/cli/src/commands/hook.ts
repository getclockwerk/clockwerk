import {
  findProjectConfig,
  findProjectRoot,
  getProjectRegistry,
  resolveProjectFromPath,
  sendEvent,
  type ClockwerkEvent,
  type Source,
} from "@clockwerk/core";
import { relative as pathRelative } from "node:path";
import { isDaemonRunning } from "../daemon/server";
import {
  parseClaudeCodeHook,
  parseCursorHook,
  parseCopilotHook,
  parseGenericHook,
  extractAbsoluteFilePath,
  extractGitInfo,
} from "./hook-parsers";

/**
 * Hook command — called by AI tool integrations.
 *
 * Input varies by source:
 * - claude-code: reads JSON from stdin (PostToolUse hook)
 * - cursor: reads JSON from stdin (postToolUse hook)
 * - copilot: reads JSON from stdin (postToolUse hook)
 * - generic: reads JSON from stdin
 *
 * Usage: clockwerk hook <source> [json-payload]
 */
export default async function hook(args: string[]): Promise<void> {
  if (args[0] === "install") {
    const { installHooks } = await import("./hook-install");
    return installHooks(args[1]);
  }

  const source = args[0] as Source;
  if (!source) {
    console.error("Usage: clockwerk hook <source> [json-payload]");
    console.error("       clockwerk hook install");
    process.exit(1);
  }

  const input = await Bun.stdin.text();
  if (!input.trim()) return;

  const cwd = process.cwd();
  const projectConfig = findProjectConfig(cwd);
  if (!projectConfig) return; // Not in a tracked project, silently exit

  const projectRoot = findProjectRoot(cwd);

  // Parse the harness-specific input and build a ClockwerkEvent
  let event: ClockwerkEvent;

  switch (source) {
    case "claude-code":
      event = parseClaudeCodeHook(input, projectConfig.project_token, projectRoot);
      break;
    case "cursor":
      event = parseCursorHook(input, projectConfig.project_token, projectRoot);
      break;
    case "copilot":
      event = parseCopilotHook(input, projectConfig.project_token, projectRoot);
      break;
    default:
      // Generic: expect a JSON object with at least event_type
      event = parseGenericHook(input, source, projectConfig.project_token);
      break;
  }

  // Cross-project resolution: if the file path belongs to a different
  // registered project, override token, file_path, branch, and issue_id.
  const absoluteFilePath = extractAbsoluteFilePath(input);
  if (absoluteFilePath) {
    const registry = getProjectRegistry();
    const match = resolveProjectFromPath(absoluteFilePath, registry);
    if (match && match.project_token !== event.project_token) {
      event.project_token = match.project_token;
      // Re-relativize file_path to the matched project root
      if (event.context.file_path) {
        event.context.file_path = pathRelative(match.directory, absoluteFilePath);
      }
      // Re-resolve branch and issue_id from the matched project
      const { branch, issueId } = extractGitInfo(match.directory);
      event.context.branch = branch;
      event.context.issue_id = issueId;
    }
  }

  // Skip if daemon isn't running — events are only accepted when the user
  // has explicitly started the daemon with `clockwerk up`.
  if (!isDaemonRunning()) return;

  // Fire and forget to daemon
  await sendEvent({ type: "event", data: event });
}

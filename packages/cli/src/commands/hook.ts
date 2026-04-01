import {
  findProjectConfig,
  findProjectRoot,
  getProjectRegistry,
  resolveFromEntries,
  type ClockwerkEvent,
  type Source,
} from "@clockwerk/core";
import { relative as pathRelative } from "node:path";
import { daemon } from "../daemon/client";
import {
  parseGenericHook,
  extractAbsoluteFilePath,
  extractGitInfo,
} from "./hook-parsers";
import { getTool, parseStandardHook } from "./hook-registry";

/**
 * Hook command - called by AI tool integrations.
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

  const registry = getProjectRegistry();
  const entry = resolveFromEntries(cwd, registry);
  if (!entry) return; // Not in registry, silently exit

  const projectRoot = findProjectRoot(cwd);

  const descriptor = getTool(source);
  let event: ClockwerkEvent;

  if (descriptor?.parse) {
    event = descriptor.parse(input, entry.project_token, projectRoot);
  } else if (descriptor) {
    event = parseStandardHook(input, descriptor, entry.project_token, projectRoot);
  } else {
    event = parseGenericHook(input, source, entry.project_token);
  }

  const absoluteFilePath = extractAbsoluteFilePath(input);
  if (absoluteFilePath) {
    const match = resolveFromEntries(absoluteFilePath, registry);
    if (match && match.project_token !== event.project_token) {
      event.project_token = match.project_token;
      if (event.context.file_path) {
        event.context.file_path = pathRelative(match.directory, absoluteFilePath);
      }
      const { branch, issueId } = extractGitInfo(match.directory);
      event.context.branch = branch;
      event.context.issue_id = issueId;
    }
  }

  // Auto-starts daemon if not running so no tracking data is lost
  await daemon.send(event);
}

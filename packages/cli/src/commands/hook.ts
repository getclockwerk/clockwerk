import {
  findProjectConfig,
  findProjectRoot,
  getProjectRegistry,
  resolveProjectFromPath,
  type ClockwerkEvent,
  type EventType,
  type Source,
} from "@clockwerk/core";
import { relative as pathRelative } from "node:path";
import { sendEvent } from "../daemon/client";
import { isDaemonRunning } from "../daemon/server";

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

/**
 * Extract an absolute file path from the raw hook JSON input.
 * Handles Claude Code (tool_input.file_path, tool_input.path) and
 * Cursor/Copilot (toolArgs.file_path, toolArgs.filePath, toolArgs.path).
 */
function extractAbsoluteFilePath(input: string): string | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(input);
  } catch {
    return null;
  }

  // Claude Code format: tool_input.file_path or tool_input.path
  const toolInput = parsed.tool_input as Record<string, unknown> | undefined;
  if (toolInput) {
    const fp = (toolInput.file_path as string) ?? (toolInput.path as string);
    if (fp && fp.startsWith("/")) return fp;
  }

  // Cursor/Copilot format: toolArgs (may be JSON string)
  const toolArgs = parseToolArgs(parsed.toolArgs);
  const fp =
    (toolArgs.file_path as string) ??
    (toolArgs.filePath as string) ??
    (toolArgs.path as string);
  if (fp && fp.startsWith("/")) return fp;

  return null;
}

function parseClaudeCodeHook(
  input: string,
  projectToken: string,
  projectRoot: string | null,
): ClockwerkEvent {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(input);
  } catch {
    parsed = {};
  }

  const toolName = (parsed.tool_name as string) ?? "unknown";
  const sessionId = parsed.session_id as string | undefined;

  // Extract context based on tool type
  let description: string | undefined;
  let filePath: string | undefined;
  let topic: string | undefined;

  switch (toolName) {
    case "Bash":
      description =
        ((parsed.tool_input as Record<string, unknown>)?.description as string) ??
        ((parsed.tool_input as Record<string, unknown>)?.command as string);
      topic = description;
      break;
    case "Edit":
    case "Write":
    case "Read": {
      const fp = (parsed.tool_input as Record<string, unknown>)?.file_path as string;
      if (fp && projectRoot) {
        filePath = fp.startsWith(projectRoot) ? fp.slice(projectRoot.length + 1) : fp;
      }
      description = filePath ?? toolName;
      break;
    }
    case "Grep": {
      const ti = parsed.tool_input as Record<string, unknown>;
      description = ti?.pattern as string;
      const grepPath = ti?.path as string;
      if (grepPath && projectRoot) {
        filePath = grepPath.startsWith(projectRoot)
          ? grepPath.slice(projectRoot.length + 1)
          : grepPath;
      }
      break;
    }
    case "Glob": {
      const ti = parsed.tool_input as Record<string, unknown>;
      description = ti?.pattern as string;
      const globPath = ti?.path as string;
      if (globPath && projectRoot) {
        filePath = globPath.startsWith(projectRoot)
          ? globPath.slice(projectRoot.length + 1)
          : globPath;
      }
      break;
    }
    default:
      description = toolName;
  }

  const { branch, issueId } = extractGitInfo(projectRoot);

  return {
    id: crypto.randomUUID(),
    timestamp: Math.floor(Date.now() / 1000),
    event_type: "tool_call" as EventType,
    source: "claude-code",
    project_token: projectToken,
    context: {
      tool_name: toolName,
      description: description?.slice(0, 200),
      file_path: filePath,
      branch,
      issue_id: issueId,
      topic: topic?.slice(0, 200),
    },
    harness_session_id: sessionId,
  };
}

/**
 * Cursor postToolUse hook.
 *
 * Receives JSON via stdin with fields:
 *   { toolName, toolArgs, toolResult, cwd, conversation_id, ... }
 */
function parseCursorHook(
  input: string,
  projectToken: string,
  projectRoot: string | null,
): ClockwerkEvent {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(input);
  } catch {
    parsed = {};
  }

  const toolName =
    (parsed.toolName as string) ?? (parsed.hook_event_name as string) ?? "unknown";
  const sessionId = parsed.conversation_id as string | undefined;

  let description: string | undefined;
  let filePath: string | undefined;

  // toolArgs comes as a JSON string from Cursor
  const toolArgs = parseToolArgs(parsed.toolArgs);

  switch (toolName.toLowerCase()) {
    case "shell":
    case "bash":
      description = (toolArgs.command as string) ?? (toolArgs.description as string);
      break;
    case "write":
    case "read":
    case "edit": {
      const fp = (toolArgs.file_path as string) ?? (toolArgs.filePath as string);
      if (fp && projectRoot) {
        filePath = fp.startsWith(projectRoot) ? fp.slice(projectRoot.length + 1) : fp;
      }
      description = filePath ?? toolName;
      break;
    }
    default:
      description = toolName;
  }

  const { branch, issueId } = extractGitInfo(projectRoot);

  return {
    id: crypto.randomUUID(),
    timestamp: Math.floor(Date.now() / 1000),
    event_type: "tool_call",
    source: "cursor",
    project_token: projectToken,
    context: {
      tool_name: toolName.slice(0, 64),
      description: description?.slice(0, 200),
      file_path: filePath,
      branch,
      issue_id: issueId,
    },
    harness_session_id: sessionId,
  };
}

/**
 * GitHub Copilot CLI postToolUse hook.
 *
 * Receives JSON via stdin with fields:
 *   { toolName, toolArgs, toolResult, timestamp, cwd }
 */
function parseCopilotHook(
  input: string,
  projectToken: string,
  projectRoot: string | null,
): ClockwerkEvent {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(input);
  } catch {
    parsed = {};
  }

  const toolName = (parsed.toolName as string) ?? "unknown";

  let description: string | undefined;
  let filePath: string | undefined;

  // toolArgs comes as a JSON string from Copilot
  const toolArgs = parseToolArgs(parsed.toolArgs);

  switch (toolName.toLowerCase()) {
    case "bash":
    case "shell":
      description = (toolArgs.command as string) ?? (toolArgs.description as string);
      break;
    case "write":
    case "read":
    case "edit": {
      const fp = (toolArgs.file_path as string) ?? (toolArgs.filePath as string);
      if (fp && projectRoot) {
        filePath = fp.startsWith(projectRoot) ? fp.slice(projectRoot.length + 1) : fp;
      }
      description = filePath ?? toolName;
      break;
    }
    default:
      description = toolName;
  }

  const { branch, issueId } = extractGitInfo(projectRoot);

  return {
    id: crypto.randomUUID(),
    timestamp: Math.floor(Date.now() / 1000),
    event_type: "tool_call",
    source: "copilot",
    project_token: projectToken,
    context: {
      tool_name: toolName.slice(0, 64),
      description: description?.slice(0, 200),
      file_path: filePath,
      branch,
      issue_id: issueId,
    },
  };
}

function parseToolArgs(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  if (typeof raw === "object" && raw) return raw as Record<string, unknown>;
  return {};
}

function extractIssueId(branch: string): string | undefined {
  // Linear-style: ABC-123 (takes precedence)
  const linearMatch = branch.match(/[A-Z]+-\d+/i);
  if (linearMatch) return linearMatch[0].toUpperCase();

  // GitHub-style: extract number from common patterns
  const ghPatterns = [
    /(?:^|[/])(\d+)[-_]/, // feature/123-desc or 123_desc
    /[-_](\d+)$/, // desc-123
    /issue[-_]?(\d+)/i, // issue-123 or issue123
    /gh[-_](\d+)/i, // gh-123
  ];
  for (const p of ghPatterns) {
    const m = branch.match(p);
    if (m) return `#${m[1]}`;
  }

  return undefined;
}

function extractGitInfo(projectRoot: string | null): {
  branch: string | undefined;
  issueId: string | undefined;
} {
  let branch: string | undefined;
  let issueId: string | undefined;

  if (projectRoot) {
    try {
      const result = Bun.spawnSync([
        "git",
        "-C",
        projectRoot,
        "rev-parse",
        "--abbrev-ref",
        "HEAD",
      ]);
      branch = result.stdout.toString().trim() || undefined;
    } catch {
      // Not a git repo
    }
  }

  if (branch) {
    issueId = extractIssueId(branch);
  }

  return { branch, issueId };
}

function parseGenericHook(
  input: string,
  source: Source | string,
  projectToken: string,
): ClockwerkEvent {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(input);
  } catch {
    parsed = {};
  }

  return {
    id: crypto.randomUUID(),
    timestamp: Math.floor(Date.now() / 1000),
    event_type: (parsed.event_type as EventType) ?? "tool_call",
    source,
    project_token: projectToken,
    context: {
      tool_name: (parsed.tool_name as string)?.slice(0, 64),
      description: (parsed.description as string)?.slice(0, 200),
      file_path: (parsed.file_path as string)?.slice(0, 512),
      branch: (parsed.branch as string)?.slice(0, 256),
      issue_id: (parsed.issue_id as string)?.slice(0, 64),
      topic: (parsed.topic as string)?.slice(0, 200),
    },
    harness_session_id: (parsed.session_id as string)?.slice(0, 128),
  };
}

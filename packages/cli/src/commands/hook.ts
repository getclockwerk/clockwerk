import {
  findProjectConfig,
  findProjectRoot,
  type ClockwerkEvent,
  type EventType,
  type Source,
} from "@clockwerk/core";
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

  // Skip if daemon isn't running — events are only accepted when the user
  // has explicitly started the daemon with `clockwerk up`.
  if (!isDaemonRunning()) return;

  // Fire and forget to daemon
  await sendEvent({ type: "event", data: event });
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
    case "Grep":
      description = (parsed.tool_input as Record<string, unknown>)?.pattern as string;
      break;
    case "Glob":
      description = (parsed.tool_input as Record<string, unknown>)?.pattern as string;
      break;
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
    const match = branch.match(/[A-Z]+-\d+/i);
    if (match) issueId = match[0].toUpperCase();
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

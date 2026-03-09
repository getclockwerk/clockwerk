import {
  findProjectConfig,
  findProjectRoot,
  type ClockwerkEvent,
  type EventType,
  type Source,
} from "@clockwerk/core";
import { sendEvent } from "../daemon/client";
import { isDaemonRunning } from "../daemon/server";
import { spawn } from "node:child_process";

/**
 * Hook command — called by AI tool integrations.
 *
 * Input varies by source:
 * - claude-code: reads JSON from stdin (PostToolUse hook)
 * - codex: reads JSON from argv[1] (notify system)
 * - aider: no structured input (notifications-command)
 * - generic: reads JSON from stdin
 *
 * Usage: clockwerk hook <source> [json-payload]
 */
export default async function hook(args: string[]): Promise<void> {
  const source = args[0] as Source;
  if (!source) {
    console.error("Usage: clockwerk hook <source> [json-payload]");
    process.exit(1);
  }

  // Codex passes JSON as argv, aider passes nothing, claude-code uses stdin
  let input = "";
  if (args[1]) {
    input = args[1];
  } else if (source !== "aider") {
    input = await Bun.stdin.text();
    if (!input.trim()) return;
  }

  // Find project config — for codex, use cwd from payload if available
  let cwd = process.cwd();
  if (source === "codex" && input) {
    try {
      const parsed = JSON.parse(input);
      if (parsed.cwd) cwd = parsed.cwd;
    } catch {
      // Use process.cwd()
    }
  }

  const projectConfig = findProjectConfig(cwd);
  if (!projectConfig) return; // Not in a tracked project, silently exit

  const projectRoot = findProjectRoot(cwd);

  // Parse the harness-specific input and build a ClockwerkEvent
  let event: ClockwerkEvent;

  switch (source) {
    case "claude-code":
      event = parseClaudeCodeHook(input, projectConfig.project_token, projectRoot);
      break;
    case "codex":
      event = parseCodexHook(input, projectConfig.project_token, projectRoot);
      break;
    case "aider":
      event = parseAiderHook(projectConfig.project_token, projectRoot);
      break;
    default:
      // Generic: expect a JSON object with at least event_type
      event = parseGenericHook(input, source, projectConfig.project_token);
      break;
  }

  // Auto-start daemon if not running
  if (!isDaemonRunning()) {
    spawn("bun", ["run", import.meta.dir + "/../index.ts", "up", "--foreground"], {
      detached: true,
      stdio: "ignore",
    }).unref();
    // Brief wait for daemon to start
    await new Promise((r) => setTimeout(r, 300));
  }

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

function parseCodexHook(
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

  const eventType = parsed.type as string;
  if (eventType && eventType !== "agent-turn-complete") {
    // Only track turn completions — skip other notify events
    return {
      id: crypto.randomUUID(),
      timestamp: Math.floor(Date.now() / 1000),
      event_type: "heartbeat",
      source: "codex",
      project_token: projectToken,
      context: {},
    };
  }

  const threadId = parsed["thread-id"] as string | undefined;
  const lastMessage = parsed["last-assistant-message"] as string | undefined;

  // Extract branch
  const { branch, issueId } = extractGitInfo(projectRoot);

  return {
    id: crypto.randomUUID(),
    timestamp: Math.floor(Date.now() / 1000),
    event_type: "tool_call",
    source: "codex",
    project_token: projectToken,
    context: {
      description: lastMessage?.slice(0, 200),
      branch,
      issue_id: issueId,
    },
    harness_session_id: threadId,
  };
}

function parseAiderHook(
  projectToken: string,
  projectRoot: string | null,
): ClockwerkEvent {
  const { branch, issueId } = extractGitInfo(projectRoot);

  return {
    id: crypto.randomUUID(),
    timestamp: Math.floor(Date.now() / 1000),
    event_type: "heartbeat",
    source: "aider",
    project_token: projectToken,
    context: {
      description: "Aider turn complete",
      branch,
      issue_id: issueId,
    },
  };
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

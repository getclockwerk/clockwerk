import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import type { ClockwerkEvent } from "@clockwerk/core";
import {
  parseClaudeCodeHook,
  parseToolArgs,
  extractGitInfo,
  getSourceOverride,
} from "./hook-parsers";
import { success } from "../ui";

const HOME = process.env.HOME ?? "~";

function resolvePath(p: string): string {
  if (p.startsWith("~/")) return resolve(HOME, p.slice(2));
  return resolve(p);
}

export interface PayloadFieldMap {
  toolName?: string;
  toolArgs?: string;
  sessionId?: string;
}

export interface ToolDescriptor {
  id: string;
  name: string;
  detectPath: string;
  configPath: string;
  fields?: PayloadFieldMap;
  generateConfig?: (bin: string) => { config: Record<string, unknown>; matchKey: string };
  parse?: (
    input: string,
    projectToken: string,
    projectRoot: string | null,
  ) => ClockwerkEvent;
}

const _registry = new Map<string, ToolDescriptor>();

export function registerTool(desc: ToolDescriptor): void {
  _registry.set(desc.id, desc);
}

export function getTool(id: string): ToolDescriptor | undefined {
  return _registry.get(id);
}

export function getTools(): readonly ToolDescriptor[] {
  return Array.from(_registry.values());
}

export function detectTools(): ToolDescriptor[] {
  return getTools().filter((d) => existsSync(resolvePath(d.detectPath)));
}

/**
 * Standard hook parser for tools using the postToolUse payload format.
 * Uses the descriptor's field map to extract data from the payload.
 * Tools with unique payload formats should provide a custom `parse` function instead.
 */
export function parseStandardHook(
  input: string,
  descriptor: Pick<ToolDescriptor, "id" | "fields">,
  projectToken: string,
  projectRoot: string | null,
): ClockwerkEvent {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(input);
  } catch {
    parsed = {};
  }

  const toolNameField = descriptor.fields?.toolName ?? "toolName";
  const toolArgsField = descriptor.fields?.toolArgs ?? "toolArgs";
  // If sessionId is explicitly set in fields (even to undefined), use that; otherwise default to "conversation_id"
  const sessionIdField =
    descriptor.fields !== undefined && "sessionId" in descriptor.fields
      ? descriptor.fields.sessionId
      : "conversation_id";

  const toolName =
    (parsed[toolNameField] as string) ?? (parsed.hook_event_name as string) ?? "unknown";
  const toolArgs = parseToolArgs(parsed[toolArgsField]);
  const sessionId = sessionIdField
    ? (parsed[sessionIdField] as string | undefined)
    : undefined;

  let description: string | undefined;
  let filePath: string | undefined;

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
    source: getSourceOverride() ?? descriptor.id,
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

function standardInstall(descriptor: ToolDescriptor, bin: string): void {
  const configPath = resolvePath(descriptor.configPath);
  let config: Record<string, unknown> = { version: 1, hooks: {} };

  if (existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, "utf-8"));
    } catch {
      /* start fresh */
    }
  }

  const hooks = (config.hooks ?? {}) as Record<string, unknown[]>;
  const postToolUse = (hooks.postToolUse ?? []) as Record<string, unknown>[];

  const alreadyInstalled = postToolUse.some(
    (h) => typeof h.bash === "string" && h.bash.includes("clockwerk hook"),
  );
  if (alreadyInstalled) {
    success(`${descriptor.name} - already installed`);
    return;
  }

  postToolUse.push({
    type: "command",
    bash: `${bin} hook ${descriptor.id}`,
    timeoutSec: 5,
  });

  hooks.postToolUse = postToolUse;
  config.hooks = hooks;
  config.version = 1;

  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  success(`${descriptor.name} - installed postToolUse hook`);
}

function customInstall(descriptor: ToolDescriptor, bin: string): void {
  const { config: hookConfig, matchKey } = descriptor.generateConfig!(bin);
  const configPath = resolvePath(descriptor.configPath);

  let config: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, "utf-8"));
    } catch {
      /* start fresh */
    }
  }

  const hooksSection = hookConfig.hooks as Record<string, unknown[]>;
  const hookListKey = Object.keys(hooksSection)[0]!;
  const newHookEntry = hooksSection[hookListKey]![0];

  const hooks = (config.hooks ?? {}) as Record<string, unknown[]>;
  const hookList = (hooks[hookListKey] ?? []) as Record<string, unknown>[];

  const alreadyInstalled = hookList.some((h) => {
    if (
      typeof h[matchKey] === "string" &&
      (h[matchKey] as string).includes("clockwerk hook")
    )
      return true;
    const nested = h.hooks as Record<string, unknown>[] | undefined;
    return nested?.some(
      (n) =>
        typeof n[matchKey] === "string" &&
        (n[matchKey] as string).includes("clockwerk hook"),
    );
  });

  if (alreadyInstalled) {
    success(`${descriptor.name} - already installed`);
    return;
  }

  hookList.push(newHookEntry as Record<string, unknown>);
  hooks[hookListKey] = hookList;
  config.hooks = hooks;

  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  success(`${descriptor.name} - installed ${hookListKey} hook`);
}

export function installTool(descriptor: ToolDescriptor, bin: string): void {
  if (descriptor.generateConfig) {
    customInstall(descriptor, bin);
  } else {
    standardInstall(descriptor, bin);
  }
}

// Tool registrations

registerTool({
  id: "cursor",
  name: "Cursor",
  detectPath: "~/.cursor",
  configPath: "~/.cursor/hooks.json",
});

registerTool({
  id: "copilot",
  name: "Copilot CLI",
  detectPath: "~/.copilot",
  configPath: ".github/hooks/clockwerk.json",
  fields: { sessionId: undefined },
});

registerTool({
  id: "claude-code",
  name: "Claude Code",
  detectPath: "~/.claude",
  configPath: "~/.claude/settings.json",
  generateConfig: (bin) => ({
    config: {
      hooks: {
        PostToolUse: [
          {
            matcher: ".*",
            hooks: [
              {
                type: "command",
                command: `${bin} hook claude-code`,
                timeout: 5,
              },
            ],
          },
        ],
      },
    },
    matchKey: "command",
  }),
  parse: parseClaudeCodeHook,
});

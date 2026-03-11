/**
 * Hook configuration generators for various AI tools.
 *
 * These produce the config snippets needed to wire up each AI tool
 * to call `clockwerk hook <source>` on relevant events.
 */

export interface HookConfig {
  source: string;
  description: string;
  configPath: string;
  generate: () => unknown;
}

/**
 * Claude Code PostToolUse hook configuration.
 *
 * Adds a hook to ~/.claude/settings.json that pipes tool call JSON
 * to `clockwerk hook claude-code` after every tool use.
 */
export function claudeCodeHookConfig(clockwerkBin: string): HookConfig {
  return {
    source: "claude-code",
    description: "Claude Code PostToolUse hook",
    configPath: "~/.claude/settings.json",
    generate: () => ({
      hooks: {
        PostToolUse: [
          {
            matcher: ".*",
            command: `${clockwerkBin} hook claude-code`,
          },
        ],
      },
    }),
  };
}

/**
 * Cursor postToolUse hook configuration.
 *
 * Adds a hook to ~/.cursor/hooks.json that pipes tool call JSON
 * to `clockwerk hook cursor` after every tool use.
 */
export function cursorHookConfig(clockwerkBin: string): HookConfig {
  return {
    source: "cursor",
    description: "Cursor postToolUse hook",
    configPath: "~/.cursor/hooks.json",
    generate: () => ({
      version: 1,
      hooks: {
        postToolUse: [
          {
            type: "command",
            bash: `${clockwerkBin} hook cursor`,
            timeoutSec: 5,
          },
        ],
      },
    }),
  };
}

/**
 * GitHub Copilot CLI postToolUse hook configuration.
 *
 * Adds a hook to .github/hooks/clockwerk.json that pipes tool call JSON
 * to `clockwerk hook copilot` after every tool use.
 */
export function copilotHookConfig(clockwerkBin: string): HookConfig {
  return {
    source: "copilot",
    description: "Copilot CLI postToolUse hook",
    configPath: ".github/hooks/clockwerk.json",
    generate: () => ({
      version: 1,
      hooks: {
        postToolUse: [
          {
            type: "command",
            bash: `${clockwerkBin} hook copilot`,
            timeoutSec: 5,
          },
        ],
      },
    }),
  };
}

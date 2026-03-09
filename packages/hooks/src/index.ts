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
 * OpenAI Codex CLI notify configuration.
 *
 * Sets the notify command in ~/.codex/config.toml to call
 * `clockwerk hook codex` with the JSON payload as an argument
 * after each agent turn.
 */
export function codexHookConfig(clockwerkBin: string): HookConfig {
  return {
    source: "codex",
    description: "Codex CLI notify hook",
    configPath: "~/.codex/config.toml",
    generate: () => ({
      notify: [clockwerkBin, "hook", "codex"],
    }),
  };
}

/**
 * Aider notifications-command configuration.
 *
 * Sets the notifications-command in .aider.conf.yml to call
 * `clockwerk hook aider` when the LLM finishes a turn.
 */
export function aiderHookConfig(clockwerkBin: string): HookConfig {
  return {
    source: "aider",
    description: "Aider notifications hook",
    configPath: ".aider.conf.yml",
    generate: () => ({
      "notifications-command": `${clockwerkBin} hook aider`,
    }),
  };
}

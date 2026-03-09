import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  saveProjectConfig,
  findProjectConfig,
  getUserConfig,
  registerProject,
  type ProjectConfig,
} from "@clockwerk/core";

export default async function init(args: string[]): Promise<void> {
  const token = args[0];
  if (!token) {
    console.error("Usage: clockwerk init <project-token>");
    process.exit(1);
  }

  const cwd = process.cwd();

  // Check if already initialized
  const existing = findProjectConfig(cwd);
  if (existing) {
    console.error(
      `This directory is already tracked (token: ${existing.project_token}).`,
    );
    console.error(`Remove .clockwerk to reinitialize.`);
    process.exit(1);
  }

  // TODO: Validate token against cloud API when available
  // For now, just save the config locally

  const config: ProjectConfig = {
    version: 1,
    project_token: token,
    api_url: getUserConfig()?.api_url ?? "https://getclockwerk.com",
    privacy: {
      sync_paths: true,
      sync_branches: true,
      sync_descriptions: true,
    },
    harnesses: {},
  };

  // Detect available harnesses
  const harnesses: string[] = [];

  // Claude Code
  const claudeSettings = resolve(process.env.HOME ?? "~", ".claude", "settings.json");
  if (existsSync(claudeSettings)) {
    config.harnesses["claude-code"] = true;
    harnesses.push("Claude Code");
  }

  // Codex CLI
  const codexConfig = resolve(process.env.HOME ?? "~", ".codex", "config.toml");
  if (existsSync(codexConfig)) {
    config.harnesses["codex"] = true;
    harnesses.push("Codex CLI");
  }

  // Aider
  if (existsSync(resolve(cwd, ".aider.conf.yml"))) {
    config.harnesses["aider"] = true;
    harnesses.push("Aider");
  }

  // Git
  if (existsSync(resolve(cwd, ".git"))) {
    config.harnesses["git-hooks"] = true;
    harnesses.push("Git hooks");
  }

  saveProjectConfig(cwd, config);
  registerProject({ project_token: token, directory: cwd });

  console.log(`[clockwerk] Initialized project (token: ${token})`);
  console.log(`[clockwerk] Config written to ${resolve(cwd, ".clockwerk")}`);

  if (harnesses.length > 0) {
    console.log(`\nDetected harnesses:`);
    for (const h of harnesses) {
      console.log(`  [x] ${h}`);
    }
  }

  console.log(`\nRun 'clockwerk up' to start tracking.`);
}

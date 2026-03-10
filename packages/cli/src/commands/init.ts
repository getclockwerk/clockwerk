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

  const userConfig = getUserConfig();
  const apiUrl = userConfig?.api_url ?? "https://getclockwerk.com";

  // Validate token against cloud API
  if (userConfig?.token) {
    try {
      const res = await fetch(
        `${apiUrl}/api/v1/projects/validate?token=${encodeURIComponent(token)}`,
        { headers: { Authorization: `Bearer ${userConfig.token}` } },
      );
      if (res.ok) {
        const data = await res.json();
        const name = data.project?.name ?? "Unknown";
        const org = data.project?.org_name;
        console.log(`[clockwerk] Verified project: ${name}${org ? ` (${org})` : ""}`);
      } else if (res.status === 404) {
        console.error(`[clockwerk] Error: invalid project token "${token}"`);
        console.error(`Check the token in your dashboard and try again.`);
        process.exit(1);
      } else if (res.status === 401) {
        console.error(`[clockwerk] Auth expired. Run 'clockwerk login' first.`);
        process.exit(1);
      } else {
        // Non-critical — proceed anyway
        console.warn(
          `[clockwerk] Could not validate token (HTTP ${res.status}), proceeding anyway`,
        );
      }
    } catch {
      // Network error — proceed without validation
      console.warn(
        `[clockwerk] Could not reach API to validate token, proceeding anyway`,
      );
    }
  } else {
    console.warn(
      `[clockwerk] Not logged in — skipping token validation. Run 'clockwerk login' to verify.`,
    );
  }

  const config: ProjectConfig = {
    version: 1,
    project_token: token,
    api_url: apiUrl,
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

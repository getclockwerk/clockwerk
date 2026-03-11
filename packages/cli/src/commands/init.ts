import { resolve, basename } from "node:path";
import {
  saveProjectConfig,
  findProjectConfig,
  getUserConfig,
  registerProject,
  type ProjectConfig,
} from "@clockwerk/core";
import { ask, confirm, close } from "../prompt";
import { detectTargets, installTarget } from "./hook-install";

export default async function init(args: string[]): Promise<void> {
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

  // If a cloud token is provided, use the quick (non-interactive) path
  const tokenArg = args[0];
  if (tokenArg && !tokenArg.startsWith("-")) {
    await initWithCloudToken(cwd, tokenArg);
    return;
  }

  // Interactive init
  console.log("\n  Welcome to Clockwerk! Let's set up time tracking for this project.\n");

  const dirName = basename(cwd);
  const projectName = await ask("  Project name", dirName);

  // Generate local token from project name
  const slug = projectName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const token = `local_${slug}`;

  const config: ProjectConfig = {
    version: 1,
    project_name: projectName,
    project_token: token,
    privacy: {
      sync_paths: false,
      sync_branches: false,
      sync_descriptions: false,
    },
    harnesses: {},
  };

  // Detect tools and ask about hook installation
  const detected = detectTargets();

  if (detected.length > 0) {
    console.log("\n  Detected tools:");
    for (const target of detected) {
      const shouldInstall = await confirm(`    ${target.name} — install hook?`);
      config.harnesses[target.id] = true;
      if (shouldInstall) {
        installTarget(target);
      }
    }
  }

  saveProjectConfig(cwd, config);
  registerProject({ project_token: token, directory: cwd });

  console.log(`\n  ✓ Created .clockwerk config`);
  console.log(`\n  Tracking locally! Run 'clockwerk up' to start the daemon.`);
  console.log(`  Tip: Run 'clockwerk login' to sync sessions to the cloud.\n`);

  close();
}

/** Quick init with a cloud project token (power-user / dashboard onboarding flow) */
async function initWithCloudToken(cwd: string, token: string): Promise<void> {
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
        console.warn(
          `[clockwerk] Could not validate token (HTTP ${res.status}), proceeding anyway`,
        );
      }
    } catch {
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

  // Auto-detect harnesses (silent, non-interactive)
  const detected = detectTargets();
  for (const target of detected) {
    config.harnesses[target.id] = true;
  }

  saveProjectConfig(cwd, config);
  registerProject({ project_token: token, directory: cwd });

  console.log(`[clockwerk] Initialized project (token: ${token})`);
  console.log(`[clockwerk] Config written to ${resolve(cwd, ".clockwerk")}`);

  if (detected.length > 0) {
    console.log(`\nDetected harnesses:`);
    for (const h of detected) {
      console.log(`  [x] ${h.name}`);
    }
    console.log(`\nRun 'clockwerk hook install' to set up hooks.`);
  }

  console.log(`\nRun 'clockwerk up' to start tracking.`);
}

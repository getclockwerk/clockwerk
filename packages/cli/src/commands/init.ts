import { resolve, basename } from "node:path";
import { existsSync, readFileSync, appendFileSync } from "node:fs";
import {
  saveProjectConfig,
  findProjectConfig,
  getUserConfig,
  registerProject,
  type ProjectConfig,
} from "@clockwerk/core";
import { ask, confirm } from "../prompt";
import { detectTargets, installTarget } from "./hook-install";
import { success, error, warn, info, dim, pc } from "../ui";

export default async function init(args: string[]): Promise<void> {
  const cwd = process.cwd();

  // Check if already initialized
  const existing = findProjectConfig(cwd);
  if (existing) {
    error(`This directory is already tracked (token: ${existing.project_token})`);
    dim("Remove .clockwerk to reinitialize.");
    process.exit(1);
  }

  // If a cloud token (proj_*) is provided, use the quick (non-interactive) path
  const firstArg = args[0];
  if (firstArg && firstArg.startsWith("proj_")) {
    await initWithCloudToken(cwd, firstArg);
    return;
  }

  // Interactive init
  console.log(
    `\n  ${pc.bold("Welcome to Clockwerk!")} Let's set up time tracking for this project.\n`,
  );

  const defaultName = firstArg && !firstArg.startsWith("-") ? firstArg : basename(cwd);
  const projectName =
    firstArg && !firstArg.startsWith("-")
      ? firstArg
      : await ask("Project name", defaultName);

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
    harnesses: {},
  };

  // Detect tools and ask about hook installation
  const detected = detectTargets();

  if (detected.length > 0) {
    console.log(`\n  ${pc.bold("Detected tools:")}`);
    for (const target of detected) {
      const shouldInstall = await confirm(`  Install hook for ${target.name}?`);
      config.harnesses[target.id] = true;
      if (shouldInstall) {
        installTarget(target);
      }
    }
  }

  saveProjectConfig(cwd, config);
  registerProject({ project_token: token, directory: cwd });

  const gitignorePath = resolve(cwd, ".gitignore");
  try {
    const content = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf-8") : "";
    if (!content.split("\n").some((line) => line.trim() === ".clockwerk")) {
      const prefix = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
      appendFileSync(gitignorePath, `${prefix}.clockwerk\n`);
      console.log(`[clockwerk] Added .clockwerk to .gitignore`);
    }
  } catch {
    console.warn(
      "[clockwerk] Could not update .gitignore - please add .clockwerk manually",
    );
  }

  console.log();
  success("Created .clockwerk config");
  console.log();
  info("Tracking locally! Run 'clockwerk up' to start the daemon.");
  dim("Tip: Run 'clockwerk login' to sync sessions to the cloud.");
  console.log();
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
        success(`Verified project: ${name}${org ? ` (${org})` : ""}`);
      } else if (res.status === 404) {
        error(`Invalid project token "${token}"`);
        dim("Check the token in your dashboard and try again.");
        process.exit(1);
      } else if (res.status === 401) {
        error("Auth expired. Run 'clockwerk login' first.");
        process.exit(1);
      } else {
        warn(`Could not validate token (HTTP ${res.status}), proceeding anyway`);
      }
    } catch {
      warn("Could not reach API to validate token, proceeding anyway");
    }
  } else {
    warn("Not logged in - skipping token validation. Run 'clockwerk login' to verify.");
  }

  const config: ProjectConfig = {
    version: 1,
    project_token: token,
    api_url: apiUrl,
    harnesses: {},
  };

  // Auto-detect harnesses (silent, non-interactive)
  const detected = detectTargets();
  for (const target of detected) {
    config.harnesses[target.id] = true;
  }

  saveProjectConfig(cwd, config);
  registerProject({ project_token: token, directory: cwd });

  const gitignorePath = resolve(cwd, ".gitignore");
  try {
    const content = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf-8") : "";
    if (!content.split("\n").some((line) => line.trim() === ".clockwerk")) {
      const prefix = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
      appendFileSync(gitignorePath, `${prefix}.clockwerk\n`);
      console.log(`[clockwerk] Added .clockwerk to .gitignore`);
    }
  } catch {
    console.warn(
      "[clockwerk] Could not update .gitignore - please add .clockwerk manually",
    );
  }

  success(`Initialized project (token: ${token})`);
  dim(`Config written to ${resolve(cwd, ".clockwerk")}`);

  if (detected.length > 0) {
    console.log();
    info("Detected harnesses:");
    for (const h of detected) {
      console.log(`  ${pc.green("✓")} ${h.name}`);
    }
    dim("\nRun 'clockwerk hook install' to set up hooks.");
  }

  dim("\nRun 'clockwerk up' to start tracking.");
}

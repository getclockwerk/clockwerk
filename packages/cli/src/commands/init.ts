import { resolve, basename } from "node:path";
import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { execSync } from "node:child_process";
import {
  saveProjectConfig,
  findProjectConfig,
  registerProject,
  type ProjectConfig,
} from "@clockwerk/core";
import { ask } from "../prompt";
import { detectTargets, installTarget } from "./hook-install";
import { success, error, info, dim, pc, spinner } from "../ui";
import { daemon } from "../daemon/client";

export function inferProjectNameFromGit(cwd: string): string | null {
  try {
    const url = execSync("git remote get-url origin", {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    // Extract repo name from https://github.com/user/repo.git or git@github.com:user/repo.git
    const match = url.match(/\/([^/]+?)(?:\.git)?$/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

export default async function init(args: string[]): Promise<void> {
  const cwd = process.cwd();

  // Check if already initialized
  const existing = findProjectConfig(cwd);
  if (existing) {
    error(`This directory is already tracked`);
    dim("Remove .clockwerk to reinitialize.");
    process.exit(1);
  }

  // Interactive init
  console.log(
    `\n  ${pc.bold("Welcome to Clockwerk!")} Let's set up time tracking for this project.\n`,
  );

  const firstArg = args[0];
  const gitName = inferProjectNameFromGit(cwd);
  const defaultName =
    firstArg && !firstArg.startsWith("-") ? firstArg : (gitName ?? basename(cwd));
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
    harnesses: {},
  };

  // Auto-detect and install hooks for all detected tools
  const detected = detectTargets();

  if (detected.length > 0) {
    console.log(`\n  ${pc.bold("Detected tools:")} Installing hooks...`);
    for (const target of detected) {
      config.harnesses[target.id] = true;
      installTarget(target);
    }
  } else {
    dim(
      "\n  No supported AI tools detected. Run 'clockwerk hook install' to add hooks later.",
    );
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

  // Start daemon automatically if not already running
  if (daemon.isRunning()) {
    info("Daemon already running - you're tracking!");
  } else {
    const spin = spinner("Starting daemon");
    const started = await daemon.ensureRunning();
    if (started) {
      spin.stop("Daemon started - you're tracking!");
    } else {
      spin.stop();
      error("Failed to start daemon. Run 'clockwerk up' manually.");
    }
  }

  console.log();
}

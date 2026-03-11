import {
  getUserConfig,
  findProjectConfig,
  saveProjectConfig,
  findProjectConfigPath,
  registerProject,
  isLocalToken,
} from "@clockwerk/core";
import { confirm, choose, close } from "../prompt";
import { resolve } from "node:path";

interface CloudProject {
  id: string;
  name: string;
  token: string;
  orgId: string;
  clientName: string | null;
}

interface UserOrg {
  id: string;
  name: string;
}

export default async function link(): Promise<void> {
  const cwd = process.cwd();

  const userConfig = getUserConfig();
  if (!userConfig) {
    console.error("Not logged in. Run 'clockwerk login' first.");
    process.exit(1);
  }

  const configPath = findProjectConfigPath(cwd);
  const config = findProjectConfig(cwd);
  if (!config || !configPath) {
    console.error("No .clockwerk config found. Run 'clockwerk init' first.");
    process.exit(1);
  }

  if (!isLocalToken(config.project_token)) {
    console.log(`Already linked to cloud project (token: ${config.project_token}).`);
    console.log(`Remove .clockwerk and re-init to change.`);
    return;
  }

  await runLinkFlow(configPath, config, userConfig.api_url, userConfig.token);
  close();
}

export async function runLinkFlow(
  configPath: string,
  config: ReturnType<typeof findProjectConfig> & {},
  apiUrl: string,
  authToken: string,
): Promise<void> {
  const projectDir = resolve(configPath, "..");
  const projectName = config.project_name ?? "this project";

  // Fetch user's cloud projects and orgs
  let projects: CloudProject[] = [];
  let orgs: UserOrg[] = [];

  try {
    const [projRes, meRes] = await Promise.all([
      fetch(`${apiUrl}/api/v1/projects`, {
        headers: { Authorization: `Bearer ${authToken}` },
      }),
      fetch(`${apiUrl}/api/v1/auth/me`, {
        headers: { Authorization: `Bearer ${authToken}` },
      }),
    ]);

    if (projRes.ok) {
      const data = await projRes.json();
      projects = data.projects ?? [];
    }
    if (meRes.ok) {
      const data = await meRes.json();
      orgs = data.orgs ?? [];
    }
  } catch {
    console.error("Could not reach the Clockwerk API. Try again later.");
    process.exit(1);
  }

  if (orgs.length === 0) {
    console.error("No organizations found. Something went wrong with your account.");
    process.exit(1);
  }

  // Build options: "Create new" + existing projects
  const options = [`Create new project "${projectName}"`, ...projects.map((p) => p.name)];

  const choice = await choose("  Select a cloud project:", options);

  let cloudToken: string;

  if (choice === 0) {
    // Create new project
    let orgId: string;
    if (orgs.length === 1) {
      orgId = orgs[0].id;
    } else {
      const orgChoice = await choose(
        "  Which organization?",
        orgs.map((o) => o.name),
      );
      orgId = orgs[orgChoice].id;
    }

    try {
      const res = await fetch(`${apiUrl}/api/v1/projects`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({ org_id: orgId, name: projectName }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        console.error(`Failed to create project: ${err.error ?? res.statusText}`);
        process.exit(1);
      }

      const data = await res.json();
      cloudToken = data.project.token;
      console.log(`\n  ✓ Created cloud project "${projectName}"`);
    } catch {
      console.error("Failed to create project. Try again later.");
      process.exit(1);
    }
  } else {
    // Use existing project
    cloudToken = projects[choice - 1].token;
    console.log(`\n  ✓ Linked to "${projects[choice - 1].name}"`);
  }

  // Ask privacy preferences
  console.log("\n  What should we sync to the dashboard?\n");
  const syncPaths = await confirm("    File paths", false);
  const syncBranches = await confirm("    Branch names", false);
  const syncDescriptions = await confirm("    Tool descriptions", false);

  // Update config
  config.project_token = cloudToken;
  config.api_url = apiUrl;
  config.privacy = {
    sync_paths: syncPaths,
    sync_branches: syncBranches,
    sync_descriptions: syncDescriptions,
  };

  saveProjectConfig(projectDir, config);
  registerProject({ project_token: cloudToken, directory: projectDir });

  console.log(`\n  ✓ Config updated. Sessions will sync on the next daemon cycle.\n`);
}

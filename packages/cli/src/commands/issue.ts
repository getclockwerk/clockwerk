import {
  getDb,
  findProjectConfig,
  getUserConfig,
  isLocalToken,
  SessionMaterializer,
} from "@clockwerk/core";
import { choose, ask } from "../prompt";
import { success, error, info, pc, spinner } from "../ui";
import { execSync } from "node:child_process";

function getCurrentBranch(): string | null {
  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (branch === "HEAD") return null;
    return branch;
  } catch {
    return null;
  }
}

export default async function issue(args: string[]): Promise<void> {
  const sub = args[0];

  if (sub === "link") {
    await linkIssue(args.slice(1));
  } else if (sub === "unlink") {
    await unlinkIssue();
  } else if (sub === "show" || !sub) {
    await showIssue();
  } else {
    error(`Unknown subcommand: ${sub}`);
    console.log(pc.dim("Usage: clockwerk issue [link|unlink|show]"));
    process.exit(1);
  }
}

interface LinearIssue {
  issueId: string;
  title: string;
  state: string | null;
  url: string;
}

async function fetchAssignedIssues(
  apiUrl: string,
  token: string,
  orgId: string,
  query?: string,
): Promise<LinearIssue[]> {
  const url = new URL(`${apiUrl}/api/v1/integrations/linear/issues`);
  url.searchParams.set("org_id", orgId);
  if (query) {
    url.searchParams.set("q", query);
  } else {
    url.searchParams.set("mine", "1");
  }

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) return [];

  const data = (await res.json()) as { issues?: LinearIssue[] };
  return data.issues ?? [];
}

async function resolveOrgId(
  apiUrl: string,
  token: string,
  projectToken: string,
): Promise<string | null> {
  try {
    const res = await fetch(`${apiUrl}/api/v1/projects`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { projects?: { token: string; orgId: string }[] };
    const project = data.projects?.find((p) => p.token === projectToken);
    return project?.orgId ?? null;
  } catch {
    return null;
  }
}

async function interactiveLink(
  branch: string,
  projectToken: string,
): Promise<{ issueId: string; issueTitle: string | null } | null> {
  const userConfig = getUserConfig();
  if (!userConfig || isLocalToken(projectToken)) return null;

  const orgId = await resolveOrgId(userConfig.api_url, userConfig.token, projectToken);
  if (!orgId) return null;

  const spin = spinner("Fetching your assigned issues...");
  let issues: LinearIssue[];
  try {
    issues = await fetchAssignedIssues(userConfig.api_url, userConfig.token, orgId);
  } catch {
    spin.stop();
    return null;
  }
  spin.stop();

  if (issues.length === 0) {
    info("No assigned issues found. Enter an issue ID manually.");
    const id = await ask("Issue ID (e.g. ENG-123):");
    if (!id) return null;
    const title = await ask("Issue title (optional):");
    return { issueId: id, issueTitle: title || null };
  }

  const options = [
    ...issues.map(
      (i) => `${i.issueId} - ${i.title}${i.state ? pc.dim(` [${i.state}]`) : ""}`,
    ),
    pc.dim("Search for a different issue..."),
    pc.dim("Enter issue ID manually"),
  ];

  const choice = await choose("Select an issue to link:", options);

  if (choice < issues.length) {
    return { issueId: issues[choice].issueId, issueTitle: issues[choice].title };
  }

  if (choice === issues.length) {
    const query = await ask("Search query:");
    if (!query) return null;

    const spin2 = spinner("Searching...");
    let results: LinearIssue[];
    try {
      results = await fetchAssignedIssues(
        userConfig.api_url,
        userConfig.token,
        orgId,
        query,
      );
    } catch {
      spin2.stop();
      return null;
    }
    spin2.stop();

    if (results.length === 0) {
      info("No issues found.");
      return null;
    }

    const resultOptions = results.map(
      (i) => `${i.issueId} - ${i.title}${i.state ? pc.dim(` [${i.state}]`) : ""}`,
    );
    const resultChoice = await choose("Select an issue:", resultOptions);
    return {
      issueId: results[resultChoice].issueId,
      issueTitle: results[resultChoice].title,
    };
  }

  const id = await ask("Issue ID (e.g. ENG-123):");
  if (!id) return null;
  const title = await ask("Issue title (optional):");
  return { issueId: id, issueTitle: title || null };
}

async function linkIssue(args: string[]): Promise<void> {
  const branch = getCurrentBranch();
  if (!branch) {
    error("Not on a branch (detached HEAD). Switch to a branch first.");
    process.exit(1);
  }

  const config = findProjectConfig(process.cwd());
  if (!config) {
    error("Not in a tracked project. Run 'clockwerk init' first.");
    process.exit(1);
  }

  let issueId: string;
  let issueTitle: string | null;

  if (args.length > 0) {
    issueId = args[0];
    issueTitle = args.slice(1).join(" ") || null;
  } else {
    const result = await interactiveLink(branch, config.project_token);
    if (!result) {
      info("No issue selected.");
      return;
    }
    issueId = result.issueId;
    issueTitle = result.issueTitle;
  }

  const db = getDb();

  db.run(
    `INSERT INTO branch_links (project_token, branch, issue_id, issue_title, linked_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(project_token, branch) DO UPDATE SET
       issue_id = excluded.issue_id,
       issue_title = excluded.issue_title,
       linked_at = excluded.linked_at`,
    [config.project_token, branch, issueId, issueTitle, Math.floor(Date.now() / 1000)],
  );

  const result = db.run(
    `UPDATE sessions
     SET issue_id = ?, issue_title = ?, sync_version = sync_version + 1
     WHERE project_token = ? AND branch = ? AND issue_id IS NULL AND deleted_at IS NULL`,
    [issueId, issueTitle, config.project_token, branch],
  );

  const parts = [`Linked branch "${branch}" to ${issueId}`];
  if (result.changes > 0) {
    parts.push(`updated ${result.changes} existing session(s)`);
  }
  success(parts.join(", "));
}

async function unlinkIssue(): Promise<void> {
  const branch = getCurrentBranch();
  if (!branch) {
    error("Not on a branch (detached HEAD).");
    process.exit(1);
  }

  const config = findProjectConfig(process.cwd());
  if (!config) {
    error("Not in a tracked project. Run 'clockwerk init' first.");
    process.exit(1);
  }

  const db = getDb();
  const result = db.run(
    "DELETE FROM branch_links WHERE project_token = ? AND branch = ?",
    [config.project_token, branch],
  );

  if (result.changes > 0) {
    success(`Unlinked branch "${branch}"`);
  } else {
    info(`No link found for branch "${branch}"`);
  }
}

async function showIssue(): Promise<void> {
  const branch = getCurrentBranch();
  if (!branch) {
    error("Not on a branch (detached HEAD).");
    process.exit(1);
  }

  const config = findProjectConfig(process.cwd());
  if (!config) {
    error("Not in a tracked project. Run 'clockwerk init' first.");
    process.exit(1);
  }

  const db = getDb();
  const link = db
    .query<
      { issue_id: string; issue_title: string | null; linked_at: number },
      [string, string]
    >("SELECT issue_id, issue_title, linked_at FROM branch_links WHERE project_token = ? AND branch = ?")
    .get(config.project_token, branch);

  if (!link) {
    const materializer = new SessionMaterializer(db);
    const sessions = materializer.querySessions({ projectToken: config.project_token });
    const branchSession = sessions.find((s) => s.branch === branch && s.issue_id);
    if (branchSession) {
      info(`Branch "${branch}" has issue ${branchSession.issue_id} (from branch name)`);
    } else {
      info(`No issue linked to branch "${branch}"`);
      console.log(pc.dim("  Link one with: clockwerk issue link <issue-id>"));
    }
    return;
  }

  const label = link.issue_title
    ? `${link.issue_id} - ${link.issue_title}`
    : link.issue_id;
  info(`Branch "${branch}" is linked to ${label}`);
}

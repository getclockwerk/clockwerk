import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

function mockDaemon(isRunning: boolean, ensureRunning?: () => Promise<boolean>) {
  return {
    daemon: {
      isRunning: () => isRunning,
      ensureRunning: ensureRunning ?? (async () => true),
      send: async () => true,
      query: async () => null,
      pid: () => null,
      stop: async () => {},
    },
  };
}

// ---------------------------------------------------------------------------
// inferProjectNameFromGit - unit tests
// ---------------------------------------------------------------------------

describe("inferProjectNameFromGit", () => {
  test("returns null when not a git repo", async () => {
    const { inferProjectNameFromGit } = await import("../init");
    const dir = join(tmpdir(), `cw-test-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    try {
      const result = inferProjectNameFromGit(dir);
      expect(result).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("extracts repo name from https remote URL", async () => {
    const { inferProjectNameFromGit } = await import("../init");
    const dir = join(tmpdir(), `cw-test-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    try {
      try {
        execSync("git init", { cwd: dir, stdio: "ignore" });
        execSync("git remote add origin https://github.com/user/my-project.git", {
          cwd: dir,
          stdio: "ignore",
        });
      } catch {
        return; // git not available, skip
      }
      const result = inferProjectNameFromGit(dir);
      expect(result).toBe("my-project");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("extracts repo name from SSH remote URL", async () => {
    const { inferProjectNameFromGit } = await import("../init");
    const dir = join(tmpdir(), `cw-test-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    try {
      try {
        execSync("git init", { cwd: dir, stdio: "ignore" });
        execSync("git remote add origin git@github.com:user/cool-repo.git", {
          cwd: dir,
          stdio: "ignore",
        });
      } catch {
        return; // git not available, skip
      }
      const result = inferProjectNameFromGit(dir);
      expect(result).toBe("cool-repo");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns null when git repo has no remote", async () => {
    const { inferProjectNameFromGit } = await import("../init");
    const dir = join(tmpdir(), `cw-test-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    try {
      try {
        execSync("git init", { cwd: dir, stdio: "ignore" });
      } catch {
        return; // git not available, skip
      }
      const result = inferProjectNameFromGit(dir);
      expect(result).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// URL parsing logic - isolated tests without execSync
// ---------------------------------------------------------------------------

describe("git remote URL parsing", () => {
  function extractRepoName(url: string): string | null {
    const match = url.match(/\/([^/]+?)(?:\.git)?$/);
    return match?.[1] ?? null;
  }

  test("parses https URL with .git suffix", () => {
    expect(extractRepoName("https://github.com/user/my-project.git")).toBe("my-project");
  });

  test("parses https URL without .git suffix", () => {
    expect(extractRepoName("https://github.com/user/my-project")).toBe("my-project");
  });

  test("parses SSH URL with .git suffix", () => {
    expect(extractRepoName("git@github.com:user/my-project.git")).toBe("my-project");
  });

  test("parses SSH URL without .git suffix", () => {
    expect(extractRepoName("git@github.com:user/my-project")).toBe("my-project");
  });

  test("parses GitLab URL with subgroups", () => {
    expect(extractRepoName("https://gitlab.com/org/sub/repo-name.git")).toBe("repo-name");
  });

  test("parses URL with hyphens and numbers", () => {
    expect(extractRepoName("https://github.com/user/cool-app-v2.git")).toBe(
      "cool-app-v2",
    );
  });
});

// ---------------------------------------------------------------------------
// init command - integration tests using temp directories
// ---------------------------------------------------------------------------

describe("init command", () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `cw-init-test-${randomUUID()}`);
    mkdirSync(tmpDir, { recursive: true });
    originalCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tmpDir, { recursive: true, force: true });
    mock.restore();
  });

  test("creates .clockwerk config with correct structure", async () => {
    mock.module("../hook-install", () => ({
      detectTargets: () => [],
      installTarget: () => {},
    }));
    mock.module("../../daemon/client", () => mockDaemon(true));
    mock.module("../../prompt", () => ({
      ask: async (_label: string, def: string) => def,
      confirm: async () => false,
    }));

    const { default: init } = await import("../init");
    await init(["my-project"]);

    const configPath = join(tmpDir, ".clockwerk");
    expect(existsSync(configPath)).toBe(true);

    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(config.version).toBe(1);
    expect(config.project_name).toBe("my-project");
    expect(config.harnesses).toEqual({});
  });

  test("registers project in ~/.clockwerk/projects.json with local token", async () => {
    mock.module("../hook-install", () => ({
      detectTargets: () => [],
      installTarget: () => {},
    }));
    mock.module("../../daemon/client", () => mockDaemon(true));
    mock.module("../../prompt", () => ({
      ask: async (_label: string, def: string) => def,
      confirm: async () => false,
    }));

    const { default: init } = await import("../init");
    await init(["test-project"]);

    const { getProjectRegistry } = await import("@clockwerk/core");
    const registry = getProjectRegistry();
    const entry = registry.find((e) => e.directory === tmpDir);
    expect(entry).toBeDefined();
    expect(entry?.project_token).toBe("local_test-project");
  });

  test("adds .clockwerk to .gitignore", async () => {
    writeFileSync(join(tmpDir, ".gitignore"), "node_modules\n");

    mock.module("../hook-install", () => ({
      detectTargets: () => [],
      installTarget: () => {},
    }));
    mock.module("../../daemon/client", () => mockDaemon(true));
    mock.module("../../prompt", () => ({
      ask: async (_label: string, def: string) => def,
      confirm: async () => false,
    }));

    const { default: init } = await import("../init");
    await init(["my-project"]);

    const gitignore = readFileSync(join(tmpDir, ".gitignore"), "utf-8");
    expect(gitignore).toContain(".clockwerk");
  });

  test("does not duplicate .clockwerk in .gitignore", async () => {
    writeFileSync(join(tmpDir, ".gitignore"), "node_modules\n.clockwerk\n");

    mock.module("../hook-install", () => ({
      detectTargets: () => [],
      installTarget: () => {},
    }));
    mock.module("../../daemon/client", () => mockDaemon(true));
    mock.module("../../prompt", () => ({
      ask: async (_label: string, def: string) => def,
      confirm: async () => false,
    }));

    const { default: init } = await import("../init");
    await init(["my-project"]);

    const gitignore = readFileSync(join(tmpDir, ".gitignore"), "utf-8");
    const lines = gitignore.split("\n").filter((l) => l.trim() === ".clockwerk");
    expect(lines.length).toBe(1);
  });

  test("auto-installs hooks for all detected tools without prompting", async () => {
    const installed: string[] = [];
    mock.module("../hook-install", () => ({
      detectTargets: () => [
        { id: "claude-code", name: "Claude Code" },
        { id: "cursor", name: "Cursor" },
      ],
      installTarget: (target: { id: string }) => {
        installed.push(target.id);
      },
    }));
    mock.module("../../daemon/client", () => mockDaemon(true));
    mock.module("../../prompt", () => ({
      ask: async (_label: string, def: string) => def,
      confirm: async () => {
        throw new Error("confirm should not be called - hooks should auto-install");
      },
    }));

    const { default: init } = await import("../init");
    await init(["my-project"]);

    expect(installed).toContain("claude-code");
    expect(installed).toContain("cursor");

    const config = JSON.parse(readFileSync(join(tmpDir, ".clockwerk"), "utf-8"));
    expect(config.harnesses["claude-code"]).toBe(true);
    expect(config.harnesses["cursor"]).toBe(true);
  });

  test("marks all detected tools in harnesses config", async () => {
    mock.module("../hook-install", () => ({
      detectTargets: () => [{ id: "claude-code", name: "Claude Code" }],
      installTarget: () => {},
    }));
    mock.module("../../daemon/client", () => mockDaemon(true));
    mock.module("../../prompt", () => ({
      ask: async (_label: string, def: string) => def,
      confirm: async () => false,
    }));

    const { default: init } = await import("../init");
    await init(["my-project"]);

    const config = JSON.parse(readFileSync(join(tmpDir, ".clockwerk"), "utf-8"));
    expect(config.harnesses["claude-code"]).toBe(true);
  });

  test("exits with code 1 if already initialized", async () => {
    writeFileSync(
      join(tmpDir, ".clockwerk"),
      JSON.stringify({ version: 1, project_name: "existing", harnesses: {} }),
    );

    mock.module("../hook-install", () => ({
      detectTargets: () => [],
      installTarget: () => {},
    }));
    mock.module("../../daemon/client", () => mockDaemon(false));

    let exitCode: number | undefined;
    const originalExit = process.exit.bind(process);
    process.exit = ((code: number) => {
      exitCode = code;
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit;

    try {
      const { default: init } = await import("../init");
      await init([]);
    } catch {
      // expected from the mocked process.exit
    } finally {
      process.exit = originalExit;
    }

    expect(exitCode).toBe(1);
  });

  test("skips starting daemon when already running", async () => {
    let ensureRunningCalled = false;
    mock.module("../../daemon/client", () =>
      mockDaemon(true, async () => {
        ensureRunningCalled = true;
        return true;
      }),
    );
    mock.module("../hook-install", () => ({
      detectTargets: () => [],
      installTarget: () => {},
    }));
    mock.module("../../prompt", () => ({
      ask: async (_label: string, def: string) => def,
      confirm: async () => false,
    }));

    const { default: init } = await import("../init");
    await init(["my-project"]);

    expect(ensureRunningCalled).toBe(false);
  });
});

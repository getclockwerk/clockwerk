import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { resolveFromEntries, getProjectRegistry, registerProject } from "../config";
import type { ProjectRegistryEntry } from "../types";

describe("resolveFromEntries", () => {
  const registry: ProjectRegistryEntry[] = [
    { project_token: "proj_a", directory: "/home/user/dev/project-a" },
    { project_token: "proj_b", directory: "/home/user/dev/project-b" },
    { project_token: "proj_nested", directory: "/home/user/dev/project-a/packages/core" },
  ];

  test("exact match on directory", () => {
    const result = resolveFromEntries("/home/user/dev/project-a", registry);
    expect(result?.project_token).toBe("proj_a");
  });

  test("matches file nested under project", () => {
    const result = resolveFromEntries("/home/user/dev/project-a/src/index.ts", registry);
    expect(result?.project_token).toBe("proj_a");
  });

  test("picks longest prefix (nested project)", () => {
    const result = resolveFromEntries(
      "/home/user/dev/project-a/packages/core/src/db.ts",
      registry,
    );
    expect(result?.project_token).toBe("proj_nested");
  });

  test("does not match path boundary false positive", () => {
    const result = resolveFromEntries(
      "/home/user/dev/project-a-extra/src/index.ts",
      registry,
    );
    expect(result).toBeNull();
  });

  test("returns null for no match", () => {
    const result = resolveFromEntries("/home/user/other/file.ts", registry);
    expect(result).toBeNull();
  });

  test("returns null for empty registry", () => {
    const result = resolveFromEntries("/home/user/dev/project-a/foo.ts", []);
    expect(result).toBeNull();
  });
});

describe("getProjectRegistry - stale filtering", () => {
  let tmpHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tmpHome = join(tmpdir(), `cw-config-test-${randomUUID()}`);
    mkdirSync(join(tmpHome, ".clockwerk"), { recursive: true });
    originalHome = process.env.HOME;
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test("returns only entries whose directories exist", () => {
    const existingDir = join(tmpHome, "existing-project");
    mkdirSync(existingDir);
    const entries: ProjectRegistryEntry[] = [
      { project_token: "proj_exists", directory: existingDir },
      { project_token: "proj_gone", directory: join(tmpHome, "deleted-project") },
    ];
    writeFileSync(
      join(tmpHome, ".clockwerk", "projects.json"),
      JSON.stringify(entries) + "\n",
    );

    const result = getProjectRegistry();
    expect(result).toHaveLength(1);
    expect(result[0].project_token).toBe("proj_exists");
  });

  test("returns empty array when all entries are stale", () => {
    const entries: ProjectRegistryEntry[] = [
      { project_token: "proj_gone", directory: join(tmpHome, "deleted-project") },
    ];
    writeFileSync(
      join(tmpHome, ".clockwerk", "projects.json"),
      JSON.stringify(entries) + "\n",
    );

    const result = getProjectRegistry();
    expect(result).toHaveLength(0);
  });
});

describe("registerProject - validation", () => {
  let tmpHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tmpHome = join(tmpdir(), `cw-config-test-${randomUUID()}`);
    mkdirSync(join(tmpHome, ".clockwerk"), { recursive: true });
    originalHome = process.env.HOME;
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test("throws when project_token is empty", () => {
    expect(() => registerProject({ project_token: "", directory: tmpHome })).toThrow(
      "Invalid project_token",
    );
  });

  test("throws when directory is a relative path", () => {
    expect(() =>
      registerProject({ project_token: "local_test", directory: "relative/path" }),
    ).toThrow("directory must be an absolute path");
  });

  test("persists valid entry correctly", () => {
    const dir = join(tmpHome, "my-project");
    mkdirSync(dir);
    registerProject({ project_token: "local_test", directory: dir });

    const registry = getProjectRegistry();
    const entry = registry.find((e) => e.directory === dir);
    expect(entry).toBeDefined();
    expect(entry?.project_token).toBe("local_test");
  });
});

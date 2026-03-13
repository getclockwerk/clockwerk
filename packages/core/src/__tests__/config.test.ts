import { describe, test, expect } from "bun:test";
import { resolveProjectFromPath } from "../config";
import type { ProjectRegistryEntry } from "../types";

describe("resolveProjectFromPath", () => {
  const registry: ProjectRegistryEntry[] = [
    { project_token: "proj_a", directory: "/home/user/dev/project-a" },
    { project_token: "proj_b", directory: "/home/user/dev/project-b" },
    { project_token: "proj_nested", directory: "/home/user/dev/project-a/packages/core" },
  ];

  test("exact match on directory", () => {
    const result = resolveProjectFromPath("/home/user/dev/project-a", registry);
    expect(result?.project_token).toBe("proj_a");
  });

  test("matches file nested under project", () => {
    const result = resolveProjectFromPath(
      "/home/user/dev/project-a/src/index.ts",
      registry,
    );
    expect(result?.project_token).toBe("proj_a");
  });

  test("picks longest prefix (nested project)", () => {
    const result = resolveProjectFromPath(
      "/home/user/dev/project-a/packages/core/src/db.ts",
      registry,
    );
    expect(result?.project_token).toBe("proj_nested");
  });

  test("does not match path boundary false positive", () => {
    const result = resolveProjectFromPath(
      "/home/user/dev/project-a-extra/src/index.ts",
      registry,
    );
    expect(result).toBeNull();
  });

  test("returns null for no match", () => {
    const result = resolveProjectFromPath("/home/user/other/file.ts", registry);
    expect(result).toBeNull();
  });

  test("returns null for empty registry", () => {
    const result = resolveProjectFromPath("/home/user/dev/project-a/foo.ts", []);
    expect(result).toBeNull();
  });
});

import {
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
  afterAll,
  mock,
  spyOn,
} from "bun:test";
import * as nodefs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { PluginManager, parseLine } from "../plugin-manager";

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

const VALID_MANIFEST = {
  name: "git-activity",
  version: "1.0.0",
  display_name: "Git Activity",
  description: "Emits an event each time a git ref changes.",
  author: "Clockwerk",
  event_type: "git_commit",
  source: "plugin:git-activity",
  command: "./plugin.sh",
  interval: 5,
  tags: ["git"],
};

const SCRIPT_CONTENT = "#!/bin/sh\nfswatch .git/refs --recursive\n";

// ---------------------------------------------------------------------------
// Helper to create an isolated PluginManager with a temp plugins directory
// ---------------------------------------------------------------------------

function makeManager(pluginsDir: string): PluginManager {
  return new PluginManager({
    fs: nodefs,
    fetch: globalThis.fetch,
    pluginsDir,
  });
}

function makeManagerWithFetch(
  pluginsDir: string,
  mockFetch: typeof globalThis.fetch,
): PluginManager {
  return new PluginManager({
    fs: nodefs,
    fetch: mockFetch,
    pluginsDir,
  });
}

// ---------------------------------------------------------------------------
// parseLine
// ---------------------------------------------------------------------------

describe("parseLine", () => {
  test("parses valid JSON with all fields", () => {
    const line = JSON.stringify({
      description: "file changed",
      file_path: "src/index.ts",
      branch: "main",
      issue_id: "ABC-123",
      topic: "coding",
      tool_name: "watcher",
    });
    const ctx = parseLine(line);
    expect(ctx.description).toBe("file changed");
    expect(ctx.file_path).toBe("src/index.ts");
    expect(ctx.branch).toBe("main");
    expect(ctx.issue_id).toBe("ABC-123");
    expect(ctx.topic).toBe("coding");
    expect(ctx.tool_name).toBe("watcher");
  });

  test("falls back to description for plain text", () => {
    const ctx = parseLine("some plain text output");
    expect(ctx.description).toBe("some plain text output");
    expect(ctx.file_path).toBeUndefined();
  });

  test("falls back to description for invalid JSON", () => {
    const ctx = parseLine("{not valid json");
    expect(ctx.description).toBe("{not valid json");
  });

  test("truncates description to 200 chars", () => {
    const longLine = "x".repeat(300);
    const ctx = parseLine(longLine);
    expect(ctx.description!.length).toBe(200);
  });

  test("uses raw line as description when JSON has no description field", () => {
    const line = JSON.stringify({ file_path: "foo.ts" });
    const ctx = parseLine(line);
    expect(ctx.description).toBe(line);
    expect(ctx.file_path).toBe("foo.ts");
  });

  test("treats JSON array as non-object, uses line as description", () => {
    const line = JSON.stringify([1, 2, 3]);
    const ctx = parseLine(line);
    expect(ctx.description).toBe(line.slice(0, 200));
  });

  test("treats JSON null as non-object", () => {
    const ctx = parseLine("null");
    expect(ctx.description).toBe("null");
  });

  test("parses JSON with partial fields", () => {
    const line = JSON.stringify({ description: "hello" });
    const ctx = parseLine(line);
    expect(ctx.description).toBe("hello");
    expect(ctx.file_path).toBeUndefined();
    expect(ctx.branch).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resolve - plugin resolution
// ---------------------------------------------------------------------------

describe("PluginManager.resolve", () => {
  let pluginsDir: string;
  let manager: PluginManager;

  beforeEach(() => {
    pluginsDir = join(tmpdir(), `cw-pm-resolve-${randomUUID()}`);
    nodefs.mkdirSync(pluginsDir, { recursive: true });
    manager = makeManager(pluginsDir);
  });

  afterEach(() => {
    nodefs.rmSync(pluginsDir, { recursive: true, force: true });
  });

  test("returns null for uninstalled plugin name", () => {
    expect(manager.resolve("nonexistent")).toBeNull();
  });

  test("returns config and cwd for installed registry plugin", () => {
    const dir = join(pluginsDir, "git-activity");
    nodefs.mkdirSync(dir, { recursive: true });
    nodefs.writeFileSync(
      join(dir, "plugin.json"),
      JSON.stringify(VALID_MANIFEST, null, 2) + "\n",
    );

    const result = manager.resolve("git-activity");
    expect(result).not.toBeNull();
    expect(result!.config.name).toBe("git-activity");
    expect(result!.config.event_type).toBe("git_commit");
    expect(result!.config.source).toBe("plugin:git-activity");
    expect(result!.config.command).toBe("./plugin.sh");
    expect(result!.config.interval).toBe(5);
    expect(result!.cwd).toBe(dir);
  });

  test("returns config without interval when manifest has no interval", () => {
    const manifestNoInterval = { ...VALID_MANIFEST };
    delete (manifestNoInterval as Record<string, unknown>)["interval"];
    const dir = join(pluginsDir, "git-activity");
    nodefs.mkdirSync(dir, { recursive: true });
    nodefs.writeFileSync(
      join(dir, "plugin.json"),
      JSON.stringify(manifestNoInterval, null, 2) + "\n",
    );

    const result = manager.resolve("git-activity");
    expect(result).not.toBeNull();
    expect(result!.config.interval).toBeUndefined();
  });

  test("returns null when manifest is malformed JSON", () => {
    const dir = join(pluginsDir, "bad-plugin");
    nodefs.mkdirSync(dir, { recursive: true });
    nodefs.writeFileSync(join(dir, "plugin.json"), "{ not valid json }");

    expect(manager.resolve("bad-plugin")).toBeNull();
  });

  test("returns null when manifest fails schema validation", () => {
    const dir = join(pluginsDir, "bad-schema");
    nodefs.mkdirSync(dir, { recursive: true });
    nodefs.writeFileSync(
      join(dir, "plugin.json"),
      JSON.stringify({ name: "bad-schema" }),
    );

    expect(manager.resolve("bad-schema")).toBeNull();
  });

  test("returns config with empty cwd for inline plugin", () => {
    const inlineConfig = {
      name: "my-plugin",
      command: "echo hello",
      event_type: "manual" as const,
      source: "plugin:my-plugin",
    };
    const result = manager.resolve(inlineConfig);
    expect(result).not.toBeNull();
    expect(result!.config).toBe(inlineConfig);
    expect(result!.cwd).toBe("");
  });
});

// ---------------------------------------------------------------------------
// list - listing installed plugins
// ---------------------------------------------------------------------------

describe("PluginManager.list", () => {
  let pluginsDir: string;
  let manager: PluginManager;

  beforeEach(() => {
    pluginsDir = join(tmpdir(), `cw-pm-list-${randomUUID()}`);
    nodefs.mkdirSync(pluginsDir, { recursive: true });
    manager = makeManager(pluginsDir);
  });

  afterEach(() => {
    nodefs.rmSync(pluginsDir, { recursive: true, force: true });
  });

  test("returns empty array when no plugins installed", () => {
    expect(manager.list(null)).toHaveLength(0);
  });

  test("returns installed registry plugins", () => {
    const dir = join(pluginsDir, "git-activity");
    nodefs.mkdirSync(dir, { recursive: true });
    nodefs.writeFileSync(
      join(dir, "plugin.json"),
      JSON.stringify(VALID_MANIFEST, null, 2) + "\n",
    );

    const list = manager.list(null);
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("git-activity");
    expect(list[0].kind).toBe("registry");
    expect(list[0].manifest?.version).toBe("1.0.0");
  });

  test("skips directories without plugin.json", () => {
    nodefs.mkdirSync(join(pluginsDir, "orphan-dir"), { recursive: true });
    expect(manager.list(null)).toHaveLength(0);
  });

  test("skips directories with malformed plugin.json", () => {
    const dir = join(pluginsDir, "bad-plugin");
    nodefs.mkdirSync(dir, { recursive: true });
    nodefs.writeFileSync(join(dir, "plugin.json"), "{ not valid json }");
    expect(manager.list(null)).toHaveLength(0);
  });

  test("returns multiple installed plugins", () => {
    for (const name of ["git-activity", "ci-monitor"]) {
      const dir = join(pluginsDir, name);
      nodefs.mkdirSync(dir, { recursive: true });
      const manifest = { ...VALID_MANIFEST, name, source: `plugin:${name}` };
      nodefs.writeFileSync(
        join(dir, "plugin.json"),
        JSON.stringify(manifest, null, 2) + "\n",
      );
    }

    const list = manager.list(null);
    expect(list).toHaveLength(2);
    const names = list.map((p) => p.name).sort();
    expect(names).toEqual(["ci-monitor", "git-activity"]);
  });
});

// ---------------------------------------------------------------------------
// remove - removing installed plugins
// ---------------------------------------------------------------------------

describe("PluginManager.remove", () => {
  let pluginsDir: string;
  let manager: PluginManager;

  beforeEach(() => {
    pluginsDir = join(tmpdir(), `cw-pm-remove-${randomUUID()}`);
    nodefs.mkdirSync(pluginsDir, { recursive: true });
    manager = makeManager(pluginsDir);
  });

  afterEach(() => {
    nodefs.rmSync(pluginsDir, { recursive: true, force: true });
  });

  test("removes the plugin directory", () => {
    const dir = join(pluginsDir, "git-activity");
    nodefs.mkdirSync(dir, { recursive: true });
    nodefs.writeFileSync(join(dir, "plugin.json"), JSON.stringify(VALID_MANIFEST) + "\n");

    const result = manager.remove("git-activity", null);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.removedFromDisk).toBe(true);
    expect(nodefs.existsSync(dir)).toBe(false);
  });

  test("returns error when plugin not found", () => {
    const result = manager.remove("nonexistent-plugin", null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("not found");
  });
});

// ---------------------------------------------------------------------------
// checkUpdates - version comparison
// ---------------------------------------------------------------------------

describe("PluginManager.checkUpdates", () => {
  let pluginsDir: string;
  let manager: PluginManager;

  beforeEach(() => {
    pluginsDir = join(tmpdir(), `cw-pm-updates-${randomUUID()}`);
    nodefs.mkdirSync(pluginsDir, { recursive: true });
  });

  afterEach(() => {
    mock.restore();
    nodefs.rmSync(pluginsDir, { recursive: true, force: true });
  });

  test("returns empty array when no plugins installed", async () => {
    manager = makeManager(pluginsDir);
    const results = await manager.checkUpdates();
    expect(results).toHaveLength(0);
  });

  test("detects when installed version matches latest", async () => {
    const dir = join(pluginsDir, "git-activity");
    nodefs.mkdirSync(dir, { recursive: true });
    nodefs.writeFileSync(
      join(dir, "plugin.json"),
      JSON.stringify(VALID_MANIFEST, null, 2) + "\n",
    );

    const mockFetch = mock((_url: string) =>
      Promise.resolve(new Response(JSON.stringify(VALID_MANIFEST), { status: 200 })),
    );
    manager = makeManagerWithFetch(pluginsDir, mockFetch as unknown as typeof fetch);

    const results = await manager.checkUpdates();
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("git-activity");
    expect(results[0].installedVersion).toBe("1.0.0");
    expect(results[0].latestVersion).toBe("1.0.0");
    expect(results[0].hasUpdate).toBe(false);
  });

  test("detects when an update is available", async () => {
    const dir = join(pluginsDir, "git-activity");
    nodefs.mkdirSync(dir, { recursive: true });
    nodefs.writeFileSync(
      join(dir, "plugin.json"),
      JSON.stringify(VALID_MANIFEST, null, 2) + "\n",
    );

    const newerManifest = { ...VALID_MANIFEST, version: "2.0.0" };
    const mockFetch = mock((_url: string) =>
      Promise.resolve(new Response(JSON.stringify(newerManifest), { status: 200 })),
    );
    manager = makeManagerWithFetch(pluginsDir, mockFetch as unknown as typeof fetch);

    const results = await manager.checkUpdates();
    expect(results[0].latestVersion).toBe("2.0.0");
    expect(results[0].hasUpdate).toBe(true);
  });

  test("reports latestVersion as null when fetch fails", async () => {
    const dir = join(pluginsDir, "git-activity");
    nodefs.mkdirSync(dir, { recursive: true });
    nodefs.writeFileSync(
      join(dir, "plugin.json"),
      JSON.stringify(VALID_MANIFEST, null, 2) + "\n",
    );

    const mockFetch = mock(() => Promise.reject(new Error("ECONNREFUSED")));
    manager = makeManagerWithFetch(pluginsDir, mockFetch as unknown as typeof fetch);

    const results = await manager.checkUpdates();
    expect(results[0].latestVersion).toBeNull();
    expect(results[0].hasUpdate).toBe(false);
    expect(results[0].installedVersion).toBe("1.0.0");
  });
});

// ---------------------------------------------------------------------------
// install - fetching and installing from registry
// ---------------------------------------------------------------------------

describe("PluginManager.install", () => {
  let pluginsDir: string;
  let projectDir: string;

  beforeEach(() => {
    const base = join(tmpdir(), `cw-pm-install-${randomUUID()}`);
    pluginsDir = join(base, "plugins");
    projectDir = join(base, "project");
    nodefs.mkdirSync(pluginsDir, { recursive: true });
    nodefs.mkdirSync(projectDir, { recursive: true });
    nodefs.writeFileSync(
      join(projectDir, ".clockwerk"),
      JSON.stringify({ project_token: "test-token" }),
    );
  });

  afterEach(() => {
    mock.restore();
    const base = join(pluginsDir, "..");
    nodefs.rmSync(base, { recursive: true, force: true });
  });

  test("installs plugin files to pluginsDir/<name>/", async () => {
    const mockFetch = mock((url: string) => {
      if ((url as string).endsWith("plugin.json")) {
        return Promise.resolve(
          new Response(JSON.stringify(VALID_MANIFEST), { status: 200 }),
        );
      }
      return Promise.resolve(new Response(SCRIPT_CONTENT, { status: 200 }));
    });

    const manager = makeManagerWithFetch(
      pluginsDir,
      mockFetch as unknown as typeof fetch,
    );
    const result = await manager.install("git-activity", projectDir);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(nodefs.existsSync(join(pluginsDir, "git-activity", "plugin.json"))).toBe(true);
    expect(nodefs.existsSync(join(pluginsDir, "git-activity", "plugin.sh"))).toBe(true);
    expect(result.data.name).toBe("git-activity");
    expect(result.data.version).toBe("1.0.0");
  });

  test("returns error when plugin not found (404)", async () => {
    const mockFetch = mock(() =>
      Promise.resolve(new Response("Not Found", { status: 404 })),
    );

    const manager = makeManagerWithFetch(
      pluginsDir,
      mockFetch as unknown as typeof fetch,
    );
    const result = await manager.install("unknown-plugin", projectDir);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("not found in the Clockwerk registry");
  });

  test("returns error on HTTP failure (non-404)", async () => {
    const mockFetch = mock(() =>
      Promise.resolve(new Response("Internal Server Error", { status: 500 })),
    );

    const manager = makeManagerWithFetch(
      pluginsDir,
      mockFetch as unknown as typeof fetch,
    );
    const result = await manager.install("git-activity", projectDir);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("HTTP 500");
  });

  test("returns error on network failure", async () => {
    const mockFetch = mock(() => Promise.reject(new Error("ECONNREFUSED")));

    const manager = makeManagerWithFetch(
      pluginsDir,
      mockFetch as unknown as typeof fetch,
    );
    const result = await manager.install("git-activity", projectDir);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Network error");
  });

  test("returns error on malformed manifest JSON", async () => {
    const mockFetch = mock((url: string) => {
      if ((url as string).endsWith("plugin.json")) {
        return Promise.resolve(new Response("{ not json }", { status: 200 }));
      }
      return Promise.resolve(new Response(SCRIPT_CONTENT, { status: 200 }));
    });

    const manager = makeManagerWithFetch(
      pluginsDir,
      mockFetch as unknown as typeof fetch,
    );
    const result = await manager.install("git-activity", projectDir);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Malformed manifest");
  });

  test("returns error when manifest fails schema validation", async () => {
    const badManifest = { ...VALID_MANIFEST, version: "not-semver" };
    const mockFetch = mock((url: string) => {
      if ((url as string).endsWith("plugin.json")) {
        return Promise.resolve(
          new Response(JSON.stringify(badManifest), { status: 200 }),
        );
      }
      return Promise.resolve(new Response(SCRIPT_CONTENT, { status: 200 }));
    });

    const manager = makeManagerWithFetch(
      pluginsDir,
      mockFetch as unknown as typeof fetch,
    );
    const result = await manager.install("git-activity", projectDir);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Malformed manifest");
  });

  test("returns error when plugin name is invalid", async () => {
    const manager = makeManager(pluginsDir);
    const result = await manager.install("INVALID NAME!", projectDir);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Invalid plugin name");
  });
});

// ---------------------------------------------------------------------------
// loadUpdateCache / saveUpdateCache
// ---------------------------------------------------------------------------

describe("PluginManager update cache", () => {
  let pluginsDir: string;
  let manager: PluginManager;

  beforeEach(() => {
    const base = join(tmpdir(), `cw-pm-cache-${randomUUID()}`);
    pluginsDir = join(base, "plugins");
    nodefs.mkdirSync(pluginsDir, { recursive: true });
    manager = makeManager(pluginsDir);
  });

  afterEach(() => {
    const base = join(pluginsDir, "..");
    nodefs.rmSync(base, { recursive: true, force: true });
  });

  test("loadUpdateCache returns null when no cache file exists", () => {
    expect(manager.loadUpdateCache()).toBeNull();
  });

  test("saveUpdateCache writes a readable cache file", () => {
    const cache = {
      checkedAt: 1_700_000_000_000,
      updates: [
        { name: "git-activity", installedVersion: "1.0.0", latestVersion: "2.0.0" },
      ],
    };
    manager.saveUpdateCache(cache);

    const loaded = manager.loadUpdateCache();
    expect(loaded).not.toBeNull();
    expect(loaded!.checkedAt).toBe(1_700_000_000_000);
    expect(loaded!.updates).toHaveLength(1);
    expect(loaded!.updates[0].name).toBe("git-activity");
    expect(loaded!.updates[0].latestVersion).toBe("2.0.0");
  });

  test("saveUpdateCache writes empty updates array when no updates", () => {
    manager.saveUpdateCache({ checkedAt: Date.now(), updates: [] });

    const loaded = manager.loadUpdateCache();
    expect(loaded).not.toBeNull();
    expect(loaded!.updates).toHaveLength(0);
  });

  test("loadUpdateCache returns null for malformed cache file", () => {
    const cachePath = join(pluginsDir, "..", "plugin-update-check.json");
    nodefs.writeFileSync(cachePath, "not-json");

    expect(manager.loadUpdateCache()).toBeNull();
  });

  test("round-trips cache data correctly", () => {
    const cache = {
      checkedAt: 1_234_567_890_000,
      updates: [
        { name: "plugin-a", installedVersion: "1.0.0", latestVersion: "1.1.0" },
        { name: "plugin-b", installedVersion: "2.0.0", latestVersion: "2.1.0" },
      ],
    };
    manager.saveUpdateCache(cache);
    const loaded = manager.loadUpdateCache();

    expect(loaded!.checkedAt).toBe(cache.checkedAt);
    expect(loaded!.updates).toHaveLength(2);
    expect(loaded!.updates[1].name).toBe("plugin-b");
  });
});

// Silence unused import warning for spyOn (used in older test patterns)
void spyOn;
void afterAll;

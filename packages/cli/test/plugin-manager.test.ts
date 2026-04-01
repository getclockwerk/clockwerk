import { describe, test, expect, beforeEach } from "bun:test";
import * as nodefs from "node:fs";
import { join } from "node:path";
import { PluginManager } from "../src/plugin-manager";
import type { PluginConfig, ProjectConfig } from "@clockwerk/core";

// ---- Mock fs ----------------------------------------------------------------

type MockStore = Record<string, string>;

function createMockFs(initial: MockStore = {}): {
  mockFs: typeof nodefs;
  store: MockStore;
} {
  const store: MockStore = { ...initial };
  const dirs = new Set<string>();

  const mockFs = {
    existsSync(path: nodefs.PathLike): boolean {
      const p = String(path);
      if (p in store || dirs.has(p)) return true;
      // Return true if any file or dir has this path as a prefix (virtual directory)
      const prefix = p.endsWith("/") ? p : `${p}/`;
      return (
        Object.keys(store).some((k) => k.startsWith(prefix)) ||
        [...dirs].some((d) => d.startsWith(prefix))
      );
    },
    readFileSync(
      path: nodefs.PathOrFileDescriptor,
      _options: nodefs.BufferEncoding | { encoding: nodefs.BufferEncoding },
    ): string {
      const p = String(path);
      if (p in store) return store[p];
      throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
    },
    writeFileSync(
      path: nodefs.PathOrFileDescriptor,
      data: string | NodeJS.ArrayBufferView,
    ): void {
      store[String(path)] = String(data);
    },
    mkdirSync(path: nodefs.PathLike, _options?: unknown): void {
      dirs.add(String(path));
    },
    chmodSync(_path: nodefs.PathLike, _mode: nodefs.Mode): void {
      // no-op
    },
    rmSync(path: nodefs.PathLike, _options?: unknown): void {
      const p = String(path);
      delete store[p];
      dirs.delete(p);
      for (const k of Object.keys(store)) {
        if (k.startsWith(p + "/")) delete store[k];
      }
      for (const d of dirs) {
        if (d.startsWith(p + "/") || d === p) dirs.delete(d);
      }
    },
    readdirSync(path: nodefs.PathLike): string[] {
      const p = String(path);
      const prefix = p.endsWith("/") ? p : p + "/";
      const children = new Set<string>();
      for (const k of [...Object.keys(store), ...dirs]) {
        if (k.startsWith(prefix)) {
          const rest = k.slice(prefix.length);
          const child = rest.split("/")[0];
          if (child) children.add(child);
        }
      }
      return [...children];
    },
  } as unknown as typeof nodefs;

  return { mockFs, store };
}

// ---- Mock fetch -------------------------------------------------------------

type MockRoute = { status: number; body: unknown };

function createMockFetch(routes: Record<string, MockRoute>): typeof globalThis.fetch {
  return async (input: RequestInfo | URL) => {
    const url = String(input);
    const route = routes[url];
    if (!route) {
      return {
        status: 404,
        ok: false,
        json: async () => {
          throw new Error("Not found");
        },
        text: async () => "Not Found",
      } as Response;
    }
    return {
      status: route.status,
      ok: route.status >= 200 && route.status < 300,
      json: async () => route.body,
      text: async () =>
        typeof route.body === "string" ? route.body : JSON.stringify(route.body),
    } as Response;
  };
}

// ---- Test fixtures ----------------------------------------------------------

const PLUGINS_DIR = "/home/test/.clockwerk/plugins";
const PROJECT_DIR = "/home/test/myproject";
const CONFIG_PATH = `${PROJECT_DIR}/.clockwerk`;

const VALID_MANIFEST = {
  name: "git-activity",
  version: "1.0.0",
  display_name: "Git Activity",
  description: "Tracks git activity",
  author: "test",
  event_type: "git_commit",
  source: "plugin:git-activity",
  command: "fswatch .git/refs",
};

const MANIFEST_URL = `https://raw.githubusercontent.com/getclockwerk/clockwerk/main/plugins/git-activity/plugin.json`;
const SCRIPT_URL = `https://raw.githubusercontent.com/getclockwerk/clockwerk/main/plugins/git-activity/plugin.sh`;
const SCRIPT_CONTENT = "#!/bin/sh\necho hello";

function makeProjectConfig(plugins?: ProjectConfig["plugins"]): string {
  const config: ProjectConfig = {
    version: 1,
    project_name: "test-project",
    harnesses: {},
    ...(plugins ? { plugins } : {}),
  };
  return JSON.stringify(config, null, 2) + "\n";
}

function makeManager(
  mockFs: typeof nodefs,
  fetchRoutes: Record<string, MockRoute> = {},
): PluginManager {
  return new PluginManager({
    fs: mockFs,
    fetch: createMockFetch(fetchRoutes),
    pluginsDir: PLUGINS_DIR,
  });
}

// ---- install ----------------------------------------------------------------

describe("PluginManager.install", () => {
  let mockFs: typeof nodefs;
  let store: MockStore;

  beforeEach(() => {
    ({ mockFs, store } = createMockFs({
      [CONFIG_PATH]: makeProjectConfig(),
    }));
  });

  test("successful install writes files and updates config", async () => {
    const manager = makeManager(mockFs, {
      [MANIFEST_URL]: { status: 200, body: VALID_MANIFEST },
      [SCRIPT_URL]: { status: 200, body: SCRIPT_CONTENT },
    });

    const result = await manager.install("git-activity", PROJECT_DIR);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.name).toBe("git-activity");
    expect(result.data.version).toBe("1.0.0");
    expect(result.data.displayName).toBe("Git Activity");

    // Manifest and script written to disk
    const manifestPath = join(PLUGINS_DIR, "git-activity", "plugin.json");
    const scriptPath = join(PLUGINS_DIR, "git-activity", "plugin.sh");
    expect(store[manifestPath]).toContain("git-activity");
    expect(store[scriptPath]).toBe(SCRIPT_CONTENT);

    // Config updated to include plugin
    const updatedConfig = JSON.parse(store[CONFIG_PATH]) as ProjectConfig;
    expect(updatedConfig.plugins).toEqual(["git-activity"]);
  });

  test("idempotent re-install replaces existing entry in config", async () => {
    store[CONFIG_PATH] = makeProjectConfig(["git-activity"]);

    const manager = makeManager(mockFs, {
      [MANIFEST_URL]: { status: 200, body: VALID_MANIFEST },
      [SCRIPT_URL]: { status: 200, body: SCRIPT_CONTENT },
    });

    const result = await manager.install("git-activity", PROJECT_DIR);

    expect(result.ok).toBe(true);
    const updatedConfig = JSON.parse(store[CONFIG_PATH]) as ProjectConfig;
    expect(updatedConfig.plugins?.filter((p) => p === "git-activity").length).toBe(1);
  });

  test("returns error for invalid plugin name", async () => {
    const manager = makeManager(mockFs);

    const result = await manager.install("-bad-name", PROJECT_DIR);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Invalid plugin name");
  });

  test("returns error when project config is missing", async () => {
    delete store[CONFIG_PATH];
    const manager = makeManager(mockFs);

    const result = await manager.install("git-activity", PROJECT_DIR);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("No .clockwerk config");
  });

  test("returns error on network failure", async () => {
    const manager = new PluginManager({
      fs: mockFs,
      fetch: async () => {
        throw new Error("Network unreachable");
      },
      pluginsDir: PLUGINS_DIR,
    });

    const result = await manager.install("git-activity", PROJECT_DIR);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Network error");
  });

  test("returns error when plugin not found in registry (404)", async () => {
    const manager = makeManager(mockFs, {
      [MANIFEST_URL]: { status: 404, body: "Not Found" },
    });

    const result = await manager.install("git-activity", PROJECT_DIR);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("not found in the Clockwerk registry");
  });

  test("returns error when manifest fails schema validation", async () => {
    const manager = makeManager(mockFs, {
      [MANIFEST_URL]: { status: 200, body: { name: "git-activity" } }, // missing required fields
      [SCRIPT_URL]: { status: 200, body: SCRIPT_CONTENT },
    });

    const result = await manager.install("git-activity", PROJECT_DIR);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Malformed manifest");
  });
});

// ---- addInline --------------------------------------------------------------

describe("PluginManager.addInline", () => {
  let mockFs: typeof nodefs;
  let store: MockStore;

  beforeEach(() => {
    ({ mockFs, store } = createMockFs({
      [CONFIG_PATH]: makeProjectConfig(),
    }));
  });

  test("adds valid inline plugin to config", () => {
    const manager = makeManager(mockFs);
    const pluginConfig: PluginConfig = {
      name: "my-plugin",
      command: "tail -f /var/log/app.log",
      event_type: "manual",
      source: "plugin:my-plugin",
    };

    const result = manager.addInline(pluginConfig, PROJECT_DIR);

    expect(result.ok).toBe(true);
    const updatedConfig = JSON.parse(store[CONFIG_PATH]) as ProjectConfig;
    expect(updatedConfig.plugins).toHaveLength(1);
    expect((updatedConfig.plugins![0] as PluginConfig).name).toBe("my-plugin");
  });

  test("returns error for duplicate plugin name", () => {
    const existing: PluginConfig = {
      name: "my-plugin",
      command: "echo old",
      event_type: "manual",
      source: "plugin:my-plugin",
    };
    store[CONFIG_PATH] = makeProjectConfig([existing]);

    const manager = makeManager(mockFs);
    const result = manager.addInline({ ...existing, command: "echo new" }, PROJECT_DIR);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("already exists");
  });

  test("returns error for invalid event type", () => {
    const manager = makeManager(mockFs);
    const pluginConfig = {
      name: "my-plugin",
      command: "echo hello",
      event_type: "invalid_type" as "manual",
      source: "plugin:my-plugin",
    };

    const result = manager.addInline(pluginConfig, PROJECT_DIR);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Invalid event type");
  });

  test("returns error when config is missing", () => {
    const manager = makeManager(mockFs);
    const result = manager.addInline(
      { name: "x", command: "echo", event_type: "manual", source: "plugin:x" },
      "/nonexistent/dir",
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("No .clockwerk config");
  });
});

// ---- remove -----------------------------------------------------------------

describe("PluginManager.remove", () => {
  let mockFs: typeof nodefs;
  let store: MockStore;

  const PLUGIN_MANIFEST = join(PLUGINS_DIR, "git-activity", "plugin.json");
  const PLUGIN_SCRIPT = join(PLUGINS_DIR, "git-activity", "plugin.sh");

  beforeEach(() => {
    ({ mockFs, store } = createMockFs({
      [CONFIG_PATH]: makeProjectConfig(["git-activity"]),
      [PLUGIN_MANIFEST]: JSON.stringify(VALID_MANIFEST),
      [PLUGIN_SCRIPT]: SCRIPT_CONTENT,
    }));
  });

  test("removes from disk and config", () => {
    const manager = makeManager(mockFs);

    const result = manager.remove("git-activity", PROJECT_DIR);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.removedFromDisk).toBe(true);
    expect(result.data.removedFromConfig).toBe(true);

    const updatedConfig = JSON.parse(store[CONFIG_PATH]) as ProjectConfig;
    expect(updatedConfig.plugins).toBeUndefined();
  });

  test("removes from config only (inline plugin, no disk files)", () => {
    const inlinePlugin: PluginConfig = {
      name: "inline-plugin",
      command: "echo hello",
      event_type: "manual",
      source: "plugin:inline-plugin",
    };
    store[CONFIG_PATH] = makeProjectConfig([inlinePlugin]);

    const manager = makeManager(mockFs);
    const result = manager.remove("inline-plugin", PROJECT_DIR);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.removedFromDisk).toBe(false);
    expect(result.data.removedFromConfig).toBe(true);
  });

  test("returns error when plugin not found anywhere", () => {
    const manager = makeManager(mockFs);

    const result = manager.remove("nonexistent", PROJECT_DIR);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("not found");
  });

  test("removes from disk when no project dir provided", () => {
    const manager = makeManager(mockFs);

    const result = manager.remove("git-activity", null);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.removedFromDisk).toBe(true);
    expect(result.data.removedFromConfig).toBe(false);
  });
});

// ---- update -----------------------------------------------------------------

describe("PluginManager.update", () => {
  let mockFs: typeof nodefs;
  let store: MockStore;

  const PLUGIN_MANIFEST_PATH = join(PLUGINS_DIR, "git-activity", "plugin.json");

  beforeEach(() => {
    ({ mockFs, store } = createMockFs({
      [PLUGIN_MANIFEST_PATH]: JSON.stringify(VALID_MANIFEST),
    }));
  });

  test("successful update overwrites disk files", async () => {
    const updatedManifest = { ...VALID_MANIFEST, version: "2.0.0" };
    const manager = makeManager(mockFs, {
      [MANIFEST_URL]: { status: 200, body: updatedManifest },
      [SCRIPT_URL]: { status: 200, body: "#!/bin/sh\necho updated" },
    });

    const result = await manager.update("git-activity");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.version).toBe("2.0.0");
    expect(store[join(PLUGINS_DIR, "git-activity", "plugin.sh")]).toContain("updated");
  });

  test("returns error when plugin is not installed", async () => {
    const manager = makeManager(mockFs);

    const result = await manager.update("not-installed");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("not installed");
  });

  test("returns error on network failure during update", async () => {
    const manager = new PluginManager({
      fs: mockFs,
      fetch: async () => {
        throw new Error("Network unreachable");
      },
      pluginsDir: PLUGINS_DIR,
    });

    const result = await manager.update("git-activity");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Network error");
  });
});

// ---- list -------------------------------------------------------------------

describe("PluginManager.list", () => {
  test("returns empty array when no plugins installed or configured", () => {
    const { mockFs } = createMockFs({
      [CONFIG_PATH]: makeProjectConfig(),
    });
    const manager = makeManager(mockFs);

    expect(manager.list(PROJECT_DIR)).toEqual([]);
  });

  test("returns registry plugin with active status", () => {
    const manifestPath = join(PLUGINS_DIR, "git-activity", "plugin.json");
    const { mockFs } = createMockFs({
      [manifestPath]: JSON.stringify(VALID_MANIFEST),
      [CONFIG_PATH]: makeProjectConfig(["git-activity"]),
    });
    const manager = makeManager(mockFs);

    const plugins = manager.list(PROJECT_DIR);

    expect(plugins).toHaveLength(1);
    expect(plugins[0].kind).toBe("registry");
    expect(plugins[0].name).toBe("git-activity");
    expect(plugins[0].active).toBe(true);
  });

  test("marks registry plugin inactive when not in project config", () => {
    const manifestPath = join(PLUGINS_DIR, "git-activity", "plugin.json");
    const { mockFs } = createMockFs({
      [manifestPath]: JSON.stringify(VALID_MANIFEST),
      [CONFIG_PATH]: makeProjectConfig(),
    });
    const manager = makeManager(mockFs);

    const plugins = manager.list(PROJECT_DIR);

    expect(plugins[0].active).toBe(false);
  });

  test("returns inline plugin from project config", () => {
    const inlinePlugin: PluginConfig = {
      name: "my-watcher",
      command: "fswatch ~/docs",
      event_type: "file_edit",
      source: "plugin:my-watcher",
    };
    const { mockFs } = createMockFs({
      [CONFIG_PATH]: makeProjectConfig([inlinePlugin]),
    });
    const manager = makeManager(mockFs);

    const plugins = manager.list(PROJECT_DIR);

    expect(plugins).toHaveLength(1);
    expect(plugins[0].kind).toBe("inline");
    expect(plugins[0].name).toBe("my-watcher");
    expect(plugins[0].active).toBe(true);
  });

  test("returns mix of registry and inline plugins", () => {
    const manifestPath = join(PLUGINS_DIR, "git-activity", "plugin.json");
    const inlinePlugin: PluginConfig = {
      name: "my-watcher",
      command: "fswatch ~/docs",
      event_type: "file_edit",
      source: "plugin:my-watcher",
    };
    const { mockFs } = createMockFs({
      [manifestPath]: JSON.stringify(VALID_MANIFEST),
      [CONFIG_PATH]: makeProjectConfig(["git-activity", inlinePlugin]),
    });
    const manager = makeManager(mockFs);

    const plugins = manager.list(PROJECT_DIR);

    expect(plugins).toHaveLength(2);
    const kinds = plugins.map((p) => p.kind);
    expect(kinds).toContain("registry");
    expect(kinds).toContain("inline");
  });

  test("works with null projectDir (disk-only listing)", () => {
    const manifestPath = join(PLUGINS_DIR, "git-activity", "plugin.json");
    const { mockFs } = createMockFs({
      [manifestPath]: JSON.stringify(VALID_MANIFEST),
    });
    const manager = makeManager(mockFs);

    const plugins = manager.list(null);

    expect(plugins).toHaveLength(1);
    expect(plugins[0].active).toBe(false);
  });
});

// ---- resolve ----------------------------------------------------------------

describe("PluginManager.resolve", () => {
  test("resolves string entry for installed registry plugin", () => {
    const manifestPath = join(PLUGINS_DIR, "git-activity", "plugin.json");
    const { mockFs } = createMockFs({
      [manifestPath]: JSON.stringify(VALID_MANIFEST),
    });
    const manager = makeManager(mockFs);

    const resolved = manager.resolve("git-activity");

    expect(resolved).not.toBeNull();
    expect(resolved!.config.name).toBe("git-activity");
    expect(resolved!.cwd).toBe(join(PLUGINS_DIR, "git-activity"));
  });

  test("returns null for missing registry plugin", () => {
    const { mockFs } = createMockFs();
    const manager = makeManager(mockFs);

    expect(manager.resolve("not-installed")).toBeNull();
  });

  test("resolves inline PluginConfig entry", () => {
    const { mockFs } = createMockFs();
    const manager = makeManager(mockFs);
    const pluginConfig: PluginConfig = {
      name: "my-plugin",
      command: "echo hello",
      event_type: "manual",
      source: "plugin:my-plugin",
    };

    const resolved = manager.resolve(pluginConfig);

    expect(resolved).not.toBeNull();
    expect(resolved!.config).toEqual(pluginConfig);
    expect(resolved!.cwd).toBe("");
  });
});

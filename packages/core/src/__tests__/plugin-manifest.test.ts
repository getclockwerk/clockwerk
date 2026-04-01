import { describe, test, expect } from "bun:test";
import { PluginManifestSchema } from "../plugin-manifest";

const validManifest = {
  name: "git-activity",
  version: "1.0.0",
  display_name: "Git Activity",
  description: "Emits events when git refs change",
  author: "Clockwerk",
  event_type: "git_commit" as const,
  source: "plugin:git-activity",
  command: "fswatch .git/refs --recursive",
  interval: 5,
  tags: ["git", "vcs"],
};

describe("PluginManifestSchema", () => {
  describe("valid manifests", () => {
    test("parses a complete valid manifest", () => {
      const result = PluginManifestSchema.safeParse(validManifest);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.name).toBe("git-activity");
        expect(result.data.event_type).toBe("git_commit");
        expect(result.data.tags).toEqual(["git", "vcs"]);
      }
    });

    test("parses manifest without optional fields", () => {
      const { interval: _interval, tags: _tags, ...minimal } = validManifest;
      const result = PluginManifestSchema.safeParse(minimal);
      expect(result.success).toBe(true);
    });

    test("accepts all valid event types", () => {
      const types = [
        "tool_call",
        "file_edit",
        "file_read",
        "chat_message",
        "completion_accept",
        "git_commit",
        "manual",
        "heartbeat",
      ] as const;
      for (const event_type of types) {
        const result = PluginManifestSchema.safeParse({ ...validManifest, event_type });
        expect(result.success).toBe(true);
      }
    });

    test("accepts source with colons", () => {
      const result = PluginManifestSchema.safeParse({
        ...validManifest,
        source: "plugin:git-activity",
      });
      expect(result.success).toBe(true);
    });

    test("accepts minimum length name (2 chars)", () => {
      const result = PluginManifestSchema.safeParse({ ...validManifest, name: "ab" });
      expect(result.success).toBe(true);
    });

    test("accepts maximum length name (64 chars)", () => {
      const result = PluginManifestSchema.safeParse({
        ...validManifest,
        name: "a".repeat(64),
      });
      expect(result.success).toBe(true);
    });
  });

  describe("invalid manifests - missing required fields", () => {
    const requiredFields = [
      "name",
      "version",
      "display_name",
      "description",
      "author",
      "event_type",
      "source",
      "command",
    ] as const;

    for (const field of requiredFields) {
      test(`rejects missing ${field}`, () => {
        const manifest = { ...validManifest };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        delete (manifest as any)[field];
        const result = PluginManifestSchema.safeParse(manifest);
        expect(result.success).toBe(false);
      });
    }
  });

  describe("invalid manifests - wrong types", () => {
    test("rejects non-string name", () => {
      const result = PluginManifestSchema.safeParse({ ...validManifest, name: 123 });
      expect(result.success).toBe(false);
    });

    test("rejects non-string command", () => {
      const result = PluginManifestSchema.safeParse({ ...validManifest, command: true });
      expect(result.success).toBe(false);
    });

    test("rejects non-number interval", () => {
      const result = PluginManifestSchema.safeParse({ ...validManifest, interval: "5" });
      expect(result.success).toBe(false);
    });

    test("rejects non-array tags", () => {
      const result = PluginManifestSchema.safeParse({ ...validManifest, tags: "git" });
      expect(result.success).toBe(false);
    });
  });

  describe("invalid manifests - invalid slugs", () => {
    test("rejects name that is too short (1 char)", () => {
      const result = PluginManifestSchema.safeParse({ ...validManifest, name: "a" });
      expect(result.success).toBe(false);
    });

    test("rejects name that is too long (65 chars)", () => {
      const result = PluginManifestSchema.safeParse({
        ...validManifest,
        name: "a".repeat(65),
      });
      expect(result.success).toBe(false);
    });

    test("rejects name with uppercase letters", () => {
      const result = PluginManifestSchema.safeParse({
        ...validManifest,
        name: "MyPlugin",
      });
      expect(result.success).toBe(false);
    });

    test("rejects name with underscores", () => {
      const result = PluginManifestSchema.safeParse({
        ...validManifest,
        name: "my_plugin",
      });
      expect(result.success).toBe(false);
    });

    test("rejects name with leading hyphen", () => {
      const result = PluginManifestSchema.safeParse({
        ...validManifest,
        name: "-plugin",
      });
      expect(result.success).toBe(false);
    });

    test("rejects name with trailing hyphen", () => {
      const result = PluginManifestSchema.safeParse({
        ...validManifest,
        name: "plugin-",
      });
      expect(result.success).toBe(false);
    });

    test("rejects name with spaces", () => {
      const result = PluginManifestSchema.safeParse({
        ...validManifest,
        name: "my plugin",
      });
      expect(result.success).toBe(false);
    });

    test("rejects invalid event type", () => {
      const result = PluginManifestSchema.safeParse({
        ...validManifest,
        event_type: "invalid_type",
      });
      expect(result.success).toBe(false);
    });

    test("rejects invalid version format", () => {
      const result = PluginManifestSchema.safeParse({ ...validManifest, version: "1.0" });
      expect(result.success).toBe(false);
    });

    test("rejects interval less than 1", () => {
      const result = PluginManifestSchema.safeParse({ ...validManifest, interval: 0 });
      expect(result.success).toBe(false);
    });

    test("rejects non-integer interval", () => {
      const result = PluginManifestSchema.safeParse({ ...validManifest, interval: 1.5 });
      expect(result.success).toBe(false);
    });
  });
});

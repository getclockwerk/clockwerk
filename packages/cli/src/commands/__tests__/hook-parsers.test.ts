import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  extractIssueId,
  parseToolArgs,
  extractAbsoluteFilePath,
  parseClaudeCodeHook,
  parseCursorHook,
  parseCopilotHook,
  parseGenericHook,
} from "../hook-parsers";

describe("extractIssueId", () => {
  test("extracts Linear-style ABC-123", () => {
    expect(extractIssueId("feature/ABC-123-add-auth")).toBe("ABC-123");
    expect(extractIssueId("fix/proj-456")).toBe("PROJ-456");
  });

  test("extracts GitHub-style #123 from branch patterns", () => {
    expect(extractIssueId("feature/123-add-auth")).toBe("#123");
    expect(extractIssueId("123_fix-bug")).toBe("#123");
  });

  test("extracts from issue-N pattern", () => {
    expect(extractIssueId("issue-42")).toBe("ISSUE-42");
  });

  test("extracts from gh-N pattern", () => {
    expect(extractIssueId("gh-99")).toBe("GH-99");
  });

  test("returns undefined for branches with no issue ID", () => {
    expect(extractIssueId("main")).toBeUndefined();
    expect(extractIssueId("develop")).toBeUndefined();
  });

  test("Linear-style takes precedence over GitHub-style", () => {
    // ABC-123 matches first
    expect(extractIssueId("ABC-123/456-desc")).toBe("ABC-123");
  });
});

describe("parseToolArgs", () => {
  test("parses JSON string", () => {
    const result = parseToolArgs('{"file_path": "/foo/bar.ts"}');
    expect(result.file_path).toBe("/foo/bar.ts");
  });

  test("passes through object", () => {
    const obj = { command: "ls" };
    const result = parseToolArgs(obj);
    expect(result.command).toBe("ls");
  });

  test("returns empty for invalid JSON string", () => {
    const result = parseToolArgs("not json");
    expect(result).toEqual({});
  });

  test("returns empty for null/undefined", () => {
    expect(parseToolArgs(null)).toEqual({});
    expect(parseToolArgs(undefined)).toEqual({});
  });

  test("returns empty for non-object types", () => {
    expect(parseToolArgs(42)).toEqual({});
    expect(parseToolArgs(true)).toEqual({});
  });
});

describe("extractAbsoluteFilePath", () => {
  test("extracts from Claude Code tool_input.file_path", () => {
    const input = JSON.stringify({
      tool_input: { file_path: "/home/user/project/src/index.ts" },
    });
    expect(extractAbsoluteFilePath(input)).toBe("/home/user/project/src/index.ts");
  });

  test("extracts from Claude Code tool_input.path", () => {
    const input = JSON.stringify({
      tool_input: { path: "/home/user/project/src" },
    });
    expect(extractAbsoluteFilePath(input)).toBe("/home/user/project/src");
  });

  test("extracts from Cursor toolArgs as JSON string", () => {
    const input = JSON.stringify({
      toolArgs: JSON.stringify({ file_path: "/home/user/file.ts" }),
    });
    expect(extractAbsoluteFilePath(input)).toBe("/home/user/file.ts");
  });

  test("extracts from Cursor toolArgs as object", () => {
    const input = JSON.stringify({
      toolArgs: { filePath: "/home/user/file.ts" },
    });
    expect(extractAbsoluteFilePath(input)).toBe("/home/user/file.ts");
  });

  test("returns null for relative paths", () => {
    const input = JSON.stringify({
      tool_input: { file_path: "src/index.ts" },
    });
    expect(extractAbsoluteFilePath(input)).toBeNull();
  });

  test("returns null for invalid JSON", () => {
    expect(extractAbsoluteFilePath("not json")).toBeNull();
  });

  test("returns null when no file path found", () => {
    const input = JSON.stringify({ tool_name: "Bash" });
    expect(extractAbsoluteFilePath(input)).toBeNull();
  });
});

describe("parseClaudeCodeHook", () => {
  test("extracts tool name and session ID", () => {
    const input = JSON.stringify({
      tool_name: "Read",
      session_id: "sess-123",
      tool_input: { file_path: "/project/src/index.ts" },
    });
    const event = parseClaudeCodeHook(input, "proj_test", "/project");
    expect(event.context.tool_name).toBe("Read");
    expect(event.harness_session_id).toBe("sess-123");
    expect(event.source).toBe("claude-code");
    expect(event.project_token).toBe("proj_test");
  });

  test("relativizes file paths against project root", () => {
    const input = JSON.stringify({
      tool_name: "Edit",
      tool_input: { file_path: "/home/user/project/src/db.ts" },
    });
    const event = parseClaudeCodeHook(input, "proj_test", "/home/user/project");
    expect(event.context.file_path).toBe("src/db.ts");
  });

  test("extracts Bash description and sets topic", () => {
    const input = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "npm install", description: "Install deps" },
    });
    const event = parseClaudeCodeHook(input, "proj_test", null);
    expect(event.context.description).toBe("Install deps");
    expect(event.context.topic).toBe("Install deps");
  });

  test("slices description to 200 chars", () => {
    const longDesc = "a".repeat(300);
    const input = JSON.stringify({
      tool_name: "Bash",
      tool_input: { description: longDesc },
    });
    const event = parseClaudeCodeHook(input, "proj_test", null);
    expect(event.context.description!.length).toBe(200);
  });

  test("handles invalid JSON gracefully", () => {
    const event = parseClaudeCodeHook("not json", "proj_test", null);
    expect(event.context.tool_name).toBe("unknown");
    expect(event.source).toBe("claude-code");
  });
});

describe("parseCursorHook", () => {
  test("extracts toolName and conversation_id", () => {
    const input = JSON.stringify({
      toolName: "Shell",
      conversation_id: "conv-456",
      toolArgs: JSON.stringify({ command: "git status" }),
    });
    const event = parseCursorHook(input, "proj_test", null);
    expect(event.context.tool_name).toBe("Shell");
    expect(event.harness_session_id).toBe("conv-456");
    expect(event.source).toBe("cursor");
  });

  test("parses toolArgs from JSON string", () => {
    const input = JSON.stringify({
      toolName: "Edit",
      toolArgs: JSON.stringify({
        file_path: "/home/user/project/src/index.ts",
      }),
    });
    const event = parseCursorHook(input, "proj_test", "/home/user/project");
    expect(event.context.file_path).toBe("src/index.ts");
  });
});

describe("parseCopilotHook", () => {
  test("extracts toolName", () => {
    const input = JSON.stringify({
      toolName: "Read",
      toolArgs: JSON.stringify({ file_path: "/project/file.ts" }),
    });
    const event = parseCopilotHook(input, "proj_test", "/project");
    expect(event.context.tool_name).toBe("Read");
    expect(event.source).toBe("copilot");
    expect(event.context.file_path).toBe("file.ts");
  });

  test("does not set harness_session_id", () => {
    const input = JSON.stringify({ toolName: "Bash" });
    const event = parseCopilotHook(input, "proj_test", null);
    expect(event.harness_session_id).toBeUndefined();
  });
});

describe("CLOCKWERK_SOURCE env var override", () => {
  beforeEach(() => {
    delete process.env.CLOCKWERK_SOURCE;
  });
  afterEach(() => {
    delete process.env.CLOCKWERK_SOURCE;
  });

  test("overrides source in parseClaudeCodeHook when valid", () => {
    process.env.CLOCKWERK_SOURCE = "autonomous";
    const event = parseClaudeCodeHook(
      JSON.stringify({ tool_name: "Read" }),
      "proj_test",
      null,
    );
    expect(event.source).toBe("autonomous");
  });

  test("falls back to default in parseClaudeCodeHook when unset", () => {
    const event = parseClaudeCodeHook(
      JSON.stringify({ tool_name: "Read" }),
      "proj_test",
      null,
    );
    expect(event.source).toBe("claude-code");
  });

  test("falls back to default in parseClaudeCodeHook when invalid", () => {
    process.env.CLOCKWERK_SOURCE = "INVALID SOURCE!";
    const event = parseClaudeCodeHook(
      JSON.stringify({ tool_name: "Read" }),
      "proj_test",
      null,
    );
    expect(event.source).toBe("claude-code");
  });

  test("overrides source in parseCursorHook when valid", () => {
    process.env.CLOCKWERK_SOURCE = "autonomous";
    const event = parseCursorHook(
      JSON.stringify({ toolName: "Shell" }),
      "proj_test",
      null,
    );
    expect(event.source).toBe("autonomous");
  });

  test("falls back to default in parseCursorHook when unset", () => {
    const event = parseCursorHook(
      JSON.stringify({ toolName: "Shell" }),
      "proj_test",
      null,
    );
    expect(event.source).toBe("cursor");
  });

  test("falls back to default in parseCursorHook when invalid", () => {
    process.env.CLOCKWERK_SOURCE = "INVALID SOURCE!";
    const event = parseCursorHook(
      JSON.stringify({ toolName: "Shell" }),
      "proj_test",
      null,
    );
    expect(event.source).toBe("cursor");
  });

  test("overrides source in parseCopilotHook when valid", () => {
    process.env.CLOCKWERK_SOURCE = "autonomous";
    const event = parseCopilotHook(
      JSON.stringify({ toolName: "Bash" }),
      "proj_test",
      null,
    );
    expect(event.source).toBe("autonomous");
  });

  test("falls back to default in parseCopilotHook when unset", () => {
    const event = parseCopilotHook(
      JSON.stringify({ toolName: "Bash" }),
      "proj_test",
      null,
    );
    expect(event.source).toBe("copilot");
  });

  test("falls back to default in parseCopilotHook when invalid", () => {
    process.env.CLOCKWERK_SOURCE = "INVALID SOURCE!";
    const event = parseCopilotHook(
      JSON.stringify({ toolName: "Bash" }),
      "proj_test",
      null,
    );
    expect(event.source).toBe("copilot");
  });

  test("overrides source in parseGenericHook when valid", () => {
    process.env.CLOCKWERK_SOURCE = "autonomous";
    const event = parseGenericHook(
      JSON.stringify({ tool_name: "vim" }),
      "custom-tool",
      "proj_test",
    );
    expect(event.source).toBe("autonomous");
  });

  test("falls back to passed source in parseGenericHook when unset", () => {
    const event = parseGenericHook(
      JSON.stringify({ tool_name: "vim" }),
      "custom-tool",
      "proj_test",
    );
    expect(event.source).toBe("custom-tool");
  });

  test("falls back to passed source in parseGenericHook when invalid", () => {
    process.env.CLOCKWERK_SOURCE = "INVALID SOURCE!";
    const event = parseGenericHook(
      JSON.stringify({ tool_name: "vim" }),
      "custom-tool",
      "proj_test",
    );
    expect(event.source).toBe("custom-tool");
  });
});

describe("parseGenericHook", () => {
  test("extracts all fields from JSON", () => {
    const input = JSON.stringify({
      event_type: "file_edit",
      tool_name: "vim",
      description: "editing file",
      file_path: "src/main.ts",
      branch: "dev",
      issue_id: "ABC-123",
      topic: "editing",
      session_id: "sess-789",
    });
    const event = parseGenericHook(input, "custom-tool", "proj_test");
    expect(event.event_type).toBe("file_edit");
    expect(event.source).toBe("custom-tool");
    expect(event.context.tool_name).toBe("vim");
    expect(event.context.description).toBe("editing file");
    expect(event.context.file_path).toBe("src/main.ts");
    expect(event.context.branch).toBe("dev");
    expect(event.context.issue_id).toBe("ABC-123");
    expect(event.harness_session_id).toBe("sess-789");
  });

  test("defaults event_type to tool_call", () => {
    const input = JSON.stringify({ tool_name: "test" });
    const event = parseGenericHook(input, "custom", "proj_test");
    expect(event.event_type).toBe("tool_call");
  });

  test("handles invalid JSON gracefully", () => {
    const event = parseGenericHook("not json", "custom", "proj_test");
    expect(event.event_type).toBe("tool_call");
    expect(event.source).toBe("custom");
  });
});

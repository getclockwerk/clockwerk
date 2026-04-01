import { describe, test, expect, beforeEach, afterEach, afterAll, mock } from "bun:test";
import * as realCore from "@clockwerk/core";
import * as realHookParsers from "../hook-parsers";
import * as realHookRegistry from "../hook-registry";

// ---------------------------------------------------------------------------
// hook command - daemon interaction
// ---------------------------------------------------------------------------

const FAKE_EVENT = {
  id: "fake-id",
  project_token: "local_test-project",
  event_type: "tool_call" as const,
  source: "claude-code" as const,
  timestamp: 1000000,
  context: { tool_name: "Bash", description: "test" },
};

describe("hook command - daemon interaction", () => {
  let sendCalls: unknown[];

  let originalStdinText: () => Promise<string>;

  beforeEach(() => {
    sendCalls = [];

    // Mock stdin to return a fake Claude Code hook payload
    originalStdinText = Bun.stdin.text.bind(Bun.stdin);
    Bun.stdin.text = async () =>
      JSON.stringify({
        tool_name: "Bash",
        tool_input: { description: "test", command: "ls" },
        session_id: "sess-1",
      });
  });

  afterEach(() => {
    Bun.stdin.text = originalStdinText;
    mock.restore();
  });

  test("sends event to daemon", async () => {
    mock.module("../../daemon/client", () => ({
      daemon: {
        send: async (event: unknown) => {
          sendCalls.push(event);
          return true;
        },
      },
    }));
    mock.module("@clockwerk/core", () => ({
      findProjectConfig: () => ({ project_name: "test" }),
      findProjectRoot: () => "/fake/project",
      getProjectRegistry: () => [
        { directory: "/fake/project", project_token: "local_test-project" },
      ],
      resolveFromEntries: () => ({
        directory: "/fake/project",
        project_token: "local_test-project",
      }),
    }));
    mock.module("../hook-parsers", () => ({
      parseClaudeCodeHook: () => FAKE_EVENT,
      parseGenericHook: () => FAKE_EVENT,
      extractAbsoluteFilePath: () => null,
      extractGitInfo: () => ({ branch: "main", issueId: null }),
    }));
    mock.module("../hook-registry", () => ({
      getTool: () => ({
        id: "claude-code",
        name: "Claude Code",
        detectPath: "~/.claude",
        configPath: "~/.claude/settings.json",
        parse: () => FAKE_EVENT,
      }),
      parseStandardHook: () => FAKE_EVENT,
      getTools: () => [],
      detectTools: () => [],
      registerTool: () => {},
      installTool: () => {},
    }));

    const { default: hook } = await import("../hook");
    await hook(["claude-code"]);

    expect(sendCalls.length).toBe(1);
  });

  test("exits silently without sending when not in a tracked project", async () => {
    mock.module("../../daemon/client", () => ({
      daemon: {
        send: async (event: unknown) => {
          sendCalls.push(event);
          return true;
        },
      },
    }));
    mock.module("@clockwerk/core", () => ({
      findProjectConfig: () => null, // not in a tracked project
      findProjectRoot: () => null,
      getProjectRegistry: () => [],
      resolveFromEntries: () => null,
    }));
    mock.module("../hook-parsers", () => ({
      parseClaudeCodeHook: () => FAKE_EVENT,
      parseGenericHook: () => FAKE_EVENT,
      extractAbsoluteFilePath: () => null,
      extractGitInfo: () => ({ branch: "main", issueId: null }),
    }));
    mock.module("../hook-registry", () => ({
      getTool: () => undefined,
      parseStandardHook: () => FAKE_EVENT,
      getTools: () => [],
      detectTools: () => [],
      registerTool: () => {},
      installTool: () => {},
    }));

    const { default: hook } = await import("../hook");
    await hook(["claude-code"]);

    expect(sendCalls.length).toBe(0);
  });

  test("calls daemon.send once per hook invocation", async () => {
    mock.module("../../daemon/client", () => ({
      daemon: {
        send: async (event: unknown) => {
          sendCalls.push(event);
          return true;
        },
      },
    }));
    mock.module("@clockwerk/core", () => ({
      findProjectConfig: () => ({ project_name: "test" }),
      findProjectRoot: () => "/fake/project",
      getProjectRegistry: () => [
        { directory: "/fake/project", project_token: "local_test-project" },
      ],
      resolveFromEntries: () => ({
        directory: "/fake/project",
        project_token: "local_test-project",
      }),
    }));
    mock.module("../hook-parsers", () => ({
      parseClaudeCodeHook: () => FAKE_EVENT,
      parseGenericHook: () => FAKE_EVENT,
      extractAbsoluteFilePath: () => null,
      extractGitInfo: () => ({ branch: "main", issueId: null }),
    }));
    mock.module("../hook-registry", () => ({
      getTool: () => ({
        id: "claude-code",
        name: "Claude Code",
        detectPath: "~/.claude",
        configPath: "~/.claude/settings.json",
        parse: () => FAKE_EVENT,
      }),
      parseStandardHook: () => FAKE_EVENT,
      getTools: () => [],
      detectTools: () => [],
      registerTool: () => {},
      installTool: () => {},
    }));

    const { default: hook } = await import("../hook");
    await hook(["claude-code"]);
    await hook(["claude-code"]);
    await hook(["claude-code"]);

    expect(sendCalls.length).toBe(3);
  });
});

// mock.module() is not undone by mock.restore(), so explicitly reset all mocked modules
// after all hook tests to prevent leaking into other test files.
afterAll(() => {
  mock.module("@clockwerk/core", () => realCore);
  mock.module("../hook-parsers", () => realHookParsers);
  mock.module("../hook-registry", () => realHookRegistry);
});

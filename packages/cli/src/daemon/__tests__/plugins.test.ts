import { describe, test, expect } from "bun:test";
import { parseLine } from "../../plugin-manager";

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
    // Should default description to the raw line
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

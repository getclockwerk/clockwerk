import { describe, test, expect } from "bun:test";
import { isValidSource } from "../types";

describe("isValidSource", () => {
  test("accepts valid slugs", () => {
    expect(isValidSource("claude-code")).toBe(true);
    expect(isValidSource("cursor")).toBe(true);
    expect(isValidSource("copilot")).toBe(true);
    expect(isValidSource("ab")).toBe(true);
    expect(isValidSource("my-tool:v2")).toBe(true);
    expect(isValidSource("file-watch")).toBe(true);
  });

  test("rejects too short", () => {
    expect(isValidSource("")).toBe(false);
    expect(isValidSource("a")).toBe(false);
  });

  test("rejects too long", () => {
    expect(isValidSource("a".repeat(65))).toBe(false);
  });

  test("accepts max length", () => {
    expect(isValidSource("a".repeat(64))).toBe(true);
  });

  test("rejects invalid characters", () => {
    expect(isValidSource("CLAUDE")).toBe(false);
    expect(isValidSource("has space")).toBe(false);
    expect(isValidSource("under_score")).toBe(false);
    expect(isValidSource("dot.dot")).toBe(false);
    expect(isValidSource("-leading")).toBe(false);
    expect(isValidSource("trailing-")).toBe(false);
  });
});

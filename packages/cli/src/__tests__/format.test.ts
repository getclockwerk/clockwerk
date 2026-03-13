import { describe, test, expect } from "bun:test";
import { formatDuration } from "../format";

describe("formatDuration", () => {
  test("returns 0m for zero seconds", () => {
    expect(formatDuration(0)).toBe("0m");
  });

  test("returns minutes only when under an hour", () => {
    expect(formatDuration(60)).toBe("1m");
    expect(formatDuration(300)).toBe("5m");
    expect(formatDuration(2700)).toBe("45m");
  });

  test("returns hours and minutes", () => {
    expect(formatDuration(3600)).toBe("1h 0m");
    expect(formatDuration(5400)).toBe("1h 30m");
    expect(formatDuration(7200)).toBe("2h 0m");
    expect(formatDuration(7260)).toBe("2h 1m");
  });

  test("truncates partial minutes", () => {
    expect(formatDuration(90)).toBe("1m"); // 1.5 min -> 1m
    expect(formatDuration(3659)).toBe("0h 60m".includes("h") ? "1h 0m" : "60m");
    // 59 seconds = 0 minutes
    expect(formatDuration(59)).toBe("0m");
  });
});

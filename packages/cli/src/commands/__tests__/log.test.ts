import { describe, test, expect } from "bun:test";
import { parseDuration } from "../log";

describe("parseDuration", () => {
  test("parses hours and minutes", () => {
    expect(parseDuration("1h30m")).toBe(5400);
    expect(parseDuration("2h15m")).toBe(8100);
  });

  test("parses hours only", () => {
    expect(parseDuration("2h")).toBe(7200);
    expect(parseDuration("1h")).toBe(3600);
  });

  test("parses minutes only", () => {
    expect(parseDuration("45m")).toBe(2700);
    expect(parseDuration("5m")).toBe(300);
  });

  test("parses plain number as minutes", () => {
    expect(parseDuration("30")).toBe(1800);
    expect(parseDuration("90")).toBe(5400);
  });

  test("returns 0 for invalid input", () => {
    expect(parseDuration("abc")).toBe(0);
    expect(parseDuration("")).toBe(0);
  });

  test("handles 0h0m", () => {
    expect(parseDuration("0h0m")).toBe(0);
    expect(parseDuration("0m")).toBe(0);
  });
});

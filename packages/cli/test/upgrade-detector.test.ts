import { describe, test, expect } from "bun:test";
import { createUpgradeDetector } from "../src/daemon/upgrade-detector";

describe("createUpgradeDetector", () => {
  test("returns start and stop functions", () => {
    const detector = createUpgradeDetector({
      onUpgradeDetected: () => {},
    });
    expect(typeof detector.start).toBe("function");
    expect(typeof detector.stop).toBe("function");
  });

  test("stop is safe to call before start", () => {
    const detector = createUpgradeDetector({
      onUpgradeDetected: () => {},
    });
    // Should not throw
    detector.stop();
  });

  test("stop is safe to call multiple times", () => {
    const detector = createUpgradeDetector({
      onUpgradeDetected: () => {},
    });
    detector.start();
    detector.stop();
    detector.stop();
  });

  test("does not call onUpgradeDetected immediately after start", () => {
    let called = false;
    const detector = createUpgradeDetector({
      checkIntervalMs: 100_000,
      onUpgradeDetected: () => {
        called = true;
      },
    });
    detector.start();
    detector.stop();
    expect(called).toBe(false);
  });

  test("uses default checkIntervalMs when not specified", () => {
    // Just verifies construction and start/stop without error
    const detector = createUpgradeDetector({
      onUpgradeDetected: () => {},
    });
    detector.start();
    detector.stop();
  });

  test("does not fire when binary mtime is unchanged", () => {
    let callCount = 0;
    const detector = createUpgradeDetector({
      checkIntervalMs: 20,
      onUpgradeDetected: () => {
        callCount++;
      },
    });
    detector.start();

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        detector.stop();
        // mtime hasn't changed, so should not have been called
        expect(callCount).toBe(0);
        resolve();
      }, 80);
    });
  });

  test("start is a no-op when running from source", () => {
    // When running under bun test, process.argv[1] is a .ts file
    // so isRunningFromSource() returns true and start() should skip polling
    let called = false;
    const detector = createUpgradeDetector({
      checkIntervalMs: 10,
      onUpgradeDetected: () => {
        called = true;
      },
    });
    detector.start();

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        detector.stop();
        expect(called).toBe(false);
        resolve();
      }, 50);
    });
  });
});

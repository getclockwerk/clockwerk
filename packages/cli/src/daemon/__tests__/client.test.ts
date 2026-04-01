import { describe, test, expect } from "bun:test";
import { createDaemonClient, DaemonNotRunningError } from "../client";

// ---------------------------------------------------------------------------
// DaemonClient facade - unit tests
// ---------------------------------------------------------------------------

const FAKE_PID = 99999;
const FAKE_PID_PATH = "/fake/.clockwerk/daemon.pid";
const FAKE_SOCKET_PATH = "/fake/.clockwerk/daemon.sock";

function baseDeps() {
  return {
    existsSync: (_p: string) => false,
    readFileSync: (_p: string, _e: "utf-8"): string => {
      throw new Error("no file");
    },
    unlinkSync: (_p: string) => {},
    spawn: (() => ({ unref: () => {} })) as never,
    getDaemonPidPath: () => FAKE_PID_PATH,
    getDaemonSocketPath: () => FAKE_SOCKET_PATH,
    sendEvent: async () => true,
    queryDaemon: async () => ({ data: null }),
  };
}

// ---------------------------------------------------------------------------
// isRunning()
// ---------------------------------------------------------------------------

describe("daemon.isRunning()", () => {
  test("returns false when no PID file exists", () => {
    const daemon = createDaemonClient(baseDeps());
    expect(daemon.isRunning()).toBe(false);
  });

  test("returns true when PID file exists and process is alive", () => {
    const deps = {
      ...baseDeps(),
      existsSync: (p: string) => p === FAKE_PID_PATH,
      readFileSync: (_p: string, _e: "utf-8") => FAKE_PID.toString(),
    };

    const originalKill = process.kill.bind(process);
    // @ts-expect-error - replacing for test purposes
    process.kill = (pid: number, signal: number | string) => {
      if (signal === 0 && pid === FAKE_PID) return;
      throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    };

    try {
      const daemon = createDaemonClient(deps);
      expect(daemon.isRunning()).toBe(true);
    } finally {
      process.kill = originalKill;
    }
  });

  test("returns false and cleans up stale PID file when process is gone", () => {
    let unlinked = false;
    const deps = {
      ...baseDeps(),
      existsSync: () => true,
      readFileSync: (_p: string, _e: "utf-8") => FAKE_PID.toString(),
      unlinkSync: (_p: string) => {
        unlinked = true;
      },
    };

    const originalKill = process.kill.bind(process);
    process.kill = (_pid: number, _signal: number | string) => {
      throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    };

    try {
      const daemon = createDaemonClient(deps);
      expect(daemon.isRunning()).toBe(false);
      expect(unlinked).toBe(true);
    } finally {
      process.kill = originalKill;
    }
  });
});

// ---------------------------------------------------------------------------
// pid()
// ---------------------------------------------------------------------------

describe("daemon.pid()", () => {
  test("returns null when no PID file exists", () => {
    const daemon = createDaemonClient(baseDeps());
    expect(daemon.pid()).toBeNull();
  });

  test("returns PID number from file", () => {
    const deps = {
      ...baseDeps(),
      existsSync: () => true,
      readFileSync: (_p: string, _e: "utf-8") => FAKE_PID.toString(),
    };
    const daemon = createDaemonClient(deps);
    expect(daemon.pid()).toBe(FAKE_PID);
  });
});

// ---------------------------------------------------------------------------
// send()
// ---------------------------------------------------------------------------

describe("daemon.send()", () => {
  test("delivers event when daemon is running, returns true", async () => {
    let sendEventCalled = false;
    const deps = {
      ...baseDeps(),
      existsSync: () => true,
      readFileSync: (_p: string, _e: "utf-8") => FAKE_PID.toString(),
      sendEvent: async () => {
        sendEventCalled = true;
        return true;
      },
    };

    const originalKill = process.kill.bind(process);
    // @ts-expect-error - replacing for test purposes
    process.kill = (_pid: number, _signal: number | string) => {};

    try {
      const daemon = createDaemonClient(deps);
      const fakeEvent = { id: "e1", timestamp: Math.floor(Date.now() / 1000) } as never;
      const result = await daemon.send(fakeEvent);
      expect(result).toBe(true);
      expect(sendEventCalled).toBe(true);
    } finally {
      process.kill = originalKill;
    }
  });

  test("throws DaemonNotRunningError when daemon is down and whenDown is 'require'", async () => {
    const daemon = createDaemonClient(baseDeps());
    const fakeEvent = { id: "e1" } as never;
    await expect(daemon.send(fakeEvent, { whenDown: "require" })).rejects.toBeInstanceOf(
      DaemonNotRunningError,
    );
  });

  test("returns false when daemon is down and whenDown is 'skip'", async () => {
    const daemon = createDaemonClient(baseDeps());
    const fakeEvent = { id: "e1" } as never;
    const result = await daemon.send(fakeEvent, { whenDown: "skip" });
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// query()
// ---------------------------------------------------------------------------

describe("daemon.query()", () => {
  test("throws DaemonNotRunningError by default when daemon is down", async () => {
    const daemon = createDaemonClient(baseDeps());
    await expect(daemon.query("sessions")).rejects.toBeInstanceOf(DaemonNotRunningError);
  });

  test("returns null when daemon is down and whenDown is 'skip'", async () => {
    const daemon = createDaemonClient(baseDeps());
    const result = await daemon.query("sessions", {}, { whenDown: "skip" });
    expect(result).toBeNull();
  });

  test("returns data when daemon is running", async () => {
    const fakeData = { sessions: [], total_seconds: 0 };
    const deps = {
      ...baseDeps(),
      existsSync: () => true,
      readFileSync: (_p: string, _e: "utf-8") => FAKE_PID.toString(),
      queryDaemon: async () => ({ data: fakeData }),
    };

    const originalKill = process.kill.bind(process);
    // @ts-expect-error - replacing for test purposes
    process.kill = (_pid: number, _signal: number | string) => {};

    try {
      const daemon = createDaemonClient(deps);
      const result = await daemon.query<typeof fakeData>("sessions");
      expect(result).toEqual(fakeData);
    } finally {
      process.kill = originalKill;
    }
  });
});

// ---------------------------------------------------------------------------
// ensureRunning()
// ---------------------------------------------------------------------------

describe("daemon.ensureRunning()", () => {
  test("returns true immediately when daemon is already running", async () => {
    const deps = {
      ...baseDeps(),
      existsSync: () => true,
      readFileSync: (_p: string, _e: "utf-8") => FAKE_PID.toString(),
      spawn: (() => {
        throw new Error("spawn should not be called when already running");
      }) as never,
    };

    const originalKill = process.kill.bind(process);
    // @ts-expect-error - replacing for test purposes
    process.kill = (_pid: number, _signal: number | string) => {};

    try {
      const daemon = createDaemonClient(deps);
      const result = await daemon.ensureRunning();
      expect(result).toBe(true);
    } finally {
      process.kill = originalKill;
    }
  });
});

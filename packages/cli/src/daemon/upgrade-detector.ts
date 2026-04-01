import { statSync } from "node:fs";

export interface UpgradeDetectorOpts {
  checkIntervalMs?: number;
  onUpgradeDetected: () => void;
}

export interface UpgradeDetector {
  start(): void;
  stop(): void;
}

function isRunningFromSource(): boolean {
  const scriptPath = process.argv[1];
  return Boolean(scriptPath?.match(/\.[tj]sx?$/));
}

function getBinaryMtime(): number | null {
  try {
    return statSync(process.execPath).mtimeMs;
  } catch {
    return null;
  }
}

export function createUpgradeDetector(opts: UpgradeDetectorOpts): UpgradeDetector {
  const { checkIntervalMs = 30_000, onUpgradeDetected } = opts;

  let timer: ReturnType<typeof setInterval> | null = null;
  let initialMtime: number | null = null;

  function start(): void {
    if (isRunningFromSource()) return;

    initialMtime = getBinaryMtime();
    if (initialMtime === null) return;

    timer = setInterval(() => {
      const currentMtime = getBinaryMtime();
      if (currentMtime !== null && currentMtime !== initialMtime) {
        onUpgradeDetected();
      }
    }, checkIntervalMs);
  }

  function stop(): void {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  return { start, stop };
}

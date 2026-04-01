export interface Commit {
  hash: string;
  message: string;
  ts: number;
}

/**
 * Fetch git commits within a time range for a given directory.
 * Returns commits in chronological order.
 */
export function getCommitsInRange(
  projectDir: string,
  sinceTs: number,
  untilTs: number,
): Commit[] {
  try {
    const result = Bun.spawnSync(
      [
        "git",
        "-C",
        projectDir,
        "log",
        "--all",
        `--since=${sinceTs}`,
        `--until=${untilTs}`,
        "--format=%H|%s|%ct",
        "--no-merges",
      ],
      { stdout: "pipe", stderr: "ignore" },
    );

    const output = result.stdout.toString().trim();
    if (!output) return [];

    return output
      .split("\n")
      .map((line) => {
        const [hash, message, ts] = line.split("|");
        if (!hash || !message || !ts) return null;
        return { hash: hash.slice(0, 8), message, ts: Number(ts) };
      })
      .filter((c): c is Commit => c !== null)
      .sort((a, b) => a.ts - b.ts);
  } catch {
    return [];
  }
}

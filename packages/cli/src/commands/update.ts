const REPO = "getclockwerk/clockwerk";

export default async function update(): Promise<void> {
  // Detect platform
  const platform = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const artifact = `clockwerk-${platform}-${arch}`;

  // Find where the current binary lives
  const binaryPath = process.execPath;

  // Get latest version
  process.stdout.write("Checking for updates...");
  let version: string;
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`);
    if (!res.ok) throw new Error(`GitHub API returned ${res.status}`);
    const data = (await res.json()) as { tag_name: string };
    version = data.tag_name;
  } catch {
    console.error("\nFailed to check for updates.");
    process.exit(1);
  }

  console.log(` found ${version}`);

  // Download new binary
  const url = `https://github.com/${REPO}/releases/download/${version}/${artifact}`;
  console.log(`Downloading ${artifact}...`);

  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    console.error(`Download failed: ${res.status} ${res.statusText}`);
    process.exit(1);
  }

  const bytes = new Uint8Array(await res.arrayBuffer());

  // Write to a temp file next to the binary, then swap
  const tmpPath = `${binaryPath}.update`;
  const { writeFileSync, renameSync, chmodSync } = await import("node:fs");

  try {
    writeFileSync(tmpPath, bytes);
    chmodSync(tmpPath, 0o755);
    renameSync(tmpPath, binaryPath);
  } catch {
    // Probably a permissions issue — try with sudo hint
    const { unlinkSync } = await import("node:fs");
    try {
      unlinkSync(tmpPath);
    } catch {
      /* best effort cleanup */
    }

    console.error(`\nFailed to write to ${binaryPath}`);
    console.error("Try running: sudo clockwerk update");
    process.exit(1);
  }

  console.log(`Updated to ${version}`);
}

import {
  saveUserConfig,
  getUserConfig,
  findProjectConfig,
  findProjectConfigPath,
  isLocalToken,
} from "@clockwerk/core";
import { spawn } from "node:child_process";
import { confirm, close } from "../prompt";
import { runLinkFlow } from "./link";

const DEFAULT_API_URL = "https://getclockwerk.com";
const POLL_INTERVAL_MS = 2_000;
const MAX_POLL_ATTEMPTS = 150; // 5 minutes at 2s intervals

/**
 * clockwerk login
 *
 * Device authorization flow:
 * 1. Request a device code from the server
 * 2. Open browser to approval page
 * 3. Poll until approved, then save the token
 * 4. If in a local-only project, offer to link it
 */
export default async function login(args: string[]): Promise<void> {
  const apiUrl = args.includes("--api")
    ? args[args.indexOf("--api") + 1]
    : DEFAULT_API_URL;

  const existing = getUserConfig();
  if (existing) {
    console.log(`Already logged in as ${existing.email}.`);
    console.log(`Run 'clockwerk logout' to switch accounts.`);
    return;
  }

  // Step 1: Request device code
  console.log("Requesting device code...");
  let code: string;
  let verificationUrl: string;

  try {
    const res = await fetch(`${apiUrl}/api/v1/auth/device-code`, {
      method: "POST",
    });

    if (!res.ok) {
      console.error(`Failed to get device code: ${res.status} ${res.statusText}`);
      process.exit(1);
    }

    const data = await res.json();
    code = data.code;
    verificationUrl = data.verification_url;
  } catch {
    console.error(`Cannot reach ${apiUrl}. Is the server running?`);
    process.exit(1);
  }

  // Step 2: Open browser
  const fullUrl = `${verificationUrl}?code=${code}`;
  console.log(`\nOpening browser to: ${fullUrl}`);
  console.log(`If it didn't open, visit: ${fullUrl}\n`);

  tryOpenBrowser(fullUrl);

  // Step 3: Poll for approval
  process.stdout.write("Waiting for approval...");

  for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    try {
      const res = await fetch(`${apiUrl}/api/v1/auth/poll?code=${code}`, {
        method: "POST",
      });

      if (res.status === 202) {
        process.stdout.write(".");
        continue;
      }

      if (res.status === 410) {
        console.log("\nDevice code expired. Run 'clockwerk login' again.");
        process.exit(1);
      }

      if (res.ok) {
        const data = await res.json();
        if (data.status === "approved" && data.token) {
          // Fetch user info
          const userRes = await fetch(`${apiUrl}/api/v1/auth/me`, {
            headers: { Authorization: `Bearer ${data.token}` },
          });

          let email = "unknown";
          if (userRes.ok) {
            const userData = await userRes.json();
            email = userData.email;
          }

          saveUserConfig({
            user_id: data.user_id,
            email,
            token: data.token,
            api_url: apiUrl,
          });

          console.log(` ✓\n`);
          console.log(`Logged in as ${email}`);

          // Check if current directory has a local-only project
          await maybeOfferLink(apiUrl, data.token);

          close();
          return;
        }
      }
    } catch {
      // Network error — keep polling
      process.stdout.write(".");
    }
  }

  console.log("\nTimed out waiting for approval. Run 'clockwerk login' again.");
  process.exit(1);
}

async function maybeOfferLink(apiUrl: string, authToken: string): Promise<void> {
  const cwd = process.cwd();
  const configPath = findProjectConfigPath(cwd);
  const config = findProjectConfig(cwd);

  if (!config || !configPath || !isLocalToken(config.project_token)) {
    return;
  }

  const name = config.project_name ?? "this project";
  console.log(`\n  "${name}" is tracking locally.`);
  const shouldLink = await confirm("  Want to sync it to the cloud?");

  if (!shouldLink) {
    console.log(`\n  No problem! Run 'clockwerk link' anytime to connect later.\n`);
    return;
  }

  await runLinkFlow(configPath, config, apiUrl, authToken);
}

function tryOpenBrowser(url: string): void {
  try {
    const platform = process.platform;
    if (platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else if (platform === "linux") {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    } else if (platform === "win32") {
      spawn("cmd", ["/c", "start", url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch {
    // Browser open failed silently — user has the URL printed
  }
}

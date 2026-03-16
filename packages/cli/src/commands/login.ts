import {
  saveUserConfig,
  getUserConfig,
  findProjectConfig,
  findProjectConfigPath,
  isLocalToken,
} from "@clockwerk/core";
import { spawn } from "node:child_process";
import { confirm } from "../prompt";
import { runLinkFlow } from "./link";
import { error, info, dim, spinner, pc } from "../ui";

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
export default async function login(_args: string[]): Promise<void> {
  const apiUrl = process.env.CLOCKWERK_API_URL || DEFAULT_API_URL;

  const existing = getUserConfig();
  if (existing) {
    info(`Already logged in as ${pc.bold(existing.email)}`);
    dim("Run 'clockwerk logout' to switch accounts.");
    return;
  }

  // Step 1: Request device code
  let code: string;
  let verificationUrl: string;

  const codeSpinner = spinner("Requesting device code");

  try {
    const res = await fetch(`${apiUrl}/api/v1/auth/device-code`, {
      method: "POST",
    });

    if (!res.ok) {
      codeSpinner.stop();
      error(`Failed to get device code: ${res.status} ${res.statusText}`);
      process.exit(1);
    }

    const data = await res.json();
    code = data.code;
    verificationUrl = data.verification_url;
    codeSpinner.stop("Device code received");
  } catch {
    codeSpinner.stop();
    error(`Cannot reach ${apiUrl}. Is the server running?`);
    process.exit(1);
  }

  // Step 2: Open browser
  const fullUrl = `${verificationUrl}?code=${code}`;
  console.log();
  info(`Opening browser to: ${pc.underline(fullUrl)}`);
  dim("If it didn't open, visit the URL above.");
  console.log();

  tryOpenBrowser(fullUrl);

  // Step 3: Poll for approval
  const pollSpinner = spinner("Waiting for approval");

  for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    try {
      const res = await fetch(`${apiUrl}/api/v1/auth/poll?code=${code}`, {
        method: "POST",
      });

      if (res.status === 202) {
        continue;
      }

      if (res.status === 410) {
        pollSpinner.stop();
        error("Device code expired. Run 'clockwerk login' again.");
        process.exit(1);
      }

      if (res.ok) {
        const data = await res.json();
        if (data.status === "approved" && data.token) {
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

          pollSpinner.stop(`Logged in as ${pc.bold(email)}`);

          // Check if current directory has a local-only project
          await maybeOfferLink(apiUrl, data.token);

          return;
        }
      }
    } catch {
      // Network error - keep polling
    }
  }

  pollSpinner.stop();
  error("Timed out waiting for approval. Run 'clockwerk login' again.");
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
  console.log();
  info(`"${name}" is tracking locally.`);
  const shouldLink = await confirm("Want to sync it to the cloud?");

  if (!shouldLink) {
    dim("No problem! Run 'clockwerk link' anytime to connect later.");
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
    // Browser open failed silently - user has the URL printed
  }
}

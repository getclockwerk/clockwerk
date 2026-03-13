import { getUserConfig } from "@clockwerk/core";
import { unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { success, info, error } from "../ui";

export default async function logout(): Promise<void> {
  const config = getUserConfig();
  if (!config) {
    info("Not logged in.");
    return;
  }

  const configPath = resolve(process.env.HOME ?? "~", ".clockwerk", "config.json");
  try {
    unlinkSync(configPath);
  } catch {
    error("Failed to remove config file.");
    process.exit(1);
  }
  success(`Logged out (was ${config.email})`);
}

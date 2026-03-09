import { getUserConfig } from "@clockwerk/core";
import { unlinkSync } from "node:fs";
import { resolve } from "node:path";

export default async function logout(): Promise<void> {
  const config = getUserConfig();
  if (!config) {
    console.log("Not logged in.");
    return;
  }

  const configPath = resolve(process.env.HOME ?? "~", ".clockwerk", "config.json");
  unlinkSync(configPath);
  console.log(`Logged out (was ${config.email}).`);
}

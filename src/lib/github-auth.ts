import { execSync } from "node:child_process";
import { env } from "./env.js";

export function githubToken(): string {
  const fromEnv = env("GITHUB_TOKEN");
  if (fromEnv) return fromEnv;
  try {
    return execSync("gh auth token", { encoding: "utf8" }).trim();
  } catch {
    throw new Error("No GITHUB_TOKEN in .env and `gh auth token` failed");
  }
}

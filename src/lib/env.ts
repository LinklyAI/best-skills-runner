import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Zero-dependency .env loader. Later assignments win; real env vars win over file. */
function loadDotenv(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const text = readFileSync(resolve(ROOT, ".env"), "utf8");
    for (const line of text.split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && m[1] && m[2] !== undefined) out[m[1]] = m[2];
    }
  } catch {
    // .env is optional; real environment variables may be enough
  }
  return out;
}

const fileEnv = loadDotenv();

export function env(name: string): string | undefined {
  return process.env[name] ?? fileEnv[name] ?? undefined;
}

export function requireEnv(name: string): string {
  const v = env(name);
  if (!v) throw new Error(`Missing required env var ${name} (set it in .env)`);
  return v;
}

export const REPO_ROOT = ROOT;

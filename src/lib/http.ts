import { log } from "./log.js";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36 best-skills-bot/0.1 (+https://github.com/LinklyAI/best-skills)";

export interface FetchOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  retries?: number;
  /** Delay between retries; doubles each attempt. */
  retryDelayMs?: number;
}

async function fetchWithRetry(url: string, opts: FetchOptions = {}): Promise<Response> {
  const { headers = {}, timeoutMs = 60_000, retries = 2, retryDelayMs = 2_000 } = opts;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, ...headers },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status} for ${url}`);
        const retryAfter = Number(res.headers.get("retry-after")) * 1000 || retryDelayMs * 2 ** attempt;
        log.warn("http", `${res.status} on ${url}, retrying in ${retryAfter}ms`);
        await sleep(retryAfter);
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        const delay = retryDelayMs * 2 ** attempt;
        log.warn("http", `${String(err)} on ${url}, retrying in ${delay}ms`);
        await sleep(delay);
      }
    }
  }
  throw new Error(`Failed after ${retries + 1} attempts: ${url}: ${String(lastErr)}`);
}

export async function fetchText(url: string, opts?: FetchOptions): Promise<string> {
  const res = await fetchWithRetry(url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

export async function fetchJson<T = unknown>(url: string, opts?: FetchOptions): Promise<T> {
  const res = await fetchWithRetry(url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return (await res.json()) as T;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

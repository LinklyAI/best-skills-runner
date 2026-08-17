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

/**
 * Turns a rejected response into a diagnosable message.
 *
 * A bare status code cannot tell a primary rate limit from a secondary one from
 * an outright block — GitHub and Bluesky both answer all three with 403. The
 * headers and the body can. Consumes the body, so only call this on a response
 * you are about to give up on or retry.
 */
export async function describeHttpError(res: Response): Promise<string> {
  const parts = [`HTTP ${res.status}`];
  const remaining = res.headers.get("x-ratelimit-remaining");
  if (remaining !== null) {
    const resource = res.headers.get("x-ratelimit-resource") ?? "?";
    parts.push(`ratelimit ${remaining}/${res.headers.get("x-ratelimit-limit") ?? "?"} on ${resource}`);
  }
  const retryAfter = res.headers.get("retry-after");
  if (retryAfter) parts.push(`retry-after ${retryAfter}s`);
  const body = await res.text().catch(() => "");
  if (body) parts.push(`body: ${body.slice(0, 300).replace(/\s+/g, " ")}`);
  return parts.join(" | ");
}

/** 403 is in here because both APIs we poll use it for throttling, not just for "denied". */
function isRetryable(status: number): boolean {
  return status === 403 || status === 429 || status >= 500;
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
      if (isRetryable(res.status)) {
        const diag = await describeHttpError(res);
        lastErr = new Error(`${diag} for ${url}`);
        if (attempt >= retries) break;
        const retryAfter = Number(res.headers.get("retry-after")) * 1000 || retryDelayMs * 2 ** attempt;
        log.warn("http", `${diag} on ${url}, retrying in ${retryAfter}ms`);
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
  if (!res.ok) throw new Error(`${await describeHttpError(res)} for ${url}`);
  return res.text();
}

export async function fetchJson<T = unknown>(url: string, opts?: FetchOptions): Promise<T> {
  const res = await fetchWithRetry(url, opts);
  if (!res.ok) throw new Error(`${await describeHttpError(res)} for ${url}`);
  return (await res.json()) as T;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

import { log } from "./log.js";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36 best-skills-bot/0.1 (+https://github.com/LinklyAI/best-skills)";

export interface FetchOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  retries?: number;
  /** Base delay between retries; doubles each attempt. */
  retryDelayMs?: number;
  /** Treat Retry-After as a minimum and add jitter to exponential backoff. */
  retryBackoffWithJitter?: boolean;
  /** Called before every request actually sent, retries included (for metered APIs). */
  onRequest?: () => void;
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

function retryDelay(
  attempt: number,
  baseDelayMs: number,
  retryAfter: string | null,
  backoffWithJitter: boolean,
): number {
  const retryAfterMs = retryAfter === null ? 0 : Number(retryAfter) * 1000;
  const serverDelayMs = Number.isFinite(retryAfterMs) && retryAfterMs >= 0 ? retryAfterMs : 0;
  const backoffMs = baseDelayMs * 2 ** attempt;
  if (!backoffWithJitter) return serverDelayMs || backoffMs;
  const floorMs = Math.max(serverDelayMs, backoffMs);
  const jitterMs = Math.floor(Math.random() * Math.min(1_000, Math.max(1, floorMs * 0.2)));
  return floorMs + jitterMs;
}

/**
 * Fetches a URL and reads its whole body, retrying transient failures.
 *
 * The body read is part of the retried unit: a connection dropped mid-body
 * surfaces from `res.text()` (undici reports it as `TypeError: terminated`),
 * after the status line already arrived, so retrying only the `fetch()` call
 * would let it through. Parsing happens in the callers, outside the retries,
 * because a malformed payload is deterministic.
 */
async function fetchBodyWithRetry(url: string, opts: FetchOptions = {}): Promise<string> {
  const {
    headers = {},
    timeoutMs = 60_000,
    retries = 2,
    retryDelayMs = 2_000,
    retryBackoffWithJitter = false,
    onRequest,
  } = opts;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res: Response;
    try {
      onRequest?.();
      res = await fetch(url, {
        headers: { "User-Agent": UA, ...headers },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        const delay = retryDelay(attempt, retryDelayMs, null, retryBackoffWithJitter);
        log.info("http", `${String(err)} on ${url}, retrying in ${delay}ms`);
        await sleep(delay);
      }
      continue;
    }
    if (isRetryable(res.status)) {
      const diag = await describeHttpError(res);
      lastErr = new Error(`${diag} for ${url}`);
      if (attempt >= retries) break;
      const delay = retryDelay(attempt, retryDelayMs, res.headers.get("retry-after"), retryBackoffWithJitter);
      log.info("http", `${diag} on ${url}, retrying in ${delay}ms`);
      await sleep(delay);
      continue;
    }
    if (!res.ok) throw new Error(`${await describeHttpError(res)} for ${url}`);
    try {
      return await res.text();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        const delay = retryDelay(attempt, retryDelayMs, null, retryBackoffWithJitter);
        log.info("http", `body read failed (${String(err)}) on ${url}, retrying in ${delay}ms`);
        await sleep(delay);
      }
    }
  }
  throw new Error(`Failed after ${retries + 1} attempts: ${url}: ${String(lastErr)}`);
}

export async function fetchText(url: string, opts?: FetchOptions): Promise<string> {
  return fetchBodyWithRetry(url, opts);
}

export async function fetchJson<T = unknown>(url: string, opts?: FetchOptions): Promise<T> {
  const body = await fetchBodyWithRetry(url, opts);
  try {
    return JSON.parse(body) as T;
  } catch (err) {
    throw new Error(`invalid JSON from ${url}: ${String(err)} | body: ${body.slice(0, 300).replace(/\s+/g, " ")}`);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

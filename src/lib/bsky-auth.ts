import { describeHttpError } from "./http.js";
import { env } from "./env.js";
import { log } from "./log.js";

const PDS = "https://bsky.social";

/**
 * Trades an app password for an access token.
 *
 * Worth doing because Bluesky rate limits unauthenticated search per source IP,
 * and that quota is shared with everything else leaving the same address — on a
 * hosted runner, other tenants can exhaust it before the pipeline sends its first
 * request. Measured 2026-08-17 inside a live ban window, same IP, same second:
 * anonymous 403, authenticated 200. Authenticated traffic is metered per account
 * instead, and one run makes ~100 reads.
 *
 * Returns null when no credentials are configured, or when login fails — the
 * caller falls back to anonymous search, which still works when the IP is clean.
 * Losing Bluesky is a soft failure; it must never take the run down with it.
 *
 * The token outlives a full run by a wide margin (hours against ~30 minutes), so
 * it is fetched once at the start and never refreshed.
 */
export async function bskyLogin(): Promise<string | null> {
  const identifier = env("BSKY_HANDLE");
  const password = env("BSKY_APP_PASSWORD");
  if (!identifier || !password) {
    log.warn("bsky", "no BSKY_HANDLE/BSKY_APP_PASSWORD — using anonymous search, which is rate limited per IP");
    return null;
  }

  try {
    const res = await fetch(`${PDS}/xrpc/com.atproto.server.createSession`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier, password }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      log.warn("bsky", `createSession ${await describeHttpError(res)} — falling back to anonymous`);
      return null;
    }
    const { accessJwt, handle } = (await res.json()) as { accessJwt?: string; handle?: string };
    if (!accessJwt) {
      log.warn("bsky", "createSession returned no accessJwt — falling back to anonymous");
      return null;
    }
    log.info("bsky", `authenticated as ${handle ?? identifier}`);
    return accessJwt;
  } catch (err) {
    log.warn("bsky", `createSession failed (${String(err)}) — falling back to anonymous`);
    return null;
  }
}

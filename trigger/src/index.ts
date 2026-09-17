/**
 * best-skills-trigger — fires the `daily` workflow in LinklyAI/best-skills on
 * a Cloudflare cron so the pipeline starts on time.
 *
 * GitHub's own `schedule:` trigger is best-effort and, on the Free plan, has
 * been arriving 4-5 hours late every day. A `workflow_dispatch` call via the
 * REST API creates the run immediately, so this Worker replaces the schedule
 * as the primary trigger; the workflow keeps its `schedule:` only as a
 * fallback that skips itself when today is already published.
 *
 * Secrets: GITHUB_TOKEN — a fine-grained PAT with `Actions: write` on the
 * data repo only (see README.md for scope and expiry).
 */

interface Env {
  GITHUB_TOKEN: string;
  /** "owner/repo" of the workflow to dispatch. */
  GITHUB_REPO: string;
  /** Workflow file name inside .github/workflows/. */
  WORKFLOW_FILE: string;
  /** Branch the workflow runs on. */
  WORKFLOW_REF: string;
}

async function dispatch(env: Env): Promise<void> {
  const url = `https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/${env.WORKFLOW_FILE}/dispatches`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "best-skills-trigger (+https://github.com/LinklyAI/best-skills-runner)",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ref: env.WORKFLOW_REF }),
  });
  // 204 is the only success answer; anything else carries a JSON error body.
  if (res.status !== 204) {
    const body = (await res.text().catch(() => "")).slice(0, 300).replace(/\s+/g, " ");
    throw new Error(`dispatch ${env.WORKFLOW_FILE}@${env.WORKFLOW_REF} on ${env.GITHUB_REPO} failed: HTTP ${res.status} ${body}`);
  }
  console.log(`dispatched ${env.WORKFLOW_FILE}@${env.WORKFLOW_REF} on ${env.GITHUB_REPO}`);
}

export default {
  // Throwing marks the invocation as failed in the Workers dashboard / logs;
  // the workflow's own schedule still runs later that day as the fallback.
  async scheduled(controller, env): Promise<void> {
    console.log(`cron ${controller.cron} fired at ${new Date(controller.scheduledTime).toISOString()}`);
    await dispatch(env);
  },
} satisfies ExportedHandler<Env>;

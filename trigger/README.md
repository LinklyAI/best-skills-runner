# best-skills-trigger

A Cloudflare Worker whose only job is to start the [`daily` workflow](https://github.com/LinklyAI/best-skills/blob/main/.github/workflows/daily.yml) in the data repo at **01:17 UTC** every day.

GitHub's own `schedule:` trigger is best-effort: on the Free plan it has been firing 4–5 hours late (around 06:00 UTC) since late August 2026, and the delay does not depend on the cron slot. A `workflow_dispatch` call through the REST API creates the run immediately, so this Worker is the primary trigger. The workflow keeps its `schedule:` as a fallback — when the Worker already published today, that late run sees `data/<today>/` in the repo and skips itself.

## Deploy

Uses the same Cloudflare account as `linkly-ai-api` (`wrangler whoami` should show dev@linkly.ai).

```bash
cd trigger
pnpm install                      # first time only
pnpm typecheck
pnpm deploy                       # creates / updates the Worker and its cron
pnpm wrangler secret put GITHUB_TOKEN   # paste the PAT when prompted
```

Redeploying keeps existing secrets; only `wrangler.jsonc` changes (repo, workflow file, cron) need a deploy.

## GITHUB_TOKEN

A **fine-grained personal access token** (github.com → Settings → Developer settings → Personal access tokens → Fine-grained tokens):

- Resource owner: `LinklyAI`
- Repository access: **Only select repositories** → `LinklyAI/best-skills`
- Repository permissions: **Actions: Read and write** — nothing else (`Metadata: Read` is added automatically)
- Expiration: up to 1 year. **Write the expiry date here when rotating** and set a reminder — the Worker fails silently apart from a failed invocation in the Workers dashboard, and the workflow's late `schedule:` fallback takes over, so a lapsed token shows up only as "data is late again".

Current token expires: **2027-09-17** (created 2026-09-17 with a one-year expiry; correct this line if a different date was chosen).

## Verify

Manual dispatch without waiting for the cron:

```bash
pnpm dev                          # then, in another shell:
curl "http://localhost:8787/__scheduled?cron=17+1+*+*+*"
```

That needs `GITHUB_TOKEN` in `trigger/.dev.vars` (git-ignored). In production, `wrangler tail` shows each firing, and the run should appear within seconds at https://github.com/LinklyAI/best-skills/actions/workflows/daily.yml with event `workflow_dispatch`.

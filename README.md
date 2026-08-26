# best-skills-runner

The data pipeline behind [**LinklyAI/best-skills**](https://github.com/LinklyAI/best-skills) — a daily, cross-ecosystem ranking of AI agent skills.

[![daily](https://github.com/LinklyAI/best-skills/actions/workflows/daily.yml/badge.svg)](https://github.com/LinklyAI/best-skills/actions/workflows/daily.yml)
[![probe](https://github.com/LinklyAI/best-skills-runner/actions/workflows/probe.yml/badge.svg)](https://github.com/LinklyAI/best-skills-runner/actions/workflows/probe.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Every skills registry only sees its own ecosystem: skills.sh counts Claude/Vercel CLI installs, ClawHub counts OpenClaw downloads, SkillHub counts installs from China — and none of them see social traction. This pipeline collects all of them once a day, merges them into a single entity graph, computes nine rankings, validates the output, and publishes it as open CSV.

Runs on GitHub Actions every day at 01:17 UTC — the scheduled workflow lives in the [data repo](https://github.com/LinklyAI/best-skills/blob/main/.github/workflows/daily.yml), which checks this one out and runs it. Everything the pipeline produces lives in that repo; there is no database and no server.

## Pipeline

```text
sources/     collect raw data — skills.sh · ClawHub · SkillHub · GitHub · social buzz
   ↓
rank/        entity resolution (fully-qualified keys, cross-platform links only on
             exact upstream_url evidence) → within-platform log percentiles →
             nine rankings + a five-dimension weighted index
   ↓
publish/     write CSVs to ../best-skills/data/YYYY-MM-DD/{raw,rankings}/
             render the ranking previews into the data repo's READMEs, one per language
   ↓
validate.ts  publication gate — row-count floors, sort monotonicity, rank continuity,
             directory closure, day-over-day drift, sanity anchors
   ↓          (only if everything passes)
publish/     refresh data/latest/ → commit → push
```

**A failed validation never ships.** If any gate trips, the run exits non-zero without touching `data/latest/` and without pushing, so the last known-good snapshot stays live. Re-running the same day is idempotent — it overwrites that day's files rather than appending.

## Data sources

| Source                | What it provides                                  |
| --------------------- | ------------------------------------------------- |
| skills.sh             | Install counts across three views (all-time / hot / trending) |
| ClawHub               | Download counts and content-update timestamps      |
| SkillHub              | Install counts from the China ecosystem            |
| GitHub                | Repository stars, ownership, creation dates        |
| HN · Bluesky · X · GitHub search | Seven-day mention volume per skill      |

Absolute numbers are **never summed or compared across platforms** — each platform is a separate counter with its own semantics. Cross-platform rankings are composed from within-platform log percentiles. The full methodology, including every scoring dimension and its known limitations, is published at [best-skills/docs/methodology.md](https://github.com/LinklyAI/best-skills/blob/main/docs/methodology.md).

## Rankings

`best-100` · `top-installs` · `trending-7d` · `social-buzz` · `most-active` · `official-100` · `official-vendors` · `top-repos` · `rising-stars`

All nine are published daily as CSV under [CC BY 4.0](https://github.com/LinklyAI/best-skills), with stable URLs under `data/latest/`.

## Running it yourself

Requires Node 24+ and pnpm. The pipeline writes into a local clone of the data repo, so check out both side by side:

```bash
git clone https://github.com/LinklyAI/best-skills.git
git clone https://github.com/LinklyAI/best-skills-runner.git
cd best-skills-runner && pnpm install
cp .env.example .env    # then fill it in
```

```bash
pnpm probe      # connectivity check against every source
pnpm collect    # full run, no push
pnpm rank       # recompute rankings from today's already-collected raw data
pnpm daily      # full run, validate, and push
```

`main.ts` also takes `--date=YYYY-MM-DD`, `--only=<collectors>`, `--rank-only` and `--no-push`. Dates are always UTC.

Only `GITHUB_TOKEN` is effectively required (repository stars and GitHub mention counts). Without `RAPIDAPI_KEY` the pipeline skips X; without `LLM_API_BASE`/`LLM_API_KEY` it falls back to raw HN/Bluesky hit counts instead of LLM-filtered ones. Neither is fatal — degraded columns are labeled as such in the output.

## Layout

```text
src/
├── main.ts        entry point — argument parsing, collection order, validate, push
├── probe.ts       per-source connectivity smoke test
├── sources/       collectors: skills-sh · clawhub · skillhub · github
├── buzz/          mention volume across HN · Bluesky · GitHub search · X
├── rank/          entity resolution · percentile scoring · the nine rankings
├── publish/       CSV output, README rendering (per language), git commit + push
├── validate.ts    publication gate
└── lib/           csv · env · http · github-auth · log
```

Zero runtime dependencies — everything is built on Node's standard library.

## License

MIT — see [LICENSE](LICENSE). The published data is licensed separately under CC BY 4.0.

---

Maintained by [Linkly AI](https://linkly.ai) — an AI-powered local knowledge base with agent skills support.

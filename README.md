# PC Supervisor

A local, single-user dashboard that helps a program-committee chair supervise a HotCRP review process. It answers three questions:

- **Papers:** which papers are in trouble? It ranks them, with plain reasons: split scores with no movement, silent discussion, an AC who hasn't posted, a looming deadline with no consensus.
- **Area chairs:** which ACs are keeping their papers moving? It shows coverage, time to first post, nudges, and stale papers, alongside each AC's load.
- **Reviewers:** who is engaging in discussion? It lists outliers, such as reviewers silent on split papers or with unanswered pings, split by senior, junior, and reciprocal tier.

It syncs from the HotCRP API into an encrypted local SQLite file every 15 minutes, keeps snapshots so it can see change over time, and serves a React UI on `127.0.0.1`. It is read-only against HotCRP until v1.

> **Status:** pre-alpha. The harness and CI are in place; the app is not built yet. See [PLAN.md](PLAN.md).

## Docs

- [docs/spec.md](docs/spec.md): what it does, the HotCRP API facts it relies on, the data model, the rules, and testing.
- [PLAN.md](PLAN.md): milestones, acceptance criteria, and the golden test scenario.
- [AGENTS.md](AGENTS.md): rules for contributors and coding agents. Read this before writing code.
- [docs/ci.md](docs/ci.md): how CI runs a disposable HotCRP on the Ripley self-hosted runners.

## Development

You need Docker (with Compose v2) and Node 22.

```bash
scripts/hotcrp-up.sh        # throwaway HotCRP + MariaDB at http://127.0.0.1:8080
scripts/harness-smoke.sh    # seeds one paper and checks the API paths the app uses
docker compose -p pcs -f hotcrp/compose.yaml down -v    # throw it away
```

`hotcrp-up.sh` creates a chair account (`admin@example.org`), mints an API token, and writes `PCS_HOTCRP_URL` and `PCS_HOTCRP_TOKEN` to `.env.test`. AGENTS.md lists the npm commands.

The repo is an npm workspace (`server/`, `web/`, `seed/`, `e2e/`; `e2e/argos-canary/` stays standalone):

- `server/src/config.ts`: every `PCS_*` variable, validated with Zod. `npm run pcs -- config-check` prints a redacted summary or every problem at once.
- `server/src/clock.ts`: the only source of "now" (ESLint enforces it).
- `server/src/hotcrp/`: the HotCRP client and its response schemas.
- Tests: `server/test/unit/` (no network), `server/test/contract/` (live harness; refuses non-localhost URLs), `e2e/specs/` (Playwright + Argos).

## Using it on a real conference

1. Get a chair API token: HotCRP → Account settings → Developer.
2. Copy `.env.example` to `.env` and fill in the instance URL, the token, the phase dates, and a DB key. **Every setting is an environment variable**; `.env.example` documents them all.
3. Run `npx pcs probe` (or `npm run pcs -- probe`) once to confirm the instance's review-form field UIDs and score scales. It needs only `PCS_HOTCRP_URL` and `PCS_HOTCRP_TOKEN`, sends GET requests only, and prints a shape report with no titles, names, emails, or text: keys and types, counts, form fields with declared and observed score ranges, user-tag names, schema pass/fail per endpoint, rate-limit headers, and a suggested `PCS_FIELD_*` / `PCS_MERIT_ACCEPT_MIN` / `PCS_TIER_TAGS` block. Use `--markdown` for a version to paste into an issue, or `--json`. It exits nonzero if any endpoint is unreachable; schema drift is reported, not fatal.
4. Run `pcs sync --watch` and open `http://127.0.0.1:5317`.
5. When the PC is over, run `pcs wipe`.

The local database holds every review and comment. Keep it off synced folders and backups that leave the machine, and never share screenshots of the real data.

## CI

GitHub Actions on the `ripley-cloud` self-hosted runners. Each job builds HotCRP from a pinned commit, seeds it, and runs unit, contract, integration, and Playwright tests. A nightly job also tests against HotCRP `master` and runs the 2,400-paper scale scenario. CI never touches a real conference. Details are in [docs/ci.md](docs/ci.md).

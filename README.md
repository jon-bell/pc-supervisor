# PC Supervisor

A local, single-user dashboard that helps a program-committee chair supervise a HotCRP review process. It answers three questions:

- **Papers:** which papers are in trouble? It ranks them, with plain reasons: split scores with no movement, silent discussion, an AC who hasn't posted, a looming deadline with no consensus.
- **Area chairs:** which ACs are keeping their papers moving? It shows coverage, time to first post, nudges, and stale papers, alongside each AC's load.
- **Reviewers:** who is engaging in discussion? It lists outliers, such as reviewers silent on split papers or with unanswered pings, split by senior, junior, and reciprocal tier.

It syncs from the HotCRP API into an encrypted local SQLite file every 15 minutes, keeps snapshots so it can see change over time, and serves a React UI on `127.0.0.1`. Its one write to HotCRP is the v1 tagging action, which always shows HotCRP's dry run and needs a typed confirmation first.

> **Status:** pre-alpha. Sync, rules, the JSON API, the UI (triage, AC table, reviewer outlier lists, person pages, overview), and the v1 actions (M8: copy search, nudge drafts, dry-run-first tagging) work against the harness. See [PLAN.md](PLAN.md).

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
- `server/src/server/`: the Fastify JSON API (`/api/meta`, `/api/triage`, `/api/papers/:pid`, `/api/acs`, `/api/reviewers`, `/api/people/:email`, `/api/overview`, `/api/sync/status`, `POST /api/sync`, and the M8 actions `/api/actions`, `/api/papers/:pid/nudge`, `POST /api/tags/preview`, `POST /api/tags/commit`); `server/src/actions/` holds the search builder, nudge drafts, and the tagging state machine; `server/src/views/snapshot.ts` turns the store into the rules engine's input.
- `web/`: React + Vite + TanStack Query/Table/Virtual (triage list, paper drawer, AC table, reviewer outlier lists, person page, overview, sync status). Charts are inline SVG; there is no chart library.
- Tests: `server/test/unit/` (no network), `server/test/contract/` and `server/test/integration/` (live harness; refuse non-localhost URLs), `e2e/specs/` (Playwright + Argos).

### Running the app locally

`pcs serve` serves the built web app and the JSON API on `127.0.0.1:PCS_PORT` (default 5317, loopback only). The HotCRP token stays in the server process. `pcs serve --watch` also syncs every `PCS_SYNC_INTERVAL_MIN`; the UI's **Sync now** button runs one sync either way (never two at once).

```bash
set -a; . ./.env.test; set +a                 # harness URL + token
export PCS_DB_PATH=$PWD/data/dev.db PCS_DB_KEY=dev-only PCS_NOW=2030-02-26T12:00 \
  PCS_TIER_TAGS=junior=junior,reciprocal=reciprocal   # plus the PCS_PHASE_* dates from ci.yml
npm run seed -- shadow --reset                # or golden
npm run pcs -- sync && npm run pcs -- backfill
npm run build -w @pcs/web && npm run pcs -- serve    # http://127.0.0.1:5317/
npm run dev                                   # or: hot reload at http://127.0.0.1:5173/ (API proxied to PCS_PORT)
```

`npm run dev` starts `pcs serve` and the Vite dev server together; Ctrl-C stops both. `npm run test:e2e` builds the web app, seeds `golden`, syncs it into a temp DB with `PCS_NOW` pinned, and runs the Playwright specs against `pcs serve` on port 5327.

## Using it on a real conference

1. Get a chair API token: HotCRP → Account settings → Developer.
2. Copy `.env.example` to `.env` and fill in the instance URL, the token, the phase dates, and a DB key. **Every setting is an environment variable**; `.env.example` documents them all.
3. Run `npx pcs probe` (or `npm run pcs -- probe`) once to confirm the instance's review-form field UIDs and score scales. It needs only `PCS_HOTCRP_URL` and `PCS_HOTCRP_TOKEN`, sends GET requests only, and prints a shape report with no titles, names, emails, or text: keys and types, counts, form fields with declared and observed score ranges, user-tag names, schema pass/fail per endpoint, rate-limit headers, and a suggested `PCS_FIELD_*` / `PCS_MERIT_ACCEPT_MIN` / `PCS_TIER_TAGS` block. Use `--markdown` for a version to paste into an issue, or `--json`. It exits nonzero if any endpoint is unreachable; schema drift is reported, not fatal.
4. Run `pcs sync`, then `pcs backfill` once (score history from before the first sync), then `pcs serve --watch` and open `http://127.0.0.1:5317`.
5. When the PC is over, run `pcs wipe`.

**Actions (v1, spec §6).** Above the triage list, **Copy search** copies a HotCRP search for the papers shown (under any AC, rule, or tier filter; also on a person page) to paste into HotCRP's search box or Mail tool. In the paper drawer, **Draft a nudge comment** writes a polite comment that @mentions the right people and quotes the reasons; copy it and post it in HotCRP yourself. **Tag #chair-attention…** (the tag is `PCS_ATTENTION_TAG`) runs a HotCRP dry run, shows which papers would gain or lose the tag, and writes only after you type the tag name; the preview is single-use and expires after 5 minutes. The app then re-syncs so the tags show.

**Local CSV imports (large-conference modules, spec §10.3).** Run `pcs import <kind> <file.csv>` to load the reserve-invitation sheet (`invites`), the TPMS output (`tpms-assignments`, `tpms-registrations`), a reference checker's output (`refcheck`), or the do-not-invite list (`do-not-invite`) into the encrypted store. Each import is a new version, so earlier versions stay queryable. A file with any bad row is rejected whole, with a `line N, column C: problem` report. `pcs import --list` shows the history with counts only. `pcs import --help` lists the expected columns.

**Assignment validator (spec §10.4 C).** After `pcs sync` and the imports, `pcs validate-assignments` checks the current HotCRP assignment: per-paper composition (`PCS_POLICY_*`), load bands per tier (`PCS_LOAD_*`), same-affiliation conflicts, reciprocal review cycles (`PCS_CYCLE_MAX_K`), and reserve reviewers who aren't AC-approved in the `invites` sheet or who are on the do-not-invite list. `--tpms` validates the latest `tpms-assignments` import instead. `--out fixup.csv` writes a corrected `paper,action,user` CSV. Upload it in HotCRP and check the preview before saving. The tool never applies assignments itself.

The local database holds every review and comment. Keep it off synced folders and backups that leave the machine, and never share screenshots of the real data.

## CI

GitHub Actions on the `ripley-cloud` self-hosted runners. Each job builds HotCRP from a pinned commit, seeds it, and runs unit, contract, integration, and Playwright tests. A nightly job also tests against HotCRP `master` and runs the 2,400-paper scale scenario. CI never touches a real conference. Details are in [docs/ci.md](docs/ci.md).

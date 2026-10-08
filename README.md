# PC Supervisor

A local, single-user dashboard that helps a program-committee chair supervise a HotCRP review process. It answers three questions:

- **Papers:** which papers are in trouble? It ranks them, with plain reasons: split scores with no movement, silent discussion, an AC who hasn't posted, a looming deadline with no consensus.
- **Area chairs:** which ACs are keeping their papers moving? It shows coverage, time to first post, nudges, and stale papers, alongside each AC's load.
- **Reviewers:** who is engaging in discussion? It lists outliers, such as reviewers silent on split papers or with unanswered pings, split by senior, junior, and reciprocal tier.

It syncs from the HotCRP API into an encrypted local SQLite file every 15 minutes, keeps snapshots so it can see change over time, and serves a React UI on `127.0.0.1`. Its one write to HotCRP is the v1 tagging action, which always shows HotCRP's dry run and needs a typed confirmation first.

> **Status:** pre-alpha. Milestones M0–M13 of [PLAN.md](PLAN.md) are built and pass their tests locally against the harness: the probe, sync, rules, the JSON API, the UI (triage, AC table, reviewer outlier lists, person pages, overview), the v1 actions (copy search, nudge drafts, dry-run-first tagging), scale budgets, and the large-conference modules (extended phases, imports, assignment validator, reserve compliance, quick-reject tracker, reviewing by tier, early reject, process report and export). CI on GitHub hasn't run yet: the workflow has only been checked by running its steps locally and with actionlint, so no milestone has met PLAN's "passes in CI" bar.

## Docs

- [docs/spec.md](docs/spec.md): what it does, the HotCRP API facts it relies on, the data model, the rules, and testing.
- [PLAN.md](PLAN.md): milestones, acceptance criteria, and the golden test scenario.
- [AGENTS.md](AGENTS.md): rules for contributors and coding agents. Read this before writing code.
- [docs/ci.md](docs/ci.md): how CI runs a disposable HotCRP on the Ripley self-hosted runners.

## Development

You need Docker (with Compose v2) and Node 22. No C toolchain is needed: `.npmrc` sets `ignore-scripts=true`, and the SQLCipher driver loads its bundled prebuilt binary.

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
- `server/src/server/`: the Fastify JSON API (`/api/meta`, `/api/triage`, `/api/papers/:pid`, `/api/acs`, `/api/reviewers`, `/api/people/:email`, `/api/overview` (these five also take `?search=<HotCRP search>`), `/api/paper-search`, `/api/sync/status`, `POST /api/sync`, the M11 modules `/api/reserve` and `/api/quickreject`, the M12 modules `/api/tier-progress` and `/api/early-reject`, the M13 report `/api/report` with its downloads `/api/report/export.zip`, `/api/report/export/:file` and `/api/report/do-not-invite.csv`, and the M8 actions `/api/actions`, `/api/papers/:pid/nudge`, `POST /api/tags/preview`, `POST /api/tags/commit`); `server/src/actions/` holds the search builder, nudge drafts, and the tagging state machine; `server/src/views/snapshot.ts` turns the store into the rules engine's input.
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
2. Copy `.env.example` to `.env` and fill in the instance URL, the token, the phase dates, and a DB key. **Every setting is an environment variable**; `.env.example` documents them all. When `PCS_HOTCRP_URL` is not already set, `pcs` loads `./.env` (from the directory you run `npm`/`npx` in) and prints that it did; variables already in the environment win. If you export `PCS_HOTCRP_URL` yourself (as with `.env.test`), `.env` is ignored entirely.
3. Run `npx pcs probe` (or `npm run pcs -- probe`) once to confirm the instance's review-form field UIDs and score scales. It needs only `PCS_HOTCRP_URL` and `PCS_HOTCRP_TOKEN`, sends GET requests only, and prints a shape report with no titles, names, emails, or text: keys and types, counts, form fields with declared and observed score ranges, user-tag names, schema pass/fail per endpoint, rate-limit headers, and a suggested `PCS_FIELD_*` / `PCS_MERIT_ACCEPT_MIN` / `PCS_TIER_TAGS` block. Use `--markdown` for a version to paste into an issue, or `--json`. It exits nonzero if any endpoint is unreachable; schema drift is reported, not fatal.
4. Run `pcs sync`, then `pcs backfill` once (score history from before the first sync), then `pcs serve --watch` and open `http://127.0.0.1:5317`.
5. When the PC is over, run `pcs wipe`.

**Limiting it to some papers.** Set `PCS_PAPER_SEARCH` to a HotCRP search (e.g. `#shadow`, or `1-200`) to pin the whole app to the papers it matches. This is useful on a shadow-PC instance that also holds papers in other phases. Every HotCRP read the sync and the modules make is ANDed with it, so only those papers and their reviews, comments, and assignments are stored. A paper that stops matching drops out of every view at the next sync. Its rows are kept, and it comes back if it matches again. A search HotCRP warns about makes the sync fail instead of emptying the store. On the triage list, AC table, reviewer lists, person pages, and overview, the **Papers matching** box above the view takes any HotCRP search and narrows the view, including the per-AC and per-reviewer numbers, to the papers it matches within that pin. The search is kept in the URL (`?search=`), so it stays set as you move between views and goes along with any link you share. The server runs it as one read-only HotCRP search and caches the result for a minute.

**Actions (v1, spec §6).** Above the triage list, **Copy search** copies a HotCRP search for the papers shown (under any AC, rule, or tier filter; also on a person page) to paste into HotCRP's search box or Mail tool. In the paper drawer, **Draft a nudge comment** writes a polite comment that @mentions the right people and quotes the reasons; copy it and post it in HotCRP yourself. **Tag #chair-attention…** (the tag is `PCS_ATTENTION_TAG`) runs a HotCRP dry run, shows which papers would gain or lose the tag, and writes only after you type the tag name; the preview is single-use and expires after 5 minutes. The app then re-syncs so the tags show.

**Local CSV imports (large-conference modules, spec §10.3).** Run `pcs import <kind> <file.csv>` to load the reserve-invitation sheet (`invites`), the TPMS output (`tpms-assignments`, `tpms-registrations`), a reference checker's output (`refcheck`), or the do-not-invite list (`do-not-invite`) into the encrypted store. Each import is a new version, so earlier versions stay queryable. A file with any bad row is rejected whole, with a `line N, column C: problem` report. `pcs import --list` shows the history with counts only. `pcs import --help` lists the expected columns.

**TPMS file exchange (spec §10.3).** TPMS has no API, so data goes back and forth as files. `pcs export tpms <dir>` (after `pcs sync`) writes the bundle for the TPMS operator: `pc.csv`, HotCRP's PC `conflicts.csv`, one `load-<tier>.csv` per tier with its `PCS_LOAD_*` band, `reviews-per-paper.csv`, and a `README.txt`. The files contain reviewer emails, because TPMS matches reviewers by email, but no review text. Send them privately. Get the PDF ZIP from HotCRP's own Download menu. To bring results back:
- `pcs import tpms-assignments <file> --map paper=…,email=…[,round=…]` reads TPMS's assignment CSV, whose column layout is unpublished.
- `pcs import tpms-scores <file>` reads the affinity matrix (`paper,email,score`, scores 0–1). Files of 1.44M rows are streamed.
- `pcs import affinity-local <file>` reads [openreview-expertise](https://github.com/openreview/openreview-expertise) output that you ran **on this machine** for cold-start reviewers. Never use its hosted API.
- `pcs import tpms-registrations <file>` reads registration status. A plain list of emails also works, meaning everyone listed is registered.

**Assignment validator (spec §10.4 C).** After `pcs sync` and the imports, `pcs validate-assignments` checks the current HotCRP assignment: per-paper composition (`PCS_POLICY_*`), load bands per tier (`PCS_LOAD_*`), same-affiliation conflicts, reciprocal review cycles (`PCS_CYCLE_MAX_K`), and reserve reviewers who aren't AC-approved in the `invites` sheet or who are on the do-not-invite list. `--tpms` validates the latest `tpms-assignments` import instead. `--out fixup.csv` writes a corrected `paper,action,user` CSV. Upload it in HotCRP and check the preview before saving. The tool never applies assignments itself. The same report is in the web view under *Modules → Assignment* (`GET /api/assignment[?source=tpms]`).

**Assignment solver (spec §10.5).** `pcs solve-assignments [--hard] [--out file.csv] [--report file.json]` (and *Modules → Solver*) computes a whole tiered assignment with our port of HotCRP's min-cost flow: `PCS_POLICY_MIN_SENIOR`..`PCS_POLICY_MAX_SENIOR` seniors plus one junior or reserve-active third slot per paper, reviewer loads within the `PCS_LOAD_*` bands with convex load costs, affinity from the `tpms-scores` import, then `affinity-local`, then HotCRP's own preferences (weights `PCS_SOLVER_W_*`), and no edge that is conflicted (HotCRP's conflicts, authors, same affiliation), on the do-not-invite list, or an unapproved reserve. Started reviews and AC-activated reserves are kept. Repair passes break reciprocal review cycles and same-institution panels. Required slots are soft by default, so the solve always finishes and lists what each paper still lacks; `--hard` (`PCS_SOLVER_HARD`) makes them hard constraints. Besides the solve report, it writes a HotCRP bulk-assign CSV (`paper,action,email,round`). It reads HotCRP's conflicts and preferences but never writes to HotCRP: upload the CSV yourself and check the preview. The solver's settings are the `PCS_SOLVER_*` variables in `.env.example`.

**Reserve compliance (spec §10.4 A).** `pcs reserve` (and the web view under *Modules → Reserve*) checks every paper's "Reserve designee" and "Reserve exemption" submission options (`PCS_RESERVE_*`): missing designees, designees who aren't authors, exemptions outside `PCS_RESERVE_EXEMPTIONS` or contradicted by the PC roster, the same person designated under different emails, designees covering more than `PCS_RESERVE_MAX_COVER` papers, and (with a `tpms-registrations` import) designees not registered with TPMS. It prints the reasons and a HotCRP Mail-tool search per problem; nothing is sent. An **optional DBLP lookup** (`PCS_DBLP_ENABLED=true`, off by default) adds seniority hints from paper counts at `PCS_DBLP_VENUES`. It is the only outbound call besides your HotCRP instance, sends public author names only, and its results are hints for a human, never verdicts.

**Quick-reject tracker (spec §10.4 B).** `pcs quickreject` (and *Modules → Quick reject*) lists the papers with a quick-reject signal (a `refcheck` import hit, the AC flag tag `PCS_QR_AC_FLAG_TAG`, or a reject verdict in a `PCS_QR_ROUND` review) or a quick-reject state tag, with the AC decision, chair action, and appeal state read from the paper tags in `PCS_QR_TAGS` (default `qr-ac-reject`, `qr-ac-keep`, `qr-chair-desk-reject`, `qr-chair-keep`, `qr-appeal`, `qr-appeal-upheld`, `qr-appeal-overturned`) and the HotCRP decision. Set those tags in HotCRP; the tool only reads them. Quick-reject reviews not submitted after `PCS_PHASE_QUICKREJECT_DUE` are listed as overdue, and by default they don't count toward a paper's review slots (`PCS_QR_EXCLUDE_FROM_SLOTS`).

**Reviewing progress by tier and early reject (spec §10.4 D/E).** The **Modules** nav group has two views, also available from the CLI as counts and reasons with no review text:
- `pcs tier-progress` (`/modules/tier-progress`): outstanding and late reviews per tier; late reserve reviews (`PCS_RESERVE_TIERS`) with an escalation state: late, pinged, replacement-needed (`PCS_RESERVE_DROPOUT_DAYS`), or replaced. It also shows each reserve reviewer's own submissions next to their review record (evidence for a human decision, nothing more), a coaching queue of junior reviews under `PCS_COACH_MIN_WORDS` or rated short/vague (with HotCRP links), and participation by tier. With `PCS_POLICY_WITHHOLD_REVIEWS=true` it drafts, but never applies, a HotCRP tag CSV for the papers whose reviews would be withheld.
- `pcs early-reject` (`/modules/early-reject`): candidates under `PCS_POLICY_EARLYREJECT`, computed from the sync history as of `PCS_PHASE_EARLYREJECT_OPEN`, with their discussion signals. It drafts a Mail-tool search for a "re-read within `PCS_EARLYREJECT_WINDOW_H` hours" mail. At the close it lists which candidates were bumped, which weren't, and the reviewers who never responded. Sync at least once at or before the window opens.

**Process report and pseudonymous export (spec §10.4 G).** `pcs report` (and *Modules → Report*) shows the after-the-conference report, provisional until decisions are due: review depth, timeliness, merit distributions, review-rating flags received (per review, by tier), and score agreement (deviation from the paper mean, and agreement with the final decision) by tier, plus reserve activation and dropout, early-reject yield, and quick/desk-reject counts and appeals. It shows aggregates only, and any group of fewer than `PCS_REPORT_MIN_CELL` people (default 5) is withheld. `pcs export --out <dir> [--zip]` (the page's Export button) writes per-review and per-reviewer CSVs for a cross-conference baseline. In them every person is `HMAC-SHA256(PCS_PSEUDONYM_KEY, email)`, and there are no emails, names, titles, or text. Set `PCS_PSEUDONYM_KEY` to a long random secret (`openssl rand -hex 32`), keep it private, and reuse it next year so pseudonyms join; the export refuses to run without it. `pcs report --do-not-invite <file.csv>` (or the page's download) writes the do-not-invite carry-forward for the next chair. It keeps emails, because it is your own list, so hand it over privately. Everything is written on this machine; nothing is uploaded.

The local database holds every review and comment. Keep it off synced folders and backups that leave the machine, and never share screenshots of the real data.

## CI

GitHub Actions on the `ripley-cloud` self-hosted runners. Each job builds HotCRP from a pinned commit, seeds it, and runs unit, contract, integration, and Playwright tests. A nightly job also tests against HotCRP `master` and runs the 2,400-paper scale scenario. CI never touches a real conference. Details are in [docs/ci.md](docs/ci.md).

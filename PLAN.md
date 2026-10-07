# Plan

This is the work breakdown for building PC Supervisor. Read [docs/spec.md](docs/spec.md) first; this file assumes it. Each milestone lists its scope, dependencies, and acceptance criteria. A milestone is done when its criteria pass **in CI**, not just locally.

**Already done (2026-10-07):**
- the disposable HotCRP harness (`hotcrp/`, `scripts/hotcrp-up.sh`);
- a smoke test that exercises every API path the app depends on (`scripts/harness-smoke.sh`);
- the CI workflow skeleton, which runs the harness on `ripley-cloud`;
- the spec, `.env.example`, and AGENTS.md.

## Parallel tracks

```
M1 foundations ──┬── M2 seeder + golden ──┐
                 ├── M3 store + sync ─────┼── M5 server + triage UI ── M6 AC/reviewer/overview ── M7 scale ── M8 v1 actions
                 └── M4 rules engine ─────┘
M0 probe (needs only M1's HotCRP client; Jon runs it against the live instance)
```

After M1, tracks M2, M3, and M4 can go to different people. The **golden scenario table** below is the contract between them. M2 builds it, M3 syncs it, and M4's unit tests encode its expected reasons.

## Repo layout and the npm-script contract

Use npm workspaces, TypeScript strict mode everywhere, and Node 22.

```
server/   sync engine, store, rules, Fastify JSON API, CLI (`pcs`)
web/      React + Vite + TanStack Table/Query
seed/     scenario format, driver, scenarios/{golden,shadow,scale}
e2e/      Playwright specs
hotcrp/   harness image (done)
scripts/  harness scripts (done)
```

CI calls exactly these root scripts, so keep the names stable:

| Script | Must do |
|---|---|
| `lint` | ESLint, all workspaces |
| `typecheck` | `tsc --noEmit`, all workspaces |
| `test:unit` | Vitest, no network, no Docker |
| `test:integration` | contract + seed→sync→assert-DB tests against the running harness (reads `.env.test`) |
| `test:e2e` | seed `golden` → sync → start server + built web → Playwright |
| `test:scale` | seed `scale` → timed sync → Playwright perf checks |

The CI steps for these are already in `.github/workflows/ci.yml`. They're gated on `package.json` existing, so they switch on automatically.

---

## M0: Probe the live instance

- **Scope:** `pcs probe` is a read-only CLI that calls every endpoint the sync uses. It prints a **shape report**:
  - response keys and types;
  - counts (papers, PC, reviews by `rtype`/`status`, comments);
  - review-form field UIDs, with each score field's value range;
  - user tags present;
  - whether `modified_at` is present on reviews and comments.
- It **prints no content**: no titles, names, emails, or text.
- **Depends on:** the HotCRP client from M1.
- **Done when:** it runs green against the harness in CI, and Jon has run it against the live instance and pasted the report into an issue. That report sets the env defaults (`PCS_FIELD_*`, `PCS_MERIT_ACCEPT_MIN`, `PCS_TIER_TAGS`).

## M1: Foundations

- **Scope:**
  - The workspace scaffold, with the npm-script contract above.
  - `server/src/config.ts`: a Zod schema over every `PCS_*` var in `.env.example`, with typed defaults. Fail at startup and list all errors at once.
  - `server/src/clock.ts`: the only source of "now". It honors `PCS_NOW`.
  - `server/src/hotcrp/`: a typed client. It handles bearer auth, `pretty=0`, POST-as-GET (`:method:=GET`), pid-range chunking, bounded concurrency, and retry with backoff on 429/5xx. Every response is validated with a Zod schema in `server/src/hotcrp/schemas.ts`, so schema failures surface as contract-test failures.
  - Contract tests run those schemas against the seeded harness.
  - The Playwright config in `e2e/` adds the Argos reporter (`uploadToArgos: !!process.env.CI`) and Argos's recommended launch flags. Copy them from `e2e/argos-canary/`.
- **Done when:** CI is green with lint, typecheck, unit, and the contract tests against the harness; and a bad env var produces one readable error listing every problem.

## M2: Seeder + scenarios

- **Scope:**
  - The `seed/` scenario format, in YAML or TS. It declares PC members (with tags), papers, assignments, and a timeline of `{day, actor, event}` entries. Days are offsets from a named phase date.
  - The driver follows the method in spec §9.3:
    - batch scripts for structure;
    - the API for reviews and comments (`actas`, `notify=0`);
    - SQL time-warp that shifts whole object timelines and preserves HotCRP's ordering invariants.
  - It supports **multi-stage scenarios**: stage 1, then a hook for a sync, then stage 2 with `PCS_NOW` advanced.
  - Fix the `saveusers.php` name/tag keys (spec §9.3, open item).
  - Ship the `golden`, `shadow` (~150 papers), and `scale` (generated, fixed RNG seed) scenarios.
- **Done when:** `npm run seed -- golden` on a fresh harness reproduces the table below exactly. That includes the API showing backdated `modified_at` values within ±1 minute of the scenario's intended times. `scale` seeds in under 15 minutes on `ripley-cloud-large`.

### Golden scenario: the contract between M2, M3, and M4

The scenario uses the phase dates from `ci.yml`: review due 02-01, response 02-08 to 02-11, discussion opens 02-12, decisions due 03-03. The primary assertion instant is `PCS_NOW = 2030-02-26T12:00` (discussion day +14, about 5 days to decisions).

Scales follow the default form: merit 1–5 (accept side ≥ 3), expertise 1–4 (OK ≥ 3). "Reviewer" below means an assigned non-AC reviewer.

**Defaults for every paper unless its row says otherwise:**
- 3 complete reviews, with merit 3/3/4 and expertise ≥ 3;
- every review ≥ 200 words;
- an AC comment on day +1;
- reviewer comments up to day +13;
- no decision.

| pid | Fires (exactly) | Deviation from defaults |
|---|---|---|
| 1 | *(none)* | Decision set on day +10. This is the control. |
| 2 | `MISSING_REVIEWS` | Only 2 complete reviews. The third (the **reciprocal** reviewer's) is still empty. |
| 3 | `SPLIT` | Merit 1/4/4, then the low reviewer moves 1→2 on day +6, leaving 2/4/4. Movement suppresses `UNRESOLVED_SPLIT`. |
| 4 | `SPLIT`, `UNRESOLVED_SPLIT` | Merit 2/4/4, with no score change ever. On day +3 the AC `@mentions` **R-pinged** (one of the 4s). |
| 5 | `SILENT_DISCUSSION`, `AC_ABSENT`, `GONE_QUIET` | Merit 2/2/2. No comments at all. The last activity is review submission before 02-01. |
| 6 | `GONE_QUIET` | Merit 4/4/4. The last comment is on day +2. |
| 7 | `AC_ABSENT` | The AC never comments; the reviewers do. |
| 8 | `CHAMPION_MISSING` | Merit 5/4/4 (not 5/3/3: a range of 2 is `SPLIT`). The 5 reviewer never comments. |
| 9 | `LOW_EXPERTISE` | All expertise ≤ 2. |
| 10 | `THIN_REVIEWS` | One review is 35 words. |
| 11 | `RESPONSE_UNADDRESSED` | Merit 2/2/2 (so no top merit on the accept side can fire `CHAMPION_MISSING`). An author response is posted on 02-09. Reviewers never comment, and the AC comments on days +1 and +12. |
| 12 | `SPLIT` | Merit 2/4/4, with movement 1→2 on day +5. At the second instant (below), it also fires `DEADLINE_NO_CONSENSUS`. |

**Second assertion instant:** `PCS_NOW = 2030-03-01T12:00` (~2.5 days to decisions, inside the 3-day window). Assert only that pid 12 includes `DEADLINE_NO_CONSENSUS` and pid 1 fires nothing. Other rows drift with time and aren't asserted here.

**Rule semantics the table depends on:**
- `CHAMPION_MISSING` fires only if **no** reviewer holding the top merit has commented.
- `SILENT_DISCUSSION` and `GONE_QUIET` count AC comments as activity.
- `RESPONSE_UNADDRESSED` counts only reviewer comments.
- A paper with a decision fires nothing (pid 1).
- `GONE_QUIET` measures quiet time from `max(last activity, DISCUSSION_OPEN)`.

**People:**
- **R-silent** is the low scorer on 3, 4, and 12 and never comments. They top "silent on split papers" with 3. Because they're the low scorer, no `CHAMPION_MISSING` fires.
- **R-pinged** is pinged on pid 4 on day +3 and never comments there. That's an unanswered ping of 11+ days.
- **AC-busy** holds pids 1, 3, 4, 8, 9, and 10: 6 papers, 5 flagged, commenting on all of them.
- **AC-idle** holds pids 5 and 7: 2 papers, 0 comments, both flagged.
- **AC-normal** holds pids 2, 6, 11, and 12.
- The pid 2 laggard is tagged `reciprocal`. R-silent is tagged `junior`. Everyone else is senior.

Changing this table means changing the M3 and M4 tests in the same PR.

## M3: Store + sync

- **Scope:**
  - SQLite (SQLCipher) schema and migrations matching spec §3.
  - The full sync, with snapshot diffing that sets `first_seen_at` and `first_complete_seen_at`, writes `review_version` rows on vtag change, and records deleted/unassigned items.
  - Comment mention parsing.
  - The FTS5 index.
  - `/reviewhistory` backfill at `PCS_HISTORY_RPS`.
  - CLI: `pcs sync`, `pcs sync --watch`, `pcs backfill`, `pcs wipe`.
  - The sync is idempotent: two syncs with no changes produce zero new rows.
- **Done when:** the integration tests pass:
  - golden → sync → DB matches expectations;
  - the multi-stage run (stage 1 → sync → stage 2 with a score change, a new comment, an edited comment, a deleted comment, and an unassigned review → sync) produces exactly the expected `review_version`, `first_seen_at`, and deletion rows;
  - opening the DB with the wrong key fails.

## M4: Rules + metrics

- **Scope:**
  - A pure TS rules module: `(snapshot view, phase, now, env thresholds) → per-paper reasons + severity`, plus per-AC and per-reviewer metrics (spec §5a–5c).
  - Each rule is its own function, with a weight/threshold env override and a human-readable reason string that includes the numbers ("scores 1/4/4; no movement since discussion opened 14 days ago").
- **Done when:** unit tests encode the golden table above using in-memory fixtures (no harness needed); each rule has positive, negative, and boundary tests; and the phase logic is tested at several `PCS_NOW` values (before review-due, mid-discussion, two days before decisions).

## M5: Server + triage UI

- **Scope:**
  - A Fastify JSON API on `127.0.0.1:PCS_PORT`. It serves the built web app, and the token is never sent to the client.
  - Triage list: virtualized, with reason chips, filtering by AC, rule, and tier, and HotCRP deep links.
  - Paper drawer: a timeline of reviews, score changes, comments, mentions, and the response, with full text from the local store.
  - A sync-status indicator and a "sync now" button.
- **Done when:** the Playwright specs pass against golden:
  - the top of the triage list is ordered by severity as computed from the table;
  - paper 1 shows no chips;
  - paper 4's drawer shows the day +3 ping;
  - deep links point at `PCS_HOTCRP_URL`;
  - Argos screenshots of the triage list and the paper 4 drawer are stable across two consecutive CI runs, with no diff.

## M6: AC table, reviewer outliers, overview

- **Scope:**
  - The AC table (coverage, time to first post, nudges, stale, metareview status, load vs. flagged, sparkline).
  - Reviewer outlier lists (silent on split papers, unanswered pings, late, thin), split by tier.
  - The person page.
  - The overview with the no-consensus burndown.
  - The wording rules from spec §7, enforced by a test that greps the UI strings for "disengaged", "absent", and "lazy".
- **Done when:** Playwright asserts the people-level golden facts, and Argos baselines exist for the AC table, a person page, and the overview. In particular, AC-busy and AC-idle must be distinguishable at a glance: an assertion on the load column, not just the flag count.

## M7: Scale

- **Scope:** seed `scale` (2,400 papers / 40 ACs / ~10k reviews) in the nightly job.
- **Done when:**
  - a full sync takes under 5 minutes against the harness;
  - a re-sync with no changes takes under 2 minutes;
  - the triage list renders and filters in under 300 ms, and scrolling stays smooth (Playwright tracing);
  - DB size is reported in the job summary.

## M8: v1 actions

- **Scope:**
  - A copyable HotCRP search for any filtered set.
  - Nudge-comment drafts (the app copies the text; it doesn't post).
  - `#chair-attention` tagging, which always runs `dry_run=1` first, shows the diff, needs explicit confirmation, and then commits. It uses `POST /assign` rather than `POST /assigntags`, because `/assigntags` has no dry run (spec §1, §6).
- **Done when:** E2E against the harness shows the dry run changes nothing, the confirmed run sets the tags, and a re-sync shows them. No test ever targets a non-harness URL; the test helper refuses to start unless `PCS_HOTCRP_URL` is `127.0.0.1`/`localhost`.

---

## Phase 2: large-conference modules (after M8)

The discussion MVP ships first, on the shadow PC. These milestones implement spec §10. All of them are read-only, and each one's actions are generated HotCRP artifacts. Each needs its own seeded scenario. The seeder must grow:
- authors with affiliations;
- a reserve-designee submission field;
- the four tiers;
- a quick-reject review round;
- fixture CSVs for every `pcs import` kind.

| M | Scope | Done when |
|---|---|---|
| **M9** | Extended phase model + imports (`pcs import invites|tpms-assignments|tpms-registrations|refcheck|do-not-invite`), versioned | Each import kind round-trips from fixture CSVs; a malformed CSV produces a row-level error report, not a partial import |
| **M10** | Assignment validator (spec §10.4 C) | A seeded `assignment` scenario containing an all-junior panel, an overloaded senior, an unapproved reserve candidate, a do-not-invite hit, and a **deliberate reciprocal 2-cycle and 3-cycle** is fully flagged. The generated fix-up CSV passes HotCRP's `POST /assign?dry_run=1` on the harness |
| **M11** | Reserve compliance (A) + quick-reject tracker (B) | A seeded `registration` scenario (missing designee, inconsistent designee, invalid exemption, over-covered person) is fully flagged; the DBLP lookup is mocked in tests and off by default |
| **M12** | Reviewing-by-tier (D) + early reject (E) | A multi-stage scenario: candidates are computed at window open; some reviewers bump within the window, others don't; at window close the lists match expectations |
| **M13** | Process report (G) + pseudonymous export | The report renders from the `shadow` and `scale` scenarios; exported rows contain no email, only HMAC pseudonyms, stable for a given key |

## Open items (Jon)

- Shadow PC phase dates. These are only needed for real use; CI uses synthetic dates.
- Whether to add a post-hoc shadow-vs-real comparison (spec §5d). Not scheduled.
- Upstream HotCRP PRs (spec §10.5): action-log and mail-log endpoints; JSON `override` fix.
- Two-cycle support for phase 2? Undecided.
- Will TPMS provide a registration-status export?
- Make sure the `ripley-cloud-gha` App installation covers this repo (docs/ci.md, one-time setup).

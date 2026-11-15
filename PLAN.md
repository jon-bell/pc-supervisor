# Plan

This is the work breakdown for building PC Supervisor. Read [docs/concepts.md](docs/concepts.md) and [docs/spec.md](docs/spec.md) first; this file assumes them. Each milestone lists its scope, dependencies, and acceptance criteria. A milestone is done when its criteria pass **in CI**, not just locally.

**Already done:**
- the disposable HotCRP harness (`hotcrp/`, `scripts/hotcrp-up.sh`), and a smoke test that exercises every API path the app depends on (`scripts/harness-smoke.sh`) (2026-10-07);
- the CI workflow skeleton, which runs the harness on `ripley-cloud` (2026-10-07);
- the conceptual design ([docs/concepts.md](docs/concepts.md)) and the screening agent's design ([docs/agent.md](docs/agent.md));
- the Lean model ([model/](model/README.md)), below.

**Stack (decided 2026-11-13):** a desktop app on the JVM, in Kotlin with Compose Multiplatform. HotCRP is the shared record (spec §2, §11). The earlier TypeScript plan is retired; nothing of it was built.

**Progress (2026-11-13, branch `m1-foundations`, all checked on the local harness; CI not yet run):**
- **M0** done: `pcs probe`, with the settings spec §11 depends on.
- **M1** done: Gradle scaffold, generated readings, the answers reader (agrees with Lean), settings, Clock, the HotCRP client with strict decoding, contract tests, the claim inventory, `@Covers`, the assurance report, ktlint. The Lean-in-core spike works on Linux (decision provisional, below).
- **M2** mostly done: the seeder and `golden` (seeds in about 2 s), verified against the table through the strict client. The `shadow` (150 papers) and `scale` (4,000 papers) generators exist, with a fixed seed and reviews submitted 50 per request; `shadow` has not been seeded yet; `scale` was seeded and measured in M19 (20 minutes; it needs the raised API limits, `HOTCRP_API_PER_MINUTE` and `HOTCRP_API_PER_HOUR`).
- **M3** done: the encrypted store, the full sync (first-seen, versions, edits, deletions, unassignments, mentions, FTS), the history backfill, idempotence, and the multi-stage test.
- **Rules ahead of their milestones:** every rule in the model is ported to `core`; all 38 cards conform under every reading, and `core`'s fault switches match the model's 10 mutants. The discussion rules (M18's engine, not its UI) fire exactly the golden table end to end.
- **Found on the harness and fixed in the spec:** `/pc` has no per-user tags (tiers come from the appointments import); the API is rate-limited to 250 requests per window; `saveusers` takes tags as a string; response comments name their round; `/reviewhistory` needs `expand=1`; two golden rows contradicted spec §5c.
- **M4** done locally, 2026-11-14, branch `m4-app` (CI, Argos, macOS, and Windows not run):
  - **Done:**
    - `app` module: Compose Desktop 1.12.2 on Kotlin 2.4.21, bundled Inter font.
    - Keychain unlock on start (java-keyring through `core`; a failure is shown with "Try again"), conference picker (one `<id>.conf` and one encrypted DB per conference; settings problems listed, not opened), sync status and "Sync now" (`Session` in `core` runs `Sync` with `HotcrpClient`; the token and DB key never leave `core`).
    - One lazy table (`LazyTable`: sort, filter, column chooser, row click opens `/paper/{pid}` or `/review/{pid}{ordinal}` through a `UrlOpener`), used by the paper and review tables.
    - Settings screen: every question with its reading or "unresolved", and for each unresolved one the cards and ruling policy cells it blocks.
    - Card gallery: one screen per card, 38 of 38, rendered under the answered reading.
    - App driver and view reader (`app/src/test/.../testing`), checked both directions against HotCRP's own pids, titles, review ordinals and the golden table's merits.
    - `view:*` claims (5 screens plus 38 cards) added to the claim inventory; all 43 covered in the assurance report.
    - `uiTest` task; screenshots in `app/build/screenshots`; Roborazzi behind `Visual`/`RoborazziBridge` (`-Ppcs.visual=record|compare`, baselines in git-ignored `app/visual-baselines`, tested including a failing compare, with plain-capture fallback).
    - `release.yml` and the MSIX manifest template.
  - **Evidence:**
    - `GoldenUiTest` (opens synced `golden`, shows 13 papers, pid 4 resolves to `<url>/paper/4`), `ShellUiTest` (an unresolved Q10 appears with card X1; a complete file blocks nothing), `CardGalleryUiTest` (38 cards).
    - Three consecutive `./gradlew :app:uiTest` runs gave byte-identical screenshots (43 files, same SHA-256 list).
    - `scripts/package-linux-local.sh` builds a 124 MB `.deb` and the installed launcher passes `--smoke`.
    - `./gradlew check` green.
  - **Not done:**
    - Argos upload and its builds: out of scope here. CI's existing step uploads the whole `app/build/screenshots`; the cards need their own build (`--build-name cards`) from `app/build/screenshots/cards`.
    - macOS signing, notarization, and Windows MSIX never ran. The Store logo assets under `packaging/windows/Assets` don't exist yet, and the identity variables come from the Store account.
    - The Lean FFI library on macOS and Windows: one `continue-on-error` step for macOS only; Windows has none. The provisional model-in-core decision stays provisional.
  - **Deviations:**
    - This machine's JDK 25 has no `jmods`, so Compose's jlink step (`:app:packageDeb`) can't run here. Superseded 2026-11-15: Temurin 25 has no jmods anywhere, so the assumption that CI's has was wrong; see "Rulings applied" (`scripts/package-linux.sh`).
    - `uiTest` includes tests that need no harness (gallery, shell, settings); only `GoldenUiTest` needs it, so `check` stayed harness-free; since 2026-11-15 `check` includes `:app:uiTest` when a harness and a display exist.
    - "What an unresolved question blocks" is derived from `model/export/cards.json` and `policy.json` (shipped as `core` resources) because no feature-level map exists. The screen says so. Questions that no card or ruling cell depends on say "nothing in the model's cards or policy table yet".
    - Window size is fixed (1280x1400) and density is the test default of 1.0; the test API in this Compose version has no density parameter.
    - The `synthetic.txt` answers file leaves 12 questions unresolved, so the gallery shows blocked cards too.
- **M3a** mostly done locally, 2026-11-14, branch `m3a-runner` (CI not run; integration suite not yet re-run end to end on one fresh harness):
  - **Done:**
    - Model: `ReviewProcess/Traces.lean` and exports `traces-desk.json` (35 desk-reject traces under the signed and fix-window readings: one witness per admitted ground, one first use per granted cell, refusals, denials), `transitions-desk.json`, `binding-mutants.json`, and `actions.json` extended with action keys, args, and observations (readers per observation). `lake exe check-evidence` (CheckEvidence.lean) replays trace records through the gated step function, compares outcomes and every reader's observation, re-derives each verdict and the boundary log, and re-derives each control.
    - `runner` module: action types and per-reader observation enums generated from `actions.json` (bindings are exhaustive `when`s; early reject, accountability and appointment actions are explicit `UnboundAction` cases until M16/M17/M7/M15). Bindings: HotCRP actor, clock, file driver, state reader (core's synced store), HotCRP reader, role reader, with `core` as the chair stand-in (mirrors triage into `pcs-refer-*`, applies `DeskReject.mayRemove` before the decision). `ScenarioRunner` writes evidence records with provenance.
    - Boundary observer: reverse/forward proxy allowing only the harness, JDK name-service provider refusing other names, file-write monitor, log capture, canary scan (token allowed only in the Authorization header).
    - `core` Conventions gained `pcs-remedy-due#<epoch>` and `pcs-warned` traces. CI runs `check-evidence` after the integration tests. Assurance report gained families, policy-coverage and transition-coverage sections.
  - **Evidence:** `RunnerTest` ran all 35 traces against the harness with no mismatch and no boundary violation (7 min); `check-evidence` on the 35 records: 0 failing. `ControlsTest` wrote `controls.json` (every M3a binding mutant caught: actor skips an action, clock does not advance, role reader reads as chair, HotCRP reader drops last row, state reader stale, observer misses a socket, a file write, a canary; spec mutant "silence removes" caught end to end); `check-evidence` passes it and fails when a control is removed. `ObserverTest` and `ObserverUnitTest` cover the planted canary to a non-harness host and the planted log line holding the token. `./gradlew check` green.
  - **Not done:**
    - One end-to-end `./gradlew integrationTest` on a fresh harness (the three runner classes were run in parts; `ObserverTest` passed in the first parts run).
    - `view-reader-drops-last-row` control (M4's view reader). Spec mutant `secondOpinionFromAnyone` is not caught end to end: the model's opinions come from persons 2-4 only and HotCRP allows one review per person, so the referring AC cannot give one. The other mutants need subsystems beyond desk reject.
    - Early reject, accountability and appointment traces and bindings; transition coverage is low (witness traces only); policy coverage is reported, not gated.
  - **Deviations / decisions needed:** the cure is an abstract edit by the author (the harness upload directory isn't writable); the model's stage lives in a file until M6's phases; `pcs-warned` and `pcs-remedy-due` need rows in spec §11 (adding rows renumbers `conv:` claims, so left for the maintainer); metareview unsubmit-and-move after triage is not performed.
- **M17** done locally, 2026-11-14, branch `m17-early-reject` (CI not run; full validation on one local harness):
  - **Done:**
    - Model: `traces-early.json` (35 early-reject witness traces under four Q15/Q16 readings: a path to an early reject, first use of each granted cell, refusals before the window closes, after a bump and with a positive review, the Q15 boundaries, denials, and the no-window cases), early-reject observations in `actions.json`, and `check-evidence` replay for the subsystem. No semantics or proofs changed; oracle corpora and `model-report.txt` regenerate unchanged.
    - `core`: `earlyreject/` (`EarlyRejectPlan`: candidates from the snapshot at the window's opening, bump window from review versions after it, status per candidate through the model's `mayEarlyReject`; `EarlyRejectArtifacts`: the Mail-tool draft and the decision artifact as data), `Session.earlyReject()`, settings `PCS_SCORE_MAP` and `PCS_EARLYREJECT_WINDOW_H`, and `pcs-er-object` as a decoded convention trace.
    - `runner`: the four early-reject actions and the observations are bound (no `UnboundAction` left for the subsystem); the spec mutant "early reject before the window closes" is a control that must be caught end to end.
    - `app`: an Early reject tab (LazyTable of candidates with status, initial scores, bump status, AC objection; the mail search and the decision CSV, copyable).
    - `seed`: the `early-reject` scenario (papers 201-210, window 2030-02-02 to 02-04).
  - **Evidence:** `EarlyRejectPlanTest` (unit, `prop:E-1`, `prop:E-2`, `card:R1`-`R4`), `CardsTest` (R1-R4 already generated tests), `RunnerTest` (the 35 early traces against the harness, no mismatch, no boundary violation), `ControlsTest` (the early mutant caught), `EarlyRejectScenarioTest` (seeded `early-reject`: candidates at opening, bumps at +12 h and +45.6 h, the change after the close ignored, lists at the close and at +1, +11, +13, +45, +47, +48, +49, +72 h), `EarlyRejectUiTest` (view at three instants, blocked state), `lake exe check-evidence` (71 records, 0 failing: 70 traces plus controls). `./gradlew check` green; `uiTest` green on a fresh harness (6 tests across 4 classes).
  - **Not done / deviations:**
    - The runner integration suite ran in two parts on one harness: `RunnerTest` (both trace sets) in the full run, then `ControlsTest` and `EarlyRejectScenarioTest` alone, because the harness's rate limit ran out after an hour of load (the full run's controls hit 429). The clients now wait longer and the runner retries a rate-limited sync.
    - `EarlyRejectScenarioTest` is `@Order(0)`: it runs before the runner installs its JVM-wide proxy, which the seeder's direct connection does not survive.
    - The decision artifact converts to M5's Writeback `DecisionArtifact` (`toWriteback()`, `Session.draftEarlyRejectDecisions()`); no UI button yet, and no end-to-end apply test against the harness. PC Supervisor sends nothing. `DecisionArtifact.toCsv()/toJson()` and `MailDraft` are the interface; the CSV format `paper,action,decision` is HotCRP's bulk-assignment form, not yet verified against HotCRP's `/assign` by a Writeback test.
    - The paper-number search (`201-204 207 208`) was not run through HotCRP's Mail tool; E-2 is tested on the recipients the draft computes.
    - The app's sync does not run the `/reviewhistory` backfill, so the window is computed from the snapshots the app's own syncs take. A window opened retroactively needs `Backfill` (the scenario test runs it).
    - Transition coverage in the assurance report is still desk-reject only; `transitions-early.json` was not exported.
    - `prop:E-2` is tested at unit level and in the scenario, not through T3 over every transition.
  - **Decisions needed:** (1) the AC objection is the hidden tag `pcs-er-object`, set by a chair; it has no row in spec §11 yet (adding one renumbers `conv:` claims). (2) `PCS_SCORE_MAP` default is HotCRP's default Overall merit form, which has no "borderline"; a venue whose scale does should set it. (3) A paper counts as a candidate only if a review version was seen at or before the window opened; say whether the app should run the backfill when the window date is already past.
- **M18** done locally, 2026-11-15, branch `m18-discussion` (CI, Argos and macOS/Windows not run):
  - **Done:**
    - `core/rules/Discussion.kt`: one function per spec §5c rule (`Discussion.RULES`), each with a weight (`PCS_RULE_<NAME>_WEIGHT`) and thresholds (`PCS_THRESH_*`, via `Thresholds.fromSettings`, which reports bad values), reason strings with the numbers, `severity`, `stage`. Phases: the talk rules (UNRESOLVED_SPLIT, SILENT_DISCUSSION, GONE_QUIET, AC_ABSENT, CHAMPION_MISSING, RESPONSE_UNADDRESSED) wait for `DISCUSSION_OPEN`; MISSING_REVIEWS waits for `REVIEW_DUE`.
    - `core/discussion/`: `DiscussionReports.build` gives per-paper risk (sorted by severity, then time to decisions, then pid), per-AC rows (§5b: coverage, time to first post, nudges, stale, metareview status, load, 14-day activity), per-reviewer rows (§5a: outstanding and late from the M16 report, depth decile, rating flags and coaching, participation, response time, unanswered @mentions, movement, silent on split), the person page, the drawer timeline, and the overview (stages, spread, flagged per AC, the no-consensus burndown). `Session.discussion()` loads it; `MirrorView` now carries titles, ordinals, comment words and ids, expertise versions, and marks version times approximate until the review's history is read (H3).
    - `app`: a Discussion tab (triage with chips and AC/rule/tier filters, paper drawer, AC table with a sparkline, reviewer outliers by tier, person page, overview with burndown), `DiscussionText` (all rule and stage wording), `Col.chart` in `LazyTable`.
  - **Evidence:** `DiscussionRulesTest` (every rule positive, negative and boundary), `DiscussionGoldenTest` (the table in both directions at both instants, triage order, AC and reviewer people, drawer, overview), `DiscussionPhaseAndSettingsTest` (phase logic at ten `PCS_NOW` values, thresholds and weights), `DiscussionMetricsTest`, `MirrorViewTest` (`prop:H3`), `WordingTest` (no "disengaged", "absent" or "lazy" in any UI or reason string literal), and `DiscussionUiTest` on golden (chips for every `golden:pid*` row in both directions, the day +3 ping in paper 4's drawer, the load column for AC-busy and AC-idle, the person page for R-silent, the overview; screenshots under `golden/discussion/`). The `MirrorTest` integration test still checks the table through the real sync and backfill.
  - **Not done / deviations:**
    - The app's sync does not read review history, so the UI test fills the mirror with `Sync` and `Backfill` before opening the app. Until the history is read the screen says so (a note) and times show a `≈`.
    - `/pc` carries no tags and golden has no appointments import, so the UI test sets R-silent's and the laggard's tier tags on the mirror's people.
    - HotCRP records no time for a decision, so the burndown counts a decided paper by its scores like any other.
    - No Argos baselines (no token); Roborazzi screenshots are in `app/build/screenshots/golden/discussion/`. The tab row is now crowded enough that "Accountability" wraps.
  - **Decisions needed:** (1) CHAMPION_MISSING, GONE_QUIET and RESPONSE_UNADDRESSED are held until discussion opens (spec §5c names no phase for them); the old engine fired them during reviewing. (2) "Unanswered ping" is an `@mention` with no later comment from that person; AC comments without a mention count toward reply time but are not listed as pings. (3) "Older than N days" is a strict comparison on elapsed time, not whole days. (4) "Then time to DECISIONS_DUE" is constant across papers with one deadline, so ties fall to pid. (5) Coaching case: negative flags (short, vague, needswork, narrow, wrong) on at least `PCS_THRESH_COACH_PAPERS` (2) papers; a new setting. (6) Tier filter on papers: papers with a reviewer of that tier.
- **M5** done locally, 2026-11-14, branch `m5-writeback` (CI not run):
  - **Done:**
    - `core/writeback`: `Writeback` (draft, HotCRP dry run, confirm by a chair, apply, with a fresh dry run just before the write so a stale confirmation is refused), `Ledger.observe` (run by every sync: an applied artifact shows its effect or is flagged `mismatch`; an observed one is rechecked, so a later revert is flagged; a later artifact on the same tag, review or comment supersedes an earlier one), `HotcrpWriter` (the only write code; internal constructor; `notify=0`). Artifacts: tags (hidden `pcs-*` included), assignment CSV or rows, comments (new or edit), decisions with a notice, review moves (unsubmit then normal round, for the AC's triage metareview and Q5 second opinions), PC membership and tier tags (handed to a chair, see below). Migration 005 adds `review.round`, the ledger and `instance_fact`.
    - Conventions: `Conventions` parsers for the `Triage` field (1 keep, 2.. grounds) and the `[pcs:findings]` comment marker; `ConventionAudit` reports unparsed tags and markers, contradictory traces, a Triage written by a non-AC, a findings comment by a non-chair, and an instance whose `tag_hidden` doesn't cover `pcs-*`. `ScreenRound` drafts moves from trusted triage only. `Load.byPerson` leaves screen-round reviews out.
    - First actions: copyable search (`FirstActions.searchLink`, button in the papers table), nudge comment draft, `#chair-attention` tag draft (`PCS_TAG_CHAIR_ATTENTION`).
    - App: Writeback tab (list, HotCRP's dry-run diff, "Confirm and apply"), Sync report tab (mismatches and trace issues), toolbar slot in `LazyTable`; `view:writeback` and `view:report` claims.
    - Spec §11: every *verify* row settled (see the table), rows 13 (`pcs-remedy-due`) and 14 (`pcs-warned`) **appended**, so no existing `conv:` id moved; 14 of 14 convention claims covered.
    - Localhost guard: `net.jonbell.pcs.testing.LocalHarness.require` (parsed host, no userinfo), used by the core and app helpers, tested in `LocalHarnessGuardTest`.
  - **Evidence:** on a fresh harness (down -v, up, seed golden): `:seed:integrationTest` 5, `:core:integrationTest` 42 (`WritebackTest` 12: per artifact kind the dry run changes nothing, the confirmed run changes HotCRP, the next sync observes it; revert flagged and unflagged; stale dry run refused; `applyWithoutDryRun` fault is the only way past the gate; non-chair can't confirm; `ConventionRowsTest` 9), `:runner:integrationTest` 5, all passing; `:app:uiTest` (incl. `WritebackUiTest`) passing on a fresh harness; `./gradlew check` green. Assurance report: convention 14/14, view 45/45, failing 0.
  - **Findings that changed the design (all verified on the harness):**
    - HotCRP keeps tag values to about six significant digits (1893456000 comes back 1893460000). `pcs-remedy-due` now carries whole **hours** since the epoch; `Conventions` converts, and the M3a runner binding now writes it through `Conventions.encode`.
    - A Bearer token reaches the API but no web page (Mail page: 401), and there is no API call that writes users. The mail tool therefore can't be driven or verified for one reviewer: only `GET /api/{p}/mailtext` previews (any PC member). Replacement in spec §11: PC Supervisor drafts the text and search, a chair sends, then records `pcs-req-*` through Writeback. PC membership and tier tags are a `UserArtifact` handed to a chair as `saveusers` JSON; there is no HotCRP dry run for it (the preview compares with the mirror), and the sync observes only the role and that the tag is in use, because `/pc` lists no per-user tags.
    - A tag's author can't be read from HotCRP, so forged tags can't be attributed; that gap is closed by `tag_hidden = pcs-*` (verified: only administrators set or see hidden tags) plus the report when the setting is absent. Forged triage and findings comments are attributed by author and ignored.
    - The new PDF version works through `content_base64` in `POST /api/{p}/paper` (needs submission open); the harness upload API still fails (`filestore/tmp` is root-owned), but isn't needed.
    - HotCRP can print PHP deprecation notices before JSON; the test helper skips to the first `{"`.
    - New review-JSON key `hidden_fields` added to the unread set.
  - **Not done / deferred:**
    - CI, Argos, macOS and Windows not run. Writeback has no CLI command yet, and there is no UI for revising a draft, for decisions, assignments or user artifacts (the core supports them; the app drafts only the `#chair-attention` tag; nudges and review-move drafts have core functions but no button).
    - `prop:M2` is covered for Writeback mismatches only; notifying the chairs is later UI work.
    - Mutation score for Writeback code (PIT) and the T4/T6 denial matrix for the remaining `cell:*` were not run.
    - Migration 005 and the `view:` and `conv:` rows may conflict textually with M17's branch; renumber the migration on merge.
- **Next:** seed `shadow` and time a full sync; M3a (scenario runner and evidence checker); M4 on CI (Argos, macOS, Windows). Coverage still open: rules 3/9, properties 3/45, policy cells 0/207, conventions 5/12.

## Order

Milestones follow the order in which the review process needs them, so the pieces a conference needs first are built first: nominations and screening at submission, then assignment, then reviewing, then discussion.

```
Phase A  M1 foundations ──┬── M2 seeder ──┬── M3 store + sync ── M3a scenario runner + evidence ── M4 app shell ── M5 Writeback + conventions
                          │               │
Phase B                   │               └── M6 imports + phases ── M7 nominations + appointments
                          ├── M8 extraction ── M9 engines ── M10 LLM checks ── M11 evaluation ── M12 qualification + bundle
                          │                                                                         │
                          │                                         M13 triage + desk reject ◄──────┘ (also needs M5)
Phase C                   └── M14 solver core ── M15 assignment (needs M5, M7)
Phase D  M16 reviewing + accountability requests ── M17 early reject ── M18 discussion dashboard ── M19 scale
Phase E  M20 process report ── M21 federated evaluation kit
M0 probe (needs only M1's HotCRP client; the maintainer runs it against the live instance)
```

After M1, four tracks can go to different people: harness-side work (M2, M3), the screening agent (M8–M12), the solver (M14), and the app shell (M4, once M3's schema exists). The **golden scenario table** below is the contract between M2, M3, and M18; the **model's example cards** are the contract for every rule.

## Repo layout and the Gradle task contract

Use Gradle (Kotlin DSL) with a version catalog, Kotlin on JDK 25, and one module per row of spec §4.

```
core/     sync, store, rules, solver, Writeback, answers reader, imports (no UI imports)
app/      Compose Multiplatform desktop UI
cli/      `pcs`
agent/    screening agent (docs/agent.md)
seed/     scenario format, driver, scenarios/{golden,shadow,scale,...}
model/    Lean model (done)
hotcrp/   harness image (done)
scripts/  harness scripts (done)
e2e/argos-canary/  Argos setup check (done)
```

CI calls exactly these tasks, so keep the names stable:

| Task | Must do |
|---|---|
| `./gradlew check` | ktlint and detekt, compile, unit, property, and model-generated tests. No network, no Docker |
| `./gradlew integrationTest` | contract and seed→sync→assert-DB tests against the running harness (reads `.env.test`) |
| `./gradlew uiTest` | seed `golden` → sync → Compose UI tests, writing screenshots for Argos |
| `./gradlew scaleTest` | seed `scale` → timed sync and solve |
| `./gradlew packageReleaseDistribution` | signed installers (the release workflow only) |
| `cd model && lake build` | checks every proof; regenerates nothing |

The CI steps are gated on `settings.gradle.kts` existing, so they switch on automatically.

---

# How we establish that the specification is implemented

This part of the plan says how every claim in docs/concepts.md gets evidence, how that evidence is checked, and how we know what it misses. The milestones below each end with the claims they must bring to the coverage gates of §A7.

## A1. What "implemented" means

The implementation conforms to the specification when three things hold. Each needs its own kind of evidence, and passing tests for one says nothing about the others.

1. **Every run is a run the model allows (safety).** Seen through the bindings (§A4), every sequence of actions and observations in the real system (HotCRP, sync, `core`, the app) is one the Lean model's step functions produce, and every proved property holds of it.
2. **What one observer sees doesn't depend on what they may not see (relational).** Some properties compare two runs: S7 (revising a ruling never removes a paper), S11 (load doesn't depend on second-opinion answers), C2 (authors can't tell who gave an opinion), AR3 (suggestions don't depend on review text), AR4 (a dismissed suggestion leaves no trace), C1 and S5 (text reaches no uncleared party). A single run can't violate these, so single-run tests can't establish them.
3. **What the specification promises can actually happen (possibility).** Every example card's outcome, every admitted ground, early reject, and nominee appointment (L2), and every granted policy cell (L1) is reachable in the real system. Without this, an implementation that refuses everything passes 1 and 2.

## A2. The claim inventory

Every claim has a stable, namespaced ID, and every test names the claims it is evidence for.

| Namespace | Source | Count today |
|---|---|---|
| `prop:` | concepts §3.10 properties (`prop:S1`, `prop:AR5`, `prop:Q1`) | 45 |
| `card:` | concepts §3.11 example cards (`card:X9`, `card:C3`), one claim per card and reading | 41 cards |
| `rule:` | concepts §3.8 rules (`rule:may-remove`, `rule:owes`, `rule:composition`) | ~10 |
| `cell:` | concepts §3.9 policy cells (`cell:ac/triage`), one per role and permission | 207 (9 roles × 23) |
| `conv:` | spec §11 HotCRP conventions, one per row | 17 |
| `golden:` | the golden table rows (PLAN M2) | 13 |
| `assume:` | concepts §3.12 assumptions (`assume:A2`) | 8 |
| `q:` | open questions and their readings (`q:Q13=one-junior-or-nominee`) | 20 questions |

`model/` exports the inventory as `claims.json` (`lake exe export`), so a claim exists exactly when the specification states it. Tests carry `@Covers("prop:S1", "card:E7")`. The build fails on an ID that isn't in the inventory, so a renamed or deleted claim can't leave orphaned tests that look like coverage.

## A3. The model as oracle

The Lean model answers every question a test asks about expected behavior. Kotlin test code never re-derives an expected result. It asks the model.

- **`lake exe oracle`**: a long-running process that reads JSON queries on stdin and answers on stdout. Queries: evaluate a rule (`rule:may-remove` on a referral under a reading), step a subsystem (state, role, action → next state or refusal), project an observation (what role R sees in state S), and check a property on a recorded trace.
- **Vector corpora**: for the CI fast path, the oracle writes fixed corpora (bounded-exhaustive small inputs plus seeded random ones) with expected outputs. Nightly runs ask the live oracle about fresh random inputs.
- **Trace export**: the trace search (`Policy.lean`) writes witness traces for every L2 goal and every granted cell, bounded-exhaustive traces for each subsystem up to a depth, and seeded random walks. Each step of a trace carries the model's expected observation for every role.
- **One meaning.** The predicate a theorem proves is the same Lean function the oracle evaluates on a recorded run. If the proof is about the wrong thing, the tests are about the same wrong thing, which is why §A9's specification-side checks exist.

**Decision for M1: the proved model as the decision core.** Lean compiles to C. The pure decision functions (`may-remove`, `composition`, `owes`, `mayEarlyReject`, the policy gate, the solver) could be compiled into a native library and called from `core` through the JVM's foreign-function interface. Those decisions would then be the proved code, not a Kotlin re-implementation tested against it, and their manifest grade would rise from "certified test" to "proved, assuming the Lean compiler and the FFI marshalling". M1 includes a spike that builds the library on macOS, Windows, and Linux and calls `may-remove` from Kotlin. If it works on all three, the decision functions come from Lean, and Kotlin holds I/O, storage, and UI. If it doesn't, they are written in Kotlin and differentially tested against the oracle (family T2 below). The rest of this section holds either way.

## A4. Bindings: from model actions to the real system

A binding maps a model action to something done to the real system, and a model observation to something read from it. The bindings are test code, so they are the main thing a reviewer still has to trust, and they are challenged by mutation (§A8).

| Model element | Binding | Real interface |
|---|---|---|
| An action by an AC, PC member, nominee, junior PC chair, or author | the HotCRP actor | the HotCRP API as that user (`actas`, the user's own token on the harness), leaving the spec §11 trace |
| An action by a chair | the app driver | the Compose UI, through test tags on the semantics tree; a lower-level variant calls `core` directly |
| Time passing | the clock | `PCS_NOW`, advanced between steps, then a sync |
| An import | the file driver | `pcs import` with a generated file |
| What a chair sees | the view reader | the semantics tree of each screen, read into a structured observation (rows, reason chips, blocked features) |
| What PCS decided | the state reader | `core`'s derived state and Writeback artifacts |
| What HotCRP holds | the HotCRP reader | the API as a chair |
| What a non-chair role can see | the role reader | the API as that role |
| What leaves the machine | the boundary observer | every socket and DNS lookup the test JVM opens (through a proxy and a resolver the test controls), and every file written outside the DB path |

- **Completeness is checked by the compiler.** Model actions and observations are generated Kotlin sealed types (from `lake exe export`), and the binding is an exhaustive `when` over them. A model action without a binding doesn't compile.
- **Views are bound in both directions.** The view reader checks that every item on a screen corresponds to an expected observation, and that every expected observation is on the screen. A dashboard that shows an extra paper or hides one fails, just as one that shows the wrong reason does.
- **Forged traces.** Because HotCRP is the shared record, anyone with HotCRP access can write a trace that looks like another role's: a PC member tagging `pcs-refer-format` on a paper they don't chair. The HotCRP actor can act as any user, including one without the right, so denial tests (T6) run through the same binding.

## A5. Test families

| Family | Evidence for | Generated from | Runs against | Count, roughly |
|---|---|---|---|---|
| **T1 Cards** | `card:*`, `q:*` | the exported cards: one test per card and per reading that changes its outcome | `core` (fast), then as a scenario end to end | 41 cards × their readings |
| **T2 Rule differential** | `rule:*` | jqwik generators over each rule's inputs and every reading; the oracle gives the expected output | `core` | 10⁴ inputs per rule per CI run, 10⁶ nightly |
| **T3 Model-based traces** | safety `prop:*` | bounded-exhaustive and random traces from the trace search; after each step, compare every observation with the model's; at the end, check every proved property on the recorded trace with the Lean predicate | the full stack: harness + sync + `core` + app | every transition of each subsystem, plus 10³ random walks nightly |
| **T4 Paired runs** | relational `prop:*` (S7, S11, C2, AR3, AR4) | pairs of traces that differ only in the secret (who gave the opinion; the review text; whether a suggestion was dismissed); compare the stated observer's view | the full stack | ≥ 200 pairs per property per night |
| **T5 Possibility** | `prop:L1`, `prop:L2`, granted `cell:*` | the trace search's witness traces | the full stack | one per goal and granted cell |
| **T6 Denials and forged traces** | denied `cell:*`, `conv:*` | for each denied cell with an action, the action attempted through the binding by that role; for each convention, the trace written by a role that may not write it | the full stack | one per denied cell with an action, one per convention row and unauthorized role |
| **T7 Boundary** | `prop:C1`, `prop:S5`, `prop:H4`, `prop:H5`, spec §7 | canary strings planted in review text, comment text, the token, and the DB key; the boundary observer scans every byte that leaves and every file written, and fails on any canary or any destination other than the harness | the full stack, including the screening agent with the replay engine | every T3 and T4 run carries the observer |
| **T8 Conventions round-trip** | `conv:*` | for each row of spec §11: encode in the model, write through HotCRP, sync, decode in `core`, and compare with the model's decode | harness + `core` | every row, with values from the model's types |
| **T9 Scenarios** | `prop:Q1`, budgets of M19 | the `scale` scenario; each budget names its workload, environment, and statistical test (the 95th percentile over 10 runs, with its confidence interval) | the full stack on `ripley-cloud-large` | nightly |
| **T10 Monitors** | `prop:M1`–`prop:M4` | seeded anomalies (an AC whose referral rate is out of band, a stale import, a Writeback mismatch, a conflict-engineering pattern) | the full stack | one positive and one negative per monitor |
| **T11 Contract** | `assume:A2` (in part) | strict schemas against the harness, and the M0 probe against the live instance | HotCRP | every endpoint we read |
| **T12 Visual review** | `view:*` (below) | screenshots of the main screens at fixed states of `golden` and the other scenarios, plus the **card gallery**: every card rendered in the real app under the answered reading. Each screenshot is named by its claim and state (`card-E7/triage-queue`, `golden/ac-table`) | the app, uploaded to Argos from CI | a curated set; T3 runs don't screenshot every step |

**What T12 is evidence for.** The view reader (§A4) checks what a screen *says*: every expected observation is shown and nothing else. It can't check whether the screen is legible, puts the reason a chair needs first, or follows the wording rules of spec §7. That takes a person. T12 adds a claim namespace `view:` (one per screen, plus one per card in the gallery), and its evidence is an **Argos approval**: the build link and the approver go into the evidence record, and the manifest grades the claim "human-reviewed view" for that release. An approval is a judgment of presentation, never a substitute for the view reader's two-way check.

Existing hand-written tests (the golden table, harness smoke) are kept and tagged with their claims. A hand-written test may add evidence, but it never replaces a generated one.

## A6. Evidence records and the checker

Every T3–T10 run writes an **evidence record**: the scenario ID and generator seed; the model commit; the app build hash; `HOTCRP_REF`; the answers file hash and the configuration; the recorded trace (actions as bound, observations as read); the boundary log; and the control runs (§A8). The test's own pass/fail is not part of the evidence.

`lake exe check-evidence` is a small Lean program that re-derives each verdict from the record: it replays the recorded actions through the model's step functions, compares each recorded observation with the model's, evaluates each claimed property's predicate on the trace (on both traces, for a pair), and confirms that the controls ran and failed as they should. A reviewer then trusts the model, the checker, the bindings, and the runner, not the Kotlin test code. The manifest lists the bindings and the runner as assumptions until something stronger exists.

## A7. Coverage criteria and gates

The assurance report (`./gradlew assuranceReport`, run in CI) computes each criterion and fails the build where a gate applies.

| Criterion | Measure | Gate |
|---|---|---|
| Claim coverage | every claim in the inventory has evidence of the family its kind requires (safety → T3; relational → T4; possibility → T5; rule → T1 + T2; cell → T5 or T6; convention → T6 + T8) | 100% for the claims of every finished milestone |
| Reading coverage | for each open question, every reading that changes some card's outcome is exercised by T1, and the venue's answered reading by every family | 100% |
| Transition coverage | the share of the model's transitions (per subsystem of the trace search) taken by some T3 run end to end | 100% of transitions for each subsystem with fewer than 10⁴ states; above that, all transitions within depth 6, and the rest reported |
| View review | every `view:*` claim has an approved Argos screenshot in the current build; the Argos GitHub check blocks merging an unreviewed visual change | 100% for the screens of every finished milestone |
| Policy coverage | every granted cell exercised by T5; every denied cell on an action confirmed by T6 | 100%; cells with no modeled action are listed as visibility cells, enforced by T7 |
| Binding coverage | every model action and observation has a binding | compile-time (exhaustive `when`) |
| Implementation mutation | the share of PIT mutants in `core` killed by spec-derived tests (T1–T10, not hand-written unit tests) | ≥ 85% in rule and Writeback code, with every survivor triaged as equivalent, a missing claim, or a missing test |
| Specification mutation | every model mutant (`Params` in `Model.lean`), injected into `core` through a test-only fault switch, is killed end to end by T3–T6 | 100% |
| Binding mutation | every binding mutant (§A8) is caught by a control or a cross-check | 100% |
| Unspecified code | lines of `core` and `app` that no spec-derived test executes (Kover) | reported, not gated; each block is dead code, a missing claim to raise with the chairs, or infrastructure |

Code coverage is a secondary signal here, read in reverse: it finds code that no claim reaches, which is either dead or doing something nobody specified.

## A8. Mutation, controls, and what they challenge

- **Implementation mutants** (PIT on `core`'s bytecode) challenge the tests' sensitivity to ordinary faults.
- **Specification mutants** are the semantic faults the model already names: silence removes, a second opinion from anyone, assign an unaccepted nominee, combine ignoring Q18, a declined share moved to someone unnamed, early reject before the window closes, a dismissed suggestion counted, a heuristic sending by itself, apply without a dry run, cycle check with K = 1. `core` carries the same switches, off in production builds and compiled out of release artifacts. Each must be caught end to end, not only in unit tests.
- **Binding mutants** are faults in the test code that would make a broken system look correct: a view reader that drops the last row, a role reader that reads as a chair, a HotCRP actor that silently skips an action, a clock that doesn't advance, a boundary observer that misses one socket. Each binding has a **positive control** (the observer must see the harness traffic it knows is there; the role reader must fail to see what the model says that role can't see) and a **negative control** (a known-violating build, made with a specification mutant, must fail the same scenario).
- **Specification checks** challenge the model itself, as concepts §5 describes: the legibility check, readings narrowing, unrealizability, and the human review of cards and the policy table. Testing can't find a requirement nobody stated; §A11's sign-off is where that is addressed.

## A9. Residual risk

A mutation score says how sensitive the tests are to a fault set. It isn't an estimate of what testing missed. For the random families (T2, T3, T4), we will report a residual-risk estimate in the style of STADS (Böhme, TOSEM 2018), which treats testing as sampling from the space of behaviors. The species are the model transitions and observation classes a run exercises, and the estimate is the probability that the next run under the same generator discovers a new one. It is calibrated against held-out specification mutants that the generators were not tuned on. The report states its limits: it covers only behaviors the generator can produce, and it says nothing about an attacker who searches. Only the proofs in `model/` hold against an attacker, and only for the model.

## A10. Change and evidence invalidation

Each evidence record lists what it depends on: the claims, the model files, the `core` and `app` modules on its path, and the bindings. A change that alters a gallery screenshot invalidates that card's confirmation as well as its tests. A change re-runs the evidence whose dependencies changed and marks the rest as reused, and the manifest shows which. A change to concepts.md that adds or changes a claim makes that claim uncovered until new evidence exists, which fails the gate for its milestone.

## A11. Sign-off and the assurance manifest

The specification's grade comes from people, not tests. For each deployment the manifest records:
- the answers file, with who settled each reading and which remain unresolved;
- the cards the PC chairs confirmed, and the readings narrowed by them. The chairs confirm each card **as the app renders it**, in the Argos card gallery, not as text. When a change alters how a card renders, Argos shows exactly which cards changed, and those cards need confirming again (the human half of §A10);
- the policy table as signed, with its unexamined cells (the dots) counted;
- the spec §11 conventions, confirmed on the harness (M5) and on the live instance (M0's probe);
- the assumptions (`assume:A1`–`A8`), with who accepted each.

Then one row per claim: how it is established (proved in the model; proved and compiled into `core`, if the M1 spike succeeds; certified test with its evidence records; monitor; assumed), whether it holds against an attacker or only on sampled inputs, its assumptions, and whether its evidence was reused, re-run, or new in this release. `pcs assurance manifest` renders it from the evidence records and `claims.json`.

**Release gate.** No build is used on a real conference until its manifest has every claim of the finished milestones covered, `check-evidence` passes on every record, the binding controls pass, and the PC chairs have signed the specification rows.

---

# Phase A: Foundations

## M0: Probe the live instance

- **Scope:** `pcs probe` is a read-only CLI that calls every endpoint the sync uses. It prints a **shape report**:
  - response keys and types;
  - counts (papers, PC, reviews by `rtype`/`status`, comments);
  - review-form field UIDs, with each score field's value range;
  - user tags present, and the tag-visibility settings that spec §11 depends on;
  - the rating settings (`review_rating`, `review_rating_visibility`) and how many reviews carry ratings;
  - whether `modified_at` is present on reviews and comments.
- It **prints no content**: no titles, names, emails, or text.
- **Depends on:** the HotCRP client from M1.
- **Done when:** it runs green against the harness in CI, and the maintainer has run it against the live instance and pasted the report into an issue. That report sets the defaults (`PCS_FIELD_*`, `PCS_MERIT_ACCEPT_MIN`, `PCS_TIER_TAGS`).

## M1: Foundations

- **Scope:**
  - The Gradle scaffold with the modules and task contract above.
  - `core` config: one typed loader over env and `pcs.conf`, plus the answers file (spec §4.1). It fails at startup and lists every problem at once. `pcs.conf.example` documents every key.
  - Reading types **generated** from `model/`'s JSON export (`lake exe export`), so a reading the model doesn't know is a compile or startup error. The answers reader uses the same format as the Lean parser, and both parse `model/answers/synthetic.txt` to the same readings (a test).
  - **Card tests:** a Gradle task turns the model's exported cards into parameterized JUnit tests. Each rule implemented later registers a function the card's outcome is checked against. In M1 the pipeline runs with a stub that marks every card "not implemented".
  - `core` `Clock`: the only source of "now". It honors `PCS_NOW`.
  - `core` HotCRP client: bearer auth, `pretty=0`, POST-as-GET (`:method:=GET`), pid-range chunking, bounded concurrency, and retry with backoff on 429/5xx. Every response is decoded strictly, so schema drift surfaces as a contract-test failure.
  - Secrets: the token and DB key from the OS keychain (`java-keyring`), with the localhost-only env fallback.
  - Contract tests run the schemas against the seeded harness.
  - **Assurance scaffolding (§A2, §A3):** `claims.json` from `lake exe export`; the `@Covers` annotation and the build check that rejects unknown claim IDs; a first assurance report listing every claim as uncovered; the client for `lake exe oracle`, with a T2 differential test for one rule (`rule:may-remove`) over every reading.
  - **The Lean-in-core spike (§A3):** compile `may-remove` from `model/` to a native library on macOS, Windows, and Linux, and call it from `core` through the JVM's foreign-function interface. Record the result and the decision in this file.
- **Spike result (2026-11-13, Linux):** it works. `model/ffi/build.sh` builds Lake's shared library of `ReviewProcess` plus a C shim (`model/ffi/pcs_ffi.c`) that initializes the Lean runtime once and each calling thread on first use, and exchanges JSON strings with one exported function, `pcs_answer`, which answers every oracle query. From Kotlin (through JNA, because JDK 21's foreign-function API is still a preview), the native model answered all 2,000 corpus queries exactly as the oracle process did, and agreed with the Kotlin port, on 8 threads at about 130 µs per query including JSON. **Decision (provisional):** decision functions come from Lean, conditional on the shared library and shim building on macOS (`.dylib`) and Windows (`.dll`) in M4's release workflow. Until that is confirmed, each rule keeps its Kotlin port, and T2 checks it three ways: against the oracle process, the native library, and the corpus. Moving to JDK 25 (the current LTS) would replace JNA with the final foreign-function API.
- **Done when:** CI is green with `check` and the contract tests against the harness; a bad setting produces one readable error listing every problem; the card pipeline lists all 38 cards as not implemented; the two answers parsers agree; the assurance report lists all claims; the T2 test for `rule:may-remove` passes 10⁴ inputs against the oracle; the spike's decision is written down.

## M2: Seeder + scenarios

- **Scope:**
  - The `seed` module's scenario format (Kotlin DSL or YAML). It declares PC members (with tags), papers (with authors and nominee fields), assignments, and a timeline of `{day, actor, event}` entries. Days are offsets from a named phase date.
  - The driver follows the method in spec §9.3:
    - batch scripts for structure;
    - the API for reviews and comments (`actas`, `notify=0`);
    - SQL time-warp that shifts whole object timelines and preserves HotCRP's ordering invariants.
  - It supports **multi-stage scenarios**: stage 1, then a hook for a sync, then stage 2 with `PCS_NOW` advanced.
  - Fix the `saveusers.php` name/tag keys (spec §9.3, open item).
  - Ship `golden`, `shadow` (~150 papers), and `scale` (~4,000 papers, generated from a fixed RNG seed). Later milestones add their own scenarios.
- **Done when:** seeding `golden` on a fresh harness reproduces the table below exactly. That includes the API showing backdated `modified_at` values within ±1 minute of the scenario's intended times. `scale` seeds in under 20 minutes on `ripley-cloud-large`.

### Golden scenario: the contract between M2, M3, and M18

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
| 2 | `MISSING_REVIEWS` | Only 2 complete reviews. The third (the **nominee**'s) is still empty. |
| 3 | `SPLIT` | Merit 1/4/4, then the low reviewer moves 1→2 on day +6, leaving 2/4/4. Movement suppresses `UNRESOLVED_SPLIT`. |
| 4 | `SPLIT`, `UNRESOLVED_SPLIT` | Merit 2/4/4, with no score change ever. On day +3 the AC `@mentions` **R-pinged** (one of the 4s). |
| 5 | `SILENT_DISCUSSION`, `AC_ABSENT`, `GONE_QUIET` | Merit 2/2/2. No comments at all. The last activity is review submission before 02-01. |
| 6 | `GONE_QUIET` | Merit 4/4/4. The last comment is on day +2. |
| 7 | `AC_ABSENT` | The AC never comments; the reviewers do. |
| 8 | `CHAMPION_MISSING` | Merit 4/3/3. The 4 reviewer never comments. (Was 5/3/3, which is also a `SPLIT` by spec §5c's range rule; corrected 2026-11-13 when the rules were first run on it.) |
| 9 | `LOW_EXPERTISE` | All expertise ≤ 2. |
| 10 | `THIN_REVIEWS` | One review is 35 words and is rated `short` by both co-reviewers. |
| 11 | `RESPONSE_UNADDRESSED` | Merit 2/2/2. An author response is posted on 02-09. Reviewers never comment, and the AC comments on days +1 and +12. (Merit 2/2/2 so that silent reviewers don't also fire `CHAMPION_MISSING`; corrected 2026-11-13.) |
| 12 | `SPLIT` | Merit 2/4/4, with movement 1→2 on day +5. At the second instant (below), it also fires `DEADLINE_NO_CONSENSUS`. |
| 13 | `REVIEW_FLAGGED` | One review is rated `disrespectful` by the AC and `short` by a co-reviewer. Otherwise healthy (that review is ≥ 200 words, so `THIN_REVIEWS` doesn't fire, because `THIN_REVIEWS` counts only `short`/`vague` ratings from **≥ 2 raters** or word count). |

**Second assertion instant:** `PCS_NOW = 2030-03-01T12:00` (~2.5 days to decisions, inside the 3-day window). Assert only that pid 12 includes `DEADLINE_NO_CONSENSUS` and pid 1 fires nothing. Other rows drift with time and aren't asserted here.

**Rule semantics the table depends on:**
- `CHAMPION_MISSING` fires only if **no** reviewer holding the top merit has commented.
- `SILENT_DISCUSSION` and `GONE_QUIET` count AC comments as activity.
- `RESPONSE_UNADDRESSED` counts only reviewer comments.
- `THIN_REVIEWS` fires on word count < floor, **or** a `short`/`vague` flag from ≥ `PCS_THRESH_RATING_RATERS` (2) raters.
- Ratings are seeded with `POST /{p}/reviewrating?actas=<rater>`. The rater must be a co-reviewer who has already submitted, or the metareviewer.

**People:**
- **R-silent** is the low scorer on 3, 4, and 12 and never comments. They top "silent on split papers" with 3. Because they're the low scorer, no `CHAMPION_MISSING` fires.
- **R-pinged** is pinged on pid 4 on day +3 and never comments there. That's an unanswered ping of 11+ days.
- **AC-busy** holds pids 1, 3, 4, 8, 9, and 10: 6 papers, 5 flagged, commenting on all of them.
- **AC-idle** holds pids 5 and 7: 2 papers, 0 comments, both flagged.
- **AC-normal** holds pids 2, 6, 11, 12, and 13.
- The pid 2 laggard is tagged `nominee`. R-silent is tagged `junior`. Everyone else is senior.

Changing this table means changing the M3 and M18 tests in the same PR.

## M3: Store + sync (Mirror)

- **Scope:**
  - SQLite (SQLCipher) schema and migrations matching spec §3, including the state PC Supervisor owns.
  - The full sync, with snapshot diffing that sets `first_seen_at` and `first_complete_seen_at`, writes `review_version` rows on vtag change, and records deleted and unassigned items.
  - Comment mention parsing and the FTS5 index.
  - `/reviewhistory` backfill at `PCS_HISTORY_RPS`.
  - CLI: `pcs sync`, `pcs sync --watch`, `pcs backfill`, `pcs wipe`.
  - The sync is idempotent: two syncs with no changes produce zero new rows.
- **Done when:** the integration tests pass:
  - golden → sync → DB matches expectations;
  - the multi-stage run (stage 1 → sync → stage 2 with a score change, a new comment, an edited comment, a deleted comment, and an unassigned review → sync) produces exactly the expected `review_version`, `first_seen_at`, and deletion rows;
  - opening the DB with the wrong key fails.

## M3a: Scenario runner and evidence (§A4–§A6)

- **Scope:**
  - The bindings that don't need the app: the HotCRP actor (every non-chair action through the HotCRP API as that user, leaving its spec §11 trace), the clock, the file driver, the state reader, the HotCRP reader, and the role reader. The binding is an exhaustive `when` over the generated model actions and observations.
  - The scenario runner: takes an exported trace, executes each step through the bindings against the harness, syncs, reads every observation, and writes the evidence record.
  - The boundary observer: a proxy and resolver the test JVM must use, a file-write monitor, and the canary scan.
  - `lake exe check-evidence` in `model/`, and a CI step that runs it on every evidence record.
  - The binding controls: positive controls for each reader and the observer, and negative controls with specification mutants switched on.
  - The assurance report's family, transition, and policy-coverage columns.
- **Done when:** the runner executes the desk-reject subsystem's witness traces against the harness (with `core` standing in for the chair's UI actions) and `check-evidence` re-derives each verdict; each binding mutant listed in §A8 is caught by a control; the boundary observer catches a planted canary sent to a non-harness host and a planted log line containing the token.

## M4: App shell and packaging

- **Scope:**
  - The Compose Desktop app: keychain unlock on start, the conference picker (one DB per conference), sync status and "sync now", and a settings screen that shows the answers file's readings with every unresolved question and what it blocks.
  - One reusable lazy table component (sorting, filtering, column chooser, deep links to HotCRP in the system browser) that later views build on.
  - The UI-test harness: Compose UI tests against a synced scenario, capturing screens with Compose's image capture into `app/build/screenshots/`.
  - Visual review (T12):
    - Roborazzi for local record and compare, so a developer sees diffs offline. Its Compose Desktop support is newer than its Android support, so keep it behind one helper that can fall back to plain image capture.
    - Argos upload from CI only: `argos upload --build-name linux` for the main baseline, and a small smoke set from macOS and Windows runners as separate builds (`--build-name macos`, `--build-name windows`), because their font rendering differs.
    - Stability: fonts bundled in the app; animations not auto-advanced; `PCS_NOW` pinned; a fixed window size and display scale; relative times and sync timestamps masked.
    - The card gallery: one screen per card, rendered under the answered reading, as its own Argos build (`--build-name cards`).
    - Watch the Argos plan's monthly screenshot quota; the visual set is curated, not exhaustive.
  - A release workflow that builds installers with `jpackage`: macOS signed with the Developer ID and notarized, on the attached macOS runner; Windows packaged as MSIX for Microsoft Store submission (the Store re-signs it); Linux unsigned.
  - The app driver and the view reader (§A4): chair actions through test tags, and each screen read back into a structured observation, checked in both directions.
- **Done when:** two consecutive CI runs upload identical Linux screenshots (no Argos diff); the card gallery build contains every card; a UI test opens the app on synced `golden`, shows the paper table, and reaches HotCRP's URL for pid 4; an unresolved question in the answers file appears on the settings screen with its blocked features; Argos screenshots are stable across two consecutive CI runs; the release workflow produces an installer for each OS that starts and opens a harness DB.

## M5: Writeback and the HotCRP conventions

- **Scope:**
  - The Writeback concept (concepts §3.2; spec §6): draft, dry run in HotCRP, confirm, apply, and observe on the next sync, for tags, assignment CSVs, comments, PC membership and tier tags, and decisions. A review screen in the app shows HotCRP's dry-run diff and takes the confirmation.
  - The HotCRP conventions of spec §11: the tag and comment formats, a parser for each, and a sync-screen report of traces that don't parse.
  - **Confirm each *verify* row of spec §11 on the harness:** tag visibility for ACs and other PC members, admin comments seen by a paper's AC, tag values, and the `screen` review round's exclusion from load. Any row that fails gets a replacement mechanism in spec §11 before this milestone closes.
  - The first actions: a copyable HotCRP search for any filtered set, nudge-comment drafts, and `#chair-attention` tagging.
- **Done when:** for each artifact kind, an integration test shows that the dry run changes nothing, the confirmed run makes the change, and the next sync observes it; an applied artifact whose effect is then reverted in HotCRP is flagged with the mismatch; every spec §11 row has a passing harness test; the test helper refuses to start unless `PCS_HOTCRP_URL` is `127.0.0.1`/`localhost`.
- **Evidence:** `prop:H1`, `prop:H2`, `prop:H4`, `prop:M2` (Writeback mismatches); every `conv:*` row through T6 and T8; every denied `cell:*` whose action has a HotCRP trace through T6 (forged traces are reported, never acted on).

---

# Phase B: Before and at submission

## M6: Imports and the extended phase model

- **Scope:** the phase dates of spec §10.1 and their phase logic; `pcs import` for every kind in spec §10.3, versioned, all rows or none; `pcs export tpms`.
- **Done when:** each import kind round-trips from fixture CSVs; a malformed CSV produces a row-level error report and no partial import; "what did the sheet say on day X" is answered by a test at two `PCS_NOW` values.
- **Evidence:** `prop:M2` (stale imports); `assume:A3`, `assume:A4` recorded with their owners.
- **Progress (2026-11-14, branch `m6-imports`):** done locally, `./gradlew check` green (CI not run).
  - **Built (all in `core`, plus CLI):**
    - `phases/Phases.kt`: `Phase` (REGISTRATION, SUBMISSION, DESKREJECT, APPOINTMENTS, ASSIGNMENT, REVIEWING, POST_REVIEW, DISCUSSION, DECISIONS, CLOSED) and `Window` (EARLY_REJECT, RESPONSE) over the `PCS_PHASE_*` dates; `Settings.phaseModel`; the loader now rejects an unknown `PCS_PHASE_*` key and a window that closes before it opens.
    - `imports/`: CSV reader, the six kinds of spec §10.3, `Imports` (import, `asOf`, `latest`, `before`, `runs`, `diff`, `staleness`), `TpmsExport`. Migration `004-imports.sql` (`import_run`, `import_row`); migrations 001-003 untouched.
    - CLI: `pcs import <kind> <file> [--map col=name,...]`, `pcs import status`, `pcs export tpms <dir>`. Settings: `PCS_IMPORT_FRESH_<KIND>_DAYS` (in the loader and `pcs.conf.example`).
  - **Evidence:**
    - `ImportsTest`: every kind round-trips from fixtures under `core/src/test/resources/net/jonbell/pcs/imports`; `appointments-bad.csv` and `tpms-scores-bad.csv` give row-level errors, no rows, earlier version still current; the as-of test at two clock values (and one second either side of an import); staleness at the limit, one second past it, missing, override, and rejected attempts not refreshing (`prop:M2`). `PhasesTest`: every deadline boundary, windows, time zone and DST, `PCS_NOW`, skipped dates. `CsvTest`, `TpmsExportTest`.
    - `@Covers`: `prop:M2`, `assume:A3`, `assume:A4`.
    - CLI smoke by hand against a scratch store: import, rejected import (8 errors listed, exit 1), status, export.
  - **Assumptions recorded:** A3 (TPMS files are what the operator sent) owner **process chairs**; A4 (the appointments sheet records the ACs' real decisions) owner **PC chairs**. Both are in `Assumptions` (core), printed by `pcs import`, and stored on every `import_run`. The owners are my reading of concepts §3.12 "accountable"; the chairs should confirm.
  - **Ambiguities resolved:**
    - Phase dates are deadlines: at the instant itself the phase has ended. Unset dates are skipped. Out-of-order deadlines are reported by `Phases.orderProblems()` but not rejected (appointments might legitimately follow assignment).
    - `screening-bundle` has no format in agent.md; it is imported as a findings CSV matching spec §3 `finding`. `refcheck`'s columns are my choice (`pid,reference,status[,detail]`).
    - Appointment `origin` values (`invited`, `self-nominated`, `nominee`) and "accepted needs a tier" are my reading of spec §10.2.
    - Rejected attempts are stored in `import_run` (status `rejected`, with errors) so the audit trail shows them; as-of reads ignore them.
    - Staleness: each kind has a default freshness in days; "never imported" is reported separately from "stale". `prop:M2` covers the staleness report only; notifying process chairs from the app is M4/M20 UI work, and Writeback mismatches and route gaps belong to their milestones.
    - TPMS export: `pc.csv`, `conflicts.csv` (PC members only), `load-<tier>-max<N>.csv`, `reviews-per-paper.txt`. A PC member with no appointments row is senior.
  - **Not done:** an import screen in the app; the screening-bundle manifest and qualification records (M12); the TPMS column mapping for `tpms-registrations` (no confirmed layout).

## M7: Nominations and appointments (spec §10.4 A)

- **Scope:** per-paper nominee checks against Q8 and Q10; `owes(u)` under Q18, Q19, and Q19b; nomination patterns for the PC chairs (Q9); the submission cap (Q17); the appointments import driving Writeback drafts for PC membership and tier tags; a `nomination` scenario.
- **Done when:** the model's cards for Q7, Q8, Q10, Q18, Q19, Q19b (X1–X10) pass as generated tests; the `nomination` scenario (a paper with no nominee, a person nominated by three papers, a declined co-nominee, an author over the cap) is fully reported; a candidate accepted, classified, and consenting in the sheet produces a membership artifact that passes its dry run.
- **Evidence:** `rule:owes`, `rule:eligible` (T1, T2); `card:X1`–`card:X10` under every reading of Q7, Q8, Q10, Q18, Q19, Q19b; `prop:V2`, `prop:V3`, `prop:V5`, `prop:M4`; T5 witnesses for nominee appointment (`prop:L2`); T6 for an appointment trace written by someone who isn't the paper's AC.

- **Progress (2026-11-14, branch `m7-nominations`):** done locally on a fresh harness (CI not run).
  - **Done:**
    - Model (`model/`): rules `compliance` (Q8, registration; keys `ok`, `missing-nominee`, `too-many-nominees`, `unregistered`), `nominationPattern` (the Q9 signal, no consequence by itself), `papersOverCap` (Q17). Card **X3** is new (39 cards; Q9 is not a question of the model, so X3 depends on none). X1 and X7 now compute their outcome from the rules instead of a fixed string. Oracle queries `compliance`, `pattern`, `overCap` and `eligible`, with four new corpora under `model/export` (CI regenerates them).
    - `core/rules/Nominations`: the same rules in Kotlin. `core/nominations`: `NominationRules.build` (per-paper checks with Q10's consequence and the `pcs-warned` trace, `owes(u)` per person, patterns, the cap, anomalies), `Resolved` (a result that turns on an open question lists what each reading gives; nothing defaulted), `NominationData` (reads the mirror and the latest `appointments` and `tpms-registrations` imports), `Appointments` (membership drafts through M5's Writeback `UserArtifact`, with `PCS_TIER_TAGS`; one artifact for candidates with nothing waiting). `pcs nominations` prints all of it.
    - Seed scenario `nomination` (papers 101 to 117, the sheet and the registrations as CSVs): paper 104 names no nominee; `nom-nina` is nominated by 101, 102 and 103; paper 105's nominee `nom-fay` was declined; paper 106's only nominee is pending and unregistered; `nom-prolific` is on 11 papers (2 over a cap of 9) and nominates a junior on each; one student hasn't consented, one was declined, one was "accepted" by a non-AC.
  - **Evidence:**
    - T1: `CardsTest` runs X1 to X10 under every reading (155 cases, none skipped) and every mutant (`mutant:3`, `mutant:4` among them); X3 and X7 go through the rules.
    - T2: `RulesDifferentialTest` checks `rule:eligible`, `rule:compliance`, the pattern signal and the cap against the oracle (1,500 queries each, mutants included for `eligible`).
    - `NominationReportTest` (11 unit tests): Q8 and Q10 readings, `owes` under each Q18, declined share under Q19b (V2: only named people owe), the cap at 9, 11 and with Q17 open, the pattern and its non-effect (V3), a decision by a non-AC never acted on, drafts and skips.
    - `NominationTest` (core integration, 7 tests, runs last and cleans up): the scenario seeded into HotCRP, synced, imported and reported as above; `pcs-warned` written through Writeback and then read back to change Q10's answer for paper 104; the Q18 and declined-share mutants caught on the scenario; the membership artifact for the 10 eligible candidates passes its dry run, is confirmed, handed off, run by the chair as `saveusers`, and observed by the next sync (then nothing more is drafted).
    - Fresh harness: `:seed:integrationTest` 5, `:core:integrationTest` 49, `:runner:integrationTest` 5, `:app:uiTest` all passing; `check-evidence` 36 records, 0 failing; `./gradlew check` green; assurance report: failing 0, cards 39 of 39, mutants 10 of 10, `rule:owes`, `rule:eligible`, `rule:compliance` covered by T1 or T10 and T2.
  - **Not done / deferred:**
    - `prop:V5` is not claimed: it is about a plan's load against `owes(u)`, and the solver (M14, M15) isn't there.
    - T5 for `prop:L2` and T6 for a non-AC appointment are witnessed in `NominationTest` at the `core` level, not as runner traces replayed by `check-evidence`: the model's appointment subsystem includes the solve step, so a trace needs M15. No `cell:*` claim is covered for `classify` or `see-nomination-patterns`.
    - X4 and X5 (assignment), X6 and X10 (Accountability cases, M16) are covered by T1 only. X10's outcome is still a fixed string in the model until M16 has a case rule.
    - No app screen: the drafts show in the Writeback tab, but there is no nominations view, and `view:*` has no claim for one.
    - Q17 "another number" has no reading in the model (only none and 9).
  - **Ambiguities resolved (all in spec §10.4 A):**
    - Nominations are read from the appointments sheet's `nominated_by`; the sheet has no column for authors' shares, so "authors allocate" uses an equal split and the report says so. Pending nominees owe nothing and mark the figure provisional.
    - A decision counts only if the row's `ac_email` is an AC (a metareviewer in HotCRP) of a paper that nominated them, an AC for someone nobody nominated, or (ruling 2026-11-15) a PC chair. Otherwise it is reported and treated as pending.
    - Declined nominees still count as named for Q8. Q8 "up to n" takes n from `PCS_NOMINEES_MAX` (ruling 2026-11-15; default 3).
    - The pattern signal: senior author (sheet tier, or a PC member with no row), at least `PCS_PATTERN_MIN` nominations (default 3; every nomination counts, repeats included), all of juniors by the sheet's tier, never themself. A pending nominee has no tier, so it breaks the pattern until classified.
    - Authors are matched across papers by HotCRP account email (concepts SubmissionLimit); the cap is reported with every paper of the author.
  - **Findings about HotCRP:** `batch/deletepapers.php -y` removes papers but not the contacts created for their authors, so the scenario's test removes the `nom-*` contacts in SQL; paper `authors[].email` is the only identity link between papers, so an author with two accounts splits the cap count.
  - **Decisions needed:** the cap's other numbers. (Authors' shares under Q19 "authors allocate" were ruled on 2026-11-15: equal split only, no sheet column or HotCRP field. The pattern's threshold, the value of n and where "decided by" authority comes from were ruled on 2026-11-15; see "Rulings applied" below.)

## M8: Extraction and deterministic checks (agent.md)

- **Scope:** PDF text with page anchors (PDFBox), GROBID (local container, or in-process where it runs), layout facts, and the injection scans (page render plus local OCR, diffed against the text layer; the vector detectors; non-page channels); the `format`, `refs.doi`, deterministic `anonymity`, `injection.hidden`, `injection.channels`, and the pattern half of `injection.addressed`; the `synthetic` corpus with planted defects, including one injection per vector and the benign controls.
- **Done when:** every planted deterministic defect is flagged with a verifying anchor, and no flags fire on clean synthetic papers. No network in tests except a mocked resolver.
- **Evidence:** `prop:S3`, `prop:S4`, `assume:A5`; planted-defect recall reported per check.
- **Progress (2026-11-14, branch `m8-extraction`):** done, `./gradlew check` green.
  - **Built:** the `agent` module (`extract/`: PDFBox 3 text with per-character glyph state and page anchors, layout facts, channels, bibliography parsing with a pluggable GROBID client, a render and OCR interface; `checks/`; `eval/`), six check directories under `agent/checks/<id>/` (spec, schema, oracle; the version is a content hash computed by the `checkVersions` task over the directory plus the code files `check.yaml` lists), the synthetic corpus generator (`./gradlew :agent:syntheticCorpus` writes it under `agent/build/synthetic`), the scorer (`./gradlew :agent:screeningScore` writes `agent/build/reports/screening/mutation-score.md`), and `pcs agent check <pdf> [--authors f] [--ocr [image]] [--grobid url]`. New `@Covers` evidence: `check:*` claims (one per catalog row of agent.md §3.2, added to the inventory), `prop:S3`, `prop:S4`, `assume:A5`.
  - **Measured** on 119 synthetic papers (6 clean, 6 benign controls, 107 mutants; the injection operators run once per payload, four payloads from blunt to a canary request): every check scores 1.000, no flag on any clean or benign paper, no collateral flag on another check's mutants, every quotation verifies at its anchor.

    | Check | Planted | Found | False flags (clean + benign) |
    |---|---|---|---|
    | `format` | 5 | 5 | 0 / 12 |
    | `refs.doi` | 3 | 3 | 0 / 12 |
    | `anonymity` | 7 | 7 | 0 / 12 |
    | `injection.hidden` | 60 (15 vectors x 4 payloads) | 60 | 0 / 12 |
    | `injection.channels` | 28 (7 channels x 4) | 28 | 0 / 12 |
    | `injection.addressed` (patterns) | 4 | 4 | 0 / 12 |

    The vector detectors alone find all 60 hidden-text mutants. The OCR diff alone, with the generator's record of what is visible standing in for OCR, finds the 8 vectors that change what is drawn (render mode 3, fill = background in both forms, tiny font, clipped, off-page, covered by a shape or an image, layer off, ToUnicode remap) and, as expected, not the five that leave the drawn text alone (zero-width, tag characters, bidi, ActualText, alt text). The one paper about prompt injection draws 5 LOW signals from `injection.addressed` and no ground.
  - **Decisions made on the way:**
    - **Grounds.** Hidden or channel text that matches the addressed patterns is ground `prompt-injection` (HIGH); hidden text with other content is a MEDIUM signal with no ground. Scripts, embedded files, annotations and form values are MEDIUM signals on their own. Doc-info, XMP and bookmarks fire only on an addressed match, so a typesetting tool's Producer, Title and XMP packet do not. A visible match is never a ground: MEDIUM in an ordinary paper, LOW in a paper about LLMs (four or more mentions of LLM or injection terms). `refs.doi` names `fabricated-reference` for a non-resolving or mismatched DOI and depends on Q6; a missing DOI is INFO. Self-referencing phrasing in `anonymity` is a MEDIUM signal with no ground (the LLM half decides).
    - **Format limits** are a `FormatPolicy` parameter (they are a decision, `format.limits`); `FormatPolicy.SYNTHETIC` is the corpus template. Wiring decisions into checks is M10.
    - **OCR diff** reports text-layer words the OCR lacks (runs of three or more words, edit-distance tolerant). Words only the OCR sees have no anchor in the text layer, so they are not findings (assume A5).
    - **Pixels.** "Fill colour = background" compares the fill with the commonest colour in a ring around the line's glyphs in a 1x render, so white text inside a dark figure is not flagged. "Covered" and rectangle clips are tracked from the content-stream operators, because PDFBox's text engine does not interpret path or colour operators (colour operators are registered explicitly in the extractor).
    - **Not done / limits.** The ToUnicode detector covers simple fonts only (Type0 fonts are left to the OCR diff). A very long ToUnicode destination string (about 1,000 bytes) was not read back by PDFBox, so the generator spreads hidden characters over several glyphs; the detector does not depend on that. A bibliography entry that runs onto the next page is anchored on its first page only (`Reference.continuation` carries the rest for DOI and title). The heuristic bibliography parser handles numbered `[n]` styles; real papers go through GROBID, which has been exercised only against a recorded and a generated TEI response, not a running container. No real reference resolver exists yet (`ReferenceResolver.None` and `Mock` only), by design: no network in tests; the egress-allowlisted resolver comes with the engines milestone. `pcs agent check` reads its options from flags, not `PCS_*` settings, until M9 adds the agent settings to `core`'s loader.
    - **OCR container.** `agent/ocr/Dockerfile` (Debian plus tesseract, run with `--network none`). One opt-in test uses it (`PCS_TEST_OCR_DOCKER=1`, after `docker build -t pcs-ocr:latest agent/ocr`); it passed locally (clean page: no hidden text; white-text mutant: payload found by the diff). `check` never needs Docker or GROBID.
    - **Infra.** `CoversExtension` no longer records a test skipped by an assumption as a failure (an opt-in test would otherwise fail its claims in the assurance report).

## M9: Engine layer

- **Scope:** the engine interface; the dispatcher with the clearance check; the `claude-code`, `anthropic` (API / Bedrock / Foundry / Vertex, through Anthropic's Java SDK), `openai-compat`, and `replay` adapters; `pcs agent probe`; the content-addressed store; `pcs agent plan`.
- **Done when:** unit tests show the dispatcher refuses every under-cleared call; CI runs all checks through `replay`; a manual run of one check on synthetic data succeeds on `claude-code` (a maintainer's login) and on one other engine, with matching schema-valid output.
- **Evidence:** `prop:S5`, `prop:C1` through T7 (the boundary observer runs around every engine call; a canary in review text must never appear in an engine request).
- **Progress (2026-11-14, branch `m9-engines`):** offline part done, `./gradlew check` green. **The live manual runs remain for the maintainer** (see "Not done").
  - **Built** (`agent/src/main/kotlin/net/jonbell/pcs/agent/engines/`): the `Engine` interface with `CallRequest`/`CallResult`, usage and cost, and the statuses OK, SCHEMA_INVALID, REFUSAL, TRUNCATED, ERROR; the `Dispatcher` (clearance from configuration, checked first, before the store, the guards, or the adapter; schema validation of every result; cache of OK and REFUSAL results; a `RequestGuard` boundary observer, with a canary guard for prop:C1); `EngineConfigs` (`PCS_ENGINES`, `PCS_ENGINE_<id>_*`, `PCS_CHECK_<check>_ENGINE`; the keys are known to `core`'s settings loader and documented in `pcs.conf.example`); the adapters `replay`, `anthropic` (SDK 3.8.0, looked up in Maven metadata; platform `api`, `bedrock`, `vertex`, `foundry` by configuration), `openai-compat` (Ktor; `json_schema`, `guided`, `tool`, or `prompt` structured modes), `claude-code` (stdin prompt, isolation flags of agent.md §4.3, envelope parsing); content addressing (`Keys`, `CheckDirs`: the run-time check-directory hash equals the `checkVersions` Gradle one, tested against the six real checks); `ResultStore` (in-memory and one-file-per-key); `EgressPolicy`; `Runner` (plan, run, and run-through-replay for deterministic and LLM checks); `pcs agent probe | plan | run`.
  - **Evidence** (all offline; `@Covers("prop:S5")`, plus `prop:C1` for the canary test): `DispatcherTest` refuses every under-cleared (ceiling, class) pair with zero adapter calls, store accesses, or guard runs; a store hit does not bypass the check; confidential needs a decision id; `claude-code` is `public` by default and raising it needs one. `RunnerTest` records a toy LLM check plus all six deterministic checks on a clean paper and an injection mutant, then re-runs everything with only `replay` and recorded findings (`localReplay`): results are identical, equal to a direct `Screening.run`, and the live engine is not called again. The same test shows the cache hit after a run (`plan`: all cached, cost 0) and that editing one check's `prompt.md` (or `schema.json`, or a deterministic check's version) makes exactly that check stale on every paper. `AdaptersTest` runs `anthropic` against a local `HttpServer` fake (request shape: native `output_config.format`, no sampling parameters, cache breakpoint, effort; refusal, max_tokens, non-JSON, HTTP 400), `openai-compat` against Ktor's `MockEngine` (all four structured modes, refusal, truncation, HTTP 500), and `claude-code` against a fake `claude` shell script (flags, paper on stdin and not in argv, envelope parsed, refusal, error, missing binary). `EgressTest` covers the allowlists (exact host, no subdomain, no userinfo trick, plain HTTP only where the config says `http://`, resolver hosts disjoint from engine hosts).
  - **Not done / limits.**
    - **Live manual runs** (PLAN's done-when: one check on `claude-code` with a maintainer's login and on one other engine, matching schema-valid output): not run; no provider or CLI call was made and no key was read. The `claude` envelope field names (`structured_output`, `total_cost_usd`, `modelUsage`, `stop_reason`, `duration_ms`) are written from the docs and must be confirmed on the first real run; the parser also falls back to parsing `result` as JSON.
    - **Bedrock, Vertex, Foundry** build their SDK backends from configuration but were not exercised against a fake (their auth is cloud credentials). Their default hosts (`bedrock-mantle.<region>.api.aws`, `<region>-aiplatform.googleapis.com`, `<resource>.services.ai.azure.com`) are from the providers' naming patterns; pin `BASE_URL` or confirm at the live run.
    - **Egress** is enforced in our code for `openai-compat` on every request (no redirects followed) and at construction for the SDK adapter (the SDK's own HTTP client is not wrapped); the `claude` CLI makes its own connections.
    - **Batch:** the interface (`submitBatch`, `collectBatch`) exists; no adapter implements it (`Caps.batch` is false everywhere). Anthropic Message Batches come with M12's batch submission.
    - **Store:** the file store is plain JSON and refuses `confidential` results; the encrypted store arrives with the screening bundle (M12). `RPM`/`TPM` are parsed but only `CONCURRENCY` is enforced. `pcs agent probe` prints configuration; it does not probe a live server's capabilities.
    - **Decisions made:** the `clearance` ceiling lives in `EngineConfig`, not on the `Engine` interface (agent.md §4.2 shows it there), so an adapter cannot raise its own; a replay engine takes the identity (id, model, platform, structured mode) of the engine it replays; `effort` is mapped for `anthropic` only; the real `refs.doi` resolver and `PCS_AGENT_EGRESS` wiring into it remain for M10, the allowlist type is ready (`EgressPolicy.forResolver`).

## M10: LLM checks

- **Scope:** `anonymity` (the LLM half), `scope`, `refs.use` (abstract variant), and `summary`; the classifier half of `injection.addressed`; `injection.effect` (the with-and-without rerun and the per-call monitors); anchor verification; flag cards; decision records and the manifest.
- **Done when:** the manifest renders from check directories and decisions; unverifiable anchors are never shown; a flag depending on an `unresolved` decision renders as blocked.

## M11: Evaluation

- **Scope:** the `public` and `held-out` corpora, mutation operators, the metrics of agent.md §7.3 including stability and scaffold delta, and the `pcs agent shootout` report.
- **Done when:** a shootout over at least 3 engines (including one self-hosted) on `held-out` produces per-check frontiers with confidence intervals and a projected cost at `PCS_AGENT_SCALE_PAPERS`.
- **Progress (2026-11-15, branch `m11-eval`):** machinery done and run end to end offline; **the done-when's three real engines (one self-hosted) are deferred**: there is no self-hosted model, GPU or API key here. `./gradlew check` green, 0 failing claims.
  - **Built** (`agent/.../eval/`): `Stats` (Wilson and seeded-bootstrap intervals); `Corpora` (`HeldOut`: 58 synthetic papers from fixed seed 20270101, disjoint from the development seed range, with clean papers, one planted defect per LLM check, benign quotations, and injected/clean-twin pairs; `RecordedDev`: the 11 development cases with live recordings, labelled optimistic; `PublicCorpus`: manifest format, license allowlist, DOI or arXiv id, `dev`/`held-out` split, SHA-256 pinning, `corpus validate|pin|standins`; `agent/corpora/public/manifest.json` is four placeholders, nothing is downloaded and nothing opens a connection); `Scripted` (three deterministic stand-ins, not models: strong, noisy, self-hosted-like, each a rate profile over an answer read from the planted phrases); `Shootout` (the metrics of agent.md 7.3 below, frontier, recommendation, markdown and JSON); `ShootoutCli` (`pcs agent shootout`, `pcs agent corpus`; `./gradlew :agent:shootout -Pcorpus=held-out|recorded`). Additive edits elsewhere: `Screener` takes `runTag` (a repeat run gets its own content address) and `unitTransform` (the raw-PDF variant), `CallRecord` carries latency and detail; `LlmCorpus` helpers made `internal`; `LiveSample` takes a run tag; `AgentCli`/`cli Main` route the two commands. No check code, prompt or schema changed, so every check version and every earlier fixture is unchanged.
  - **Measured per (check, engine, variant):** recall, false-flag rate, precision, balanced accuracy (95 percent intervals); anchors that verify; refusal, schema-invalid, truncation and error rates; stability over papers whose `k` runs were all served (flag-set agreement, pass^k, flaky flags); cost per paper from recorded usage and prices (GPU hours for a self-hosted engine), projected to `PCS_AGENT_SCALE_PAPERS` (default 4000), and wall time under `CONCURRENCY`; frontier and a recommended engine (provisional when a lower bound or the stability measurement is missing); scaffold delta (raw PDF vs preprocessing, paired) for `anonymity.llm` and `scope`; injection detection and resistance (injected paper vs clean twin, span left in vs stripped); cross-engine agreement. A replay request with no recording leaves that paper out and is counted, never filled in.
  - **Offline shootout** (reports in `agent/reports/offline-shootout-held-out.md` and `-recorded.md`, regenerated by the gradle task): on `held-out`, four engines (replay of Haiku, three stand-ins), k = 3. The replay serves 0 of 58 held-out papers (nothing was recorded on them, by design), so the frontiers there compare the three stand-ins: for example on `anonymity.llm` the strong stand-in has balanced accuracy 0.97 at $0.0038 per paper, the noisy one 0.74 at $0.0013, the self-hosted-like one 0.82 at $0.0026; neighbours on the cost axis are mostly not separated by the intervals at 6 to 16 papers per class, which the report states. Projected all-check cost at 4000 papers: $85.62 (strong), $28.37 (noisy), $45.51 (self-hosted-like, with an assumed 2 USD/h GPU). On `recorded`, the replay of the real Haiku results is in the comparison: recall 1.00 and false-flag rate 0.00 on every labelled check, but on 1 to 2 papers per class (lower bounds 0.2 to 0.3, so every recommendation is flagged provisional); projected $15.02 [13.22, 16.69] at 4000 papers for the four checks; stability measured on the three repeated papers (below). The stand-ins' numbers say nothing about any model.
  - **Live calls: 6 of the 10 allowed**, all `claude-code`, model `haiku`, synthetic papers of `LlmCorpus`, recorded as replay fixtures (`agent/fixtures/replay`, 12 to 18 files; log lines 26 to 31 of `live-calls.log`): the same request repeated twice (run tags `r2`, `r3`, so run 1 is the existing fixture) for `scope/domain-swap`, `scope/in-scope` and `anonymity-llm/own-prior-work`. Result: across the three runs on each of the three papers, the flag sets were identical (0 flaky flags, agreement 3 of 3 papers). Three papers is a smoke measurement, not an estimate of stability.
  - **Evidence:** `ShootoutTest` (14) and `PublicCorpusTest` (5): intervals against textbook values; held-out reproducible and disjoint from development papers and from every recorded paper id; scripted engines deterministic in (request, run); a perfect stand-in scores 1.0/0.0/stable and a degraded one lower; frontier equals the non-dominated set; projected cost = per paper x scale, GPU-priced engine not free; unverifiable quotations are never hits (`prop:S4`); refusals, schema failures and truncations counted; scaffold delta zero for an engine that reads PDFs as well as text and positive for one that does not; resistance 1.0 left in and 0.0 stripped for an obedient summarizer; an engine cleared below the corpus class is refused before any call (`prop:S5`); replay of the recorded results (coverage, stability on the repeated papers, cost from recorded usage, no raw-PDF rows invented); report sections and JSON round trip; CLI offline run, refusal to spend without `--confirm-spend`, public corpus declined; manifest validation (license, source, split, duplicates, checksums), stand-ins, pinning, mismatch never re-pinned. `@Covers`: `check:anonymity`, `check:scope`, `check:refs.use`, `check:injection.addressed`, `check:injection.effect`, `check:summary`, `prop:S4`, `prop:S5`.
  - **Deferred / not done:**
    - **The real run:** three real engines including a self-hosted one, on `held-out`, `k = 3`. docs/agent.md 7.3b lists the engine lines (`claude-code`, `anthropic`, `openai-compat` with `STRUCTURED`, prices, `GPU_HOUR_USD`) and the command; it stops and prints a plan unless `--confirm-spend` is given.
    - **`public` corpus content and its mutants:** the manifest is placeholders; the §7.2 operators work on generated `PaperSpec`s, so mutating a fetched PDF needs a PDF-level mutator. `pcs agent shootout --corpus public` says so and exits 2.
    - **Held-out realism:** the synthetic held-out papers are templated (two topics, invented names), so a real model will find them easy; the numbers show the machinery, not a qualification.
    - **Raw variant and `summary`:** no raw-PDF variant for `refs.use`, `injection.addressed.llm` or `summary`; `summary` has no label set, so only its resistance is measured (anchor validity and contribution coverage of §7.2, and human ratings, are not built).
    - **Variants not built:** effort level, PDF vs text beyond the two checks, abstract-only vs full-text `refs.use`, workflow vs agent loop, batch vs online.
    - **Thresholds** are `ShootoutOptions` defaults (recall 0.8, false-flag 0.1, anchors 0.95, stability 0.9), not yet read from `check.yaml` (M12's qualification records).
    - **Deterministic checks** are engine-independent and stay in `:agent:screeningScore`; the shootout points to it.
  - **Decisions needed:** the held-out seed and size (58 papers, 6 per defect kind) are mine; the default instance size for projections (4000); the threshold defaults above; whether to spend the remaining 4 live calls on more stability samples (a fourth paper, `refs.use/miscited`), or save them for the real run.

## M12: Qualification and the screening bundle

- **Scope:** qualification records and refusal of unqualified (check, engine) pairs; change classification in `plan`; batch submission; **the screening bundle** (encrypted, content-addressed, with its manifest) that `core` imports.
- **Done when:** a run on the harness's seeded conference produces a bundle that another copy of the app imports with identical findings; a prompt edit shows up as "needs requalification" with the flags it moves.
- **Evidence:** `prop:S6` (the agent has no write path; checked by T6 attempting each write with the agent's credentials).
- **Progress (2026-11-15, branch `m12-bundle`):** done locally on a fresh harness (CI not run); no live engine call and no real API call was made, and no key was read.
  - **Built:**
    - **Bundle** (`net.jonbell.pcs.core.bundle`, in `core` so the app never depends on the agent): `BundlePayload` (manifest, findings, summaries), `BundleCodec` (`bundle-<sha256>.pcsb`; header with the plaintext's SHA-256 as associated data, AES-256-GCM; the hash is recomputed after decryption), `BundleKey` (32 bytes, URL-safe base64, `toString` hides it), `ScreeningBundles` (imports as a version of the `screening-bundle` kind and keeps the payload by content address in the SQLCipher store; the same bundle twice is a no-op; a key is never stored). `pcs import bundle <file> --key-file f`. The agent builds the payload (`agent/bundle/BundleBuilder`, `pcs agent bundle`); an unverified flag's quotation and engine prose never enter it.
    - **Encrypted store:** `EncryptedFileResultStore` (AES-256-GCM per content address, address authenticated); `pcs agent bundle --class confidential` needs it (`PCS_AGENT_STORE_KEY_FILE`).
    - **Qualification:** `qualification.yaml` per LLM check (thresholds), `Qualification` records (metrics, thresholds met, per-file hashes, held-out flags), `Qualifier` (from a shootout report; a stand-in never qualifies), `QualificationGate` in the dispatcher (confidential request needs a record for exactly its check version, engine id, model, options, variant; after clearance, before store, guards and adapter), `pcs agent qualify`. `ShootoutReport.flagSets` keeps run-1 flags per paper.
    - **Change classification:** `pcs agent plan --changes [--moves]`: covered / needs requalification (files named) / needs new evidence; `--moves` lists the flags gained and lost on held-out.
    - **Batch:** `AnthropicEngine.submitBatch` and `collectBatch` against the Message Batches API (first-party platform only), `Dispatcher.callBatch` (same refusals as a call, before submission; stored results not resubmitted; duplicate keys asked once).
  - **Evidence:**
    - Done-when: `SeededBundleTest` (`:agent:integrationTest`, T10): two copies of the app, each rebuilt from the seeded harness, import one bundle produced by `pcs agent bundle` over the 10 synthetic manuscripts (deterministic checks plus a `replay` engine serving a recorded scripted stand-in), with the key from its own file: equal imported rows, equal payload, equal visible findings per paper, equal to what screening produced. `BundleCliTest` and `ScreeningBundleTest` cover the format (tamper, header edit, wrong key, no plaintext in file or database), content-addressing, the CLI's refusals for confidential papers (no encrypted store, no clearance, no qualification) and the encrypted store.
    - `prop:S6` through T6 (`AgentNoWriteTest`): 10 HotCRP writes (assign, comment, paper create, edit and delete, review, tags, decision, settings) each attempted with no credential, a malformed one and an engine API key: every one refused (401/403/404/405, never `ok`), and a before/after sync fingerprint shows nothing changed; a chair's dry run of the same assign and comment shapes is accepted, so the refusals are about the credential. A bytecode scan shows no agent class refers to `HotcrpClient`, `HotcrpWriter`, `Sync` or `core.writeback`, and the bundle has no field but `manifest`, `findings` and `summaries`.
    - Qualification (`QualifyTest`): thresholds do not change the version; a good engine earns a record and a poor, a noisy and a stand-in do not, with the reason; k = 2 is refused; the gate refuses an unqualified, a stale-version, another-model and another-variant tuple with zero adapter calls; a prompt edit is "needs requalification" naming `prompt.md`, a price or concurrency edit is covered, a model change or an engine without a record needs requalification, an oracle edit or a check with no labelled positives needs new evidence; a prompt edit that makes a stand-in more lenient lists exactly the held-out flags it loses.
    - Batch (`BatchTest`, stub `HttpServer` speaking create, retrieve and JSON-lines results): custom ids, parameters equal to a single call's, polling until `ended`, a succeeded, a schema-invalid and an errored result mapped, a missing result an error, cached results not resubmitted, one refused request refusing the batch before any I/O.
    - Fresh harness: `:seed:integrationTest`, `:core:integrationTest`, `:runner:integrationTest`, `:agent:integrationTest` green; `:app:uiTest` green on another fresh harness; `./gradlew check` green; `check-evidence` 144 records, 0 failing; assurance report 0 failing, `prop:S6` covered (T6). The model is unchanged.
  - **Decisions made:**
    - **Thresholds are in `qualification.yaml`, not `check.yaml`,** and the file is outside the version hash (both `CheckDirs` and the `checkVersions` task skip it): any edit to `check.yaml` is a new version and would invalidate the replay fixtures. No existing check's code or version changed.
    - A qualification is earned on the scaffolded variant only, over at least `min_runs` (3) runs and `min_positives` (6) labelled positives; point estimates meet the thresholds (the shootout's lower bounds are reported, not required).
    - Replay is transparent for qualification as it is for keys: a replay of a qualified engine carries that engine's identity.
    - The agent never has a HotCRP credential: authors and abstracts come from files a chair exports (`--authors`, `--abstracts-by-paper`).
    - Batch results are costed at the configured standard price (no batch discount modelled). The summaries travel in the bundle, but the app has no screen for them yet (M13).
    - `ImportKind.SCREENING_BUNDLE` and its columns are unchanged; the importer merges findings that share a `pid|check|ground` key.
    - Fixed on the way: `--class confidential` in `AgentCli` advanced the argument cursor once per enum entry tried (it never worked for `confidential`).
  - **Deferred / not done:**
    - **`summary` cannot be qualified:** its oracle has no labelled positives (M11 notes), so a confidential run of `summary` is refused until a rule for it exists (anchor validity and resistance, plus human ratings).
    - **Real qualifications:** none exist; `qualify` needs real engines on held-out (the M11 live run), and the shipped records file is empty. A stand-in earns nothing by design.
    - **Live batch:** the adapter is tested against a stub only; the SDK's batch result field names, the 100,000-request and 256 MB limits (one batch, no splitting) and the results endpoint are from the documentation and SDK types, not a live batch.
    - **App screens:** no import screen or findings view in the app (`pcs import bundle` is the CLI path); the findings comment through Writeback and the triage queue are M13.
    - **Done-when's "seeded conference" papers** have synthetic manuscripts assigned by position (the golden scenario has only a placeholder PDF), so the findings say nothing about those papers' titles.
    - A bundle holds no summaries unless the `summary` check is routed; with the gate, that is only for non-confidential data today.
  - **Decisions needed:** whether `check.yaml` should own thresholds anyway (at the cost of re-recording every fixture); the qualification rule for `summary`; whether the bundle's key should be wrapped to each chair's own key rather than sent as a separate secret.

## M13: Triage and desk reject (spec §10.4 B)

- **Scope:** the triage queue from bundle findings; the triage, second-opinion, remedy, and disposition traces of spec §11; notices rendered from grounds; timing under Q3; TriageFeedback under Q4; the per-AC consistency view; a `screening` scenario.
- **Done when:** the model's desk-reject cards (P1–P5, E3–E11, S12) pass as generated tests; on the `screening` scenario, every paper's disposition matches the model's, including a referral with no second opinion that stays in review (S8) and an anonymity case honoring Q1's fix window; the decision artifact passes its dry run.
- **Evidence:** `rule:may-remove` (T1, T2); `prop:S1`, `prop:S2`, `prop:S7`–`prop:S10`, `prop:S12` through T3 over every transition of the desk-reject subsystem (1,356 states today); `prop:S7`, `prop:S11`, `prop:C2` through T4; every admitted ground reached end to end and every unadmitted one unreachable (T5); `prop:M1`; the specification mutants "second opinion from anyone" and "silence removes" killed end to end.

- **Progress (2026-11-15, branch `m13-desk-reject`):** done locally on fresh harnesses (CI not run); no LLM call: the bundle in the scenario is built from synthetic findings.
  - **Built:**
    - **Model:** one desk-reject witness trace per reading, `ac-own-opinion-does-not-count` (the referring AC's own note is an opinion that never counts), so the "second opinion from anyone" mutant has something to break. No rule or proof changed.
    - **`core.rules.DeskFlow`:** the desk-reject step function (`deskRule`) behind the policy's grants, for T3.
    - **`core.triage`:**
      - `DeskFactsReader`/`DeskFacts`: a paper's referral read from the mirror (the hidden tag, else the Triage field of the AC's complete screen-round metareview; second opinions are complete screen-round reviews; the fix window, warning and decision from tags; a cure is an edit of the paper inside the window).
      - `TriagePlan`: the queue from the latest bundle's verified findings, the refcheck import and the AC's flag. Each paper gets a status (`UNTRIAGED`, `KEPT`, `NEEDS_SECOND_OPINION`, `OPINION_PENDING`, `NEEDS_WARNING`, `NOT_ADMISSIBLE`, `TOO_LATE`, `NEEDS_REMEDY`, `REMEDY_OPEN`, `CURED`, `READY`, `REMOVED`) and the conjuncts of `mayRemove` that fail, in words. `READY` is `DeskReject.mayRemove`. Q3 timing is the stage from the phase dates; a removal after `PCS_PHASE_DESKREJECT_DUE` is `late`. `SecondOpinions.candidates` lists unconflicted PC members of Q2's kind.
      - `Notices`: texts rendered from grounds (removal, fix window, warning, second-opinion request, the `[pcs:findings]` comment), with a `lint` for C2.
      - `TriageDrafts`: Writeback artifacts and mail drafts for each chair step.
      - `TriageFeedback`: S12's reveal rule, who is owed the Q4 form, answers kept locally (migration 007). The plan never reads them.
      - `Consistency`: per-AC counts and spreads, listed alphabetically, plus the `prop:M1` band (Tukey fence widened by 0.05).
      - `Session.triage()` and `Session.consistency()` as extension functions.
    - **Store:** migration `007-screening.sql` (`paper.modified_at`, `triage_feedback`) and one line in `Sync` that records the paper's modified time.
    - **`runner`:** the desk bindings now go through `core`: facts and plan from the synced mirror, and the AC's triage mirror, the unsubmit-and-move of her metareview (**M3a's leftover**), the fix window, the warning and the removal all through Writeback (draft, dry run, confirm, apply). A new control kills the "second opinion from anyone" mutant end to end (the AC's own note); "silence removes" is still killed.
    - **`seed`:** the `screening` scenario (papers 401-416 and 451-475; `Scenario.settings`, `Assign.round`, `ScreenReview` and `EditPaper` events). **`app`:** a Triage tab.
  - **Evidence:**
    - T1/T2: `CardsTest` (all desk cards, E3-E11, S12, under every reading) and `MayRemoveDifferentialTest`, unchanged and green.
    - T3: `DeskTransitionsTest` replays every transition of `transitions-desk.json` (both Q1 readings) against `DeskFlow` behind the policy's cells, refuses every other move, and evaluates S1, S2, S8, S9, S10 on each removal. `TriagePlanTest` checks `READY` iff `mayRemove` over 5 readings x grounds x stages x opinions x remedy states (over 100,000 states). `RunnerTest` runs all desk traces (37) end to end through `core`.
    - T4: `TriagePairedTest` (200 pairs differing in the giver and the engine give the authors identical text; C2), `TriagePlanTest` (S7: revising a ruling never removes a paper; S11 is `SecondOpinionPairTest`).
    - T10: `TriageMonitorTest` (`prop:M1` positive and negative) and `ScreeningScenarioTest` (end to end: an AC who refers every paper is outside the band).
    - Done-when: `ScreeningScenarioTest` (seeded `screening`): every case paper's status equals the scenario's written table at two instants, including a referral with no second opinion that stays in review (S8, 402) and the anonymity cases honoring Q1's fix window (405 needs the window, 406 open then ready after it closes, 407 cured and kept). Each paper's removability equals the Lean oracle's answer for the referral the mirror gives. The chair's steps run through Writeback against the harness, and the removal's decision artifact passes its dry run.
    - T12: `TriageUiTest`. `ControlsTest`: both named mutants caught.
  - **Not done / deviations:**
    - **Topic areas** are not in the mirror, so the consistency view is per AC only (it says so).
    - **Disagreement** has no trace: a second opinion agrees by completing its screen-round review; a member who disagrees leaves it and says so in a PC comment. A disagreement is therefore "no agreement yet", which is what the model needs (the model's `agrees` is always true in traces).
    - **Conflicted opinions** cannot be reached end to end (HotCRP gives a conflicted member no review), only by T2/T3. The AC's own note is the end-to-end case.
    - The **feedback form** is a drafted mail the chair sends, with answers entered by the chair; there is no reviewer-facing form. The app has no buttons for the chair's steps yet (the artifacts are in `TriageDrafts`, tested through Writeback); the tab shows the queue.
    - A "late" removal is judged by the stage at the clock's now: HotCRP records no decision time.
    - The fix window is a constant 72 hours (the model's), not a setting.
    - M1's notification is the tab's banner; no mail goes out.
    - Mail for notices is drafted, never sent (the Mail page takes no token).
  - **Decisions needed:** (1) the disagreement convention above; (2) whether the fix window length should be `PCS_REMEDY_WINDOW_H`; (3) the M1 band (Tukey fence, 5 papers, 4 ACs) is mine, not the spec's; (4) migration 007 may collide with another branch's.

---

# Phase C: Assignment

## M14: Solver core

- **Scope:** min-cost max-flow in `core`, on primitive arrays. Port HotCRP's `lib/mincostmaxflow.php` (lower bounds, cost scaling), keeping its copyright notice, or implement the primal-dual algorithm of the Lean reference; either way, test against both.
- **Done when:** on at least 200 random instances (including ones with lower bounds), the flow value and cost equal both HotCRP's PHP `MinCostMaxFlow` (run in the harness container) and the Lean solver, and flows are feasible; a 4,000-paper, 3,300-reviewer pruned instance solves in under 30 s in CI.
- **Evidence:** `prop:A5`; T2 against the Lean solver on random instances (equal flow value and cost) and against brute force on small ones.
- **Progress (2026-11-14, branch `m14-solver`):** done, with one deviation from the done-when (HotCRP's max flow is wrong on some instances, below).
  - **Built:** `net.jonbell.pcs.core.solver.FlowNetwork` (`core/src/main/kotlin/net/jonbell/pcs/core/solver/MinCostMaxFlow.kt`), an implementation of the Lean reference's primal-dual algorithm (Dijkstra on reduced costs, then Dinic on zero-reduced-cost arcs) on `IntArray`/`LongArray` adjacency with a primitive heap. Lower bounds and negative costs are handled by reduction: a lower bound becomes a demand met from a super source in a first, min-cost phase, with a free `sink -> source` arc; negative-cost arcs start saturated; the free arc is then removed and a second phase raises the flow value. It is not a port of `mincostmaxflow.php`, so no HotCRP code is copied into `core`; the PHP is only run, unmodified, by `scripts/mcmf-driver.php`. Solves are optimal even with negative cycles. Same contract as HotCRP's: no arc into the source or out of the sink, no lower bound on a source arc.
  - **Lean oracle:** new `minCostMaxFlow` query (`boundedFlow` in `model/ReviewProcess/Query.lean`, built on the unchanged `minCostMaxFlow`): lower bounds as demands plus a pre-saturated `t -> s` arc of cost `-M`, so the Lean solver's nonnegative-cost restriction holds. Corpus `model/export/oracle-mcmf.jsonl` (300 instances, 57 with lower bounds; the CI model job regenerates it). Existing exports, corpora and `model-report.txt` are byte-identical after regeneration.
  - **Tests (all `prop:A5`, T2):** the corpus (value, cost, feasibility from scratch: capacity, lower bounds, conservation, recomputed cost); 500 fresh instances through the live Lean oracle; brute force on 1,500 tiny instances with lower bounds and negative costs; hand cases. `MinCostMaxFlowPhpTest` (integrationTest, needs the harness): 760 random instances (half with negative costs, 333 with lower bounds) plus the 300 Lean-corpus instances through HotCRP's PHP.
  - **HotCRP deviation (found by this test, to report upstream):** `pushrelabel_make_distance()` runs before the preflow and walks back from the sink over residual arcs, so it reaches the source through its still-unsaturated arcs and gives it a distance of a few hops instead of n. Excess then returns to the source while longer augmenting paths remain. Smallest case: `source -3-> a, a -1-> sink, a -2-> b -2-> c -2-> d -1-> sink` returns flow 1, not 2. In the unpatched PHP, 21 of 362 compared random instances fall short of the true maximum (it never exceeds it, and when the values agree the costs agree). The driver's `patched` mode applies a one-line fix at run time (the source is excluded from that search); against the patched code every compared instance agrees on value and cost (760 of 760 random, 300 of 300 corpus). The unpatched run is kept as a test that only asserts "never above the maximum". On some feasible instances with lower bounds (40 of 800), HotCRP's push-relabel also never terminates, even patched; the driver's 1 s watchdog skips them and the test requires every such instance to have a lower bound. Decision for the chair: send the one-line fix to HotCRP (§10.6); the lower-bound hang is unexplained and is not needed for the assignment network, whose lower bounds are optional (`PCS_SOLVER_HARD`).
  - **Scale:** 4,000 papers (senior slot of 2 seats, third slot of 1), 3,300 reviewers in 24 areas, top 25 candidates per slot (200,000 candidate edges; 227,800 arcs; 11,302 nodes), a load band of 6 with convex costs: flow 12,000 (every slot filled) in 4.1 s on the dev machine, including JIT warm-up (limit 30 s). `MinCostMaxFlowScaleTest` is tagged `slow` for a nightly job but is cheap enough that it still runs in `check`.
  - **Not done:** the Lean FFI path is covered by the live oracle process, not by `libpcsffi`; no CI timing yet (the first CI run sets the baseline).

## M15: Assignment (spec §10.4 C, §10.5)

- **Scope:** the network of spec §10.5 under Q13 and Q14; load bands and nominee caps from `owes(u)`; pinned edges; affinity normalization; cycle and second-partition repair; the conflict-engineering monitor; TPMS round-trip validation; the bulk-assign CSV and the solve report; an `assignment` scenario.
- **Done when:** on the `assignment` scenario (an all-junior panel, an overloaded senior, an unaccepted nominee, and deliberate reciprocal 2- and 3-cycles), every paper meets its composition or is reported with a reason, no band is exceeded, no ineligible edge appears, the cycles are broken, and the CSV passes its dry run; on the model's synthetic conference, `core`'s solve report matches the Lean report's composition and shortfall counts.
- **Evidence:** `rule:composition`, `rule:load`, `rule:cycle-free` (T1, T2); `prop:A1`–`prop:A4`, `prop:V1`, `prop:V5`, `prop:M3`; `prop:S11` through T4 (two runs differing only in second-opinion answers give the same loads); the mutants "assign unaccepted" and "cycle K = 1" killed end to end.

- **Progress (2026-11-14, branch `m15-assignment`):** done locally on a fresh harness (CI not run).
  - **Built:**
    - `net.jonbell.pcs.core.assignment`: `Planner` (the §10.5 network as one `FlowNetwork` solve: unit source arcs with convex cost for PC members and cost 0 for a nominee up to what they owe, candidate arcs at `(100 - affinity) / 5`, senior seats of 2 and Q13's remaining seats); pinned edges (existing reviews and second-opinion members count toward the band and the seats and are never moved); `Cycles` (rings of up to `PCS_CYCLE_MAX_K` papers, repaired by forbidding the weakest edge and re-solving, `PCS_REPAIR_ROUNDS` rounds, the rest reported); `Partition` (at most n reviewers per institution, the same loop); `Affinity` (sources normalized to 0 to 100 and blended by `PCS_AFFINITY_WEIGHT_<SOURCE>`); `ConflictMonitor` (M3); `TpmsRoundTrip` (validate an imported TPMS assignment, then solve with the valid edges valued at the top of the scale); `AssignmentOutput` (the `paper,action,email[,round]` CSV, seniors first, as `primary` for a senior seat and `secondary` for the third; people not yet on the HotCRP PC are listed and held back); `SolveReport`; `AssignmentData` (mirror and imports to a `PlanInput`; bands from `PCS_LOAD_<TIER>_MAX`, nominee caps from `owes(u)`); `Planner.audit` (an independent re-check of V1, A1 to A4 that uses the signed rules, so a fault in the solver shows).
    - `Session.assignment()` and `draftAssignment()`; an **Assignment** tab (the report per paper with the reason a seat is short, loads, nominees, repairs, the monitor, the TPMS round trip, the CSV with Copy and "Draft in Writeback"); `pcs assign [--csv file]`.
    - Model: oracle query `plan` (the synthetic conference's instance and the Lean outcome); the appointment-and-assignment subsystem's observations, 12 witness traces (`model/export/traces-appt.json`), replay in `check-evidence`; `confirm` now needs a dry run first, as Writeback does (the report's appointment subsystem is 44 states, was 52).
    - Runner: `AppointmentBinding` binds the seven appointment actions and ten observations (the AC's decision and the nominee's consent are rows of the appointments sheet, imported per step; `solve` is `core`'s plan for the trace's paper; `dry-run`, `confirm` and `apply` are Writeback on the plan's CSV).
    - Seed scenario `assignment` (papers 201 to 212): an overloaded senior (best match for every paper, two existing reviews, band 4), a reciprocal 2-cycle (#201, #202) and a 3-cycle (#203 to #205), an accepted junior and senior nominee, an unaccepted nominee with the best affinity of anyone, #210 in conflict with all seven seniors, and a TPMS assignment with an all-junior panel (#211), an author, a conflict, an unaccepted nominee, cycles, and nine papers for one senior.
  - **Evidence:**
    - T2: `PlanOracleTest`, on the model's synthetic conference scaled to 150 papers under six readings of Q13, Q14 and Q18: composed papers, senior and other unfilled seats and load violations equal the Lean report's; the first solve's flow value and cost equal the Lean solver's; the objective after repair is within 2% (which optimum the first solve finds decides which edges a repair forbids) and nominee reviews within 3. `PlanTest` (hand-built instances and 150 random ones, each audited): A1 to A4, V1, V5, Q14, K = 2 and 3, a second partition, hard mode, the CSV order, M3 positive and negative.
    - T4: `SecondOpinionPairTest` for `prop:S11`: two mirrors that differ only in a second-opinion member's answer give the same pinned edges, edges and loads.
    - T10: `AssignmentTest` (core integration, 5 tests; scoped to its own papers, runs late, cleans up): the done-when on the scenario; the two mutants caught on it (mutant 2 plans the unaccepted nominee and the audit reports V1; mutant 9 leaves #201 and #202 reviewing each other and the audit reports A3); V5 and V2 under every Q18 and Q19 reading; the TPMS round trip; the CSV through Writeback's dry run, confirmation, apply, and the next sync (`OBSERVED`).
    - T5 and T6: the 12 appointment traces run on the harness and `check-evidence` re-derives them (83 records, 0 failing): a nominee appointed and assigned in HotCRP in each tier (`prop:L2`), one who hasn't consented or been classified never planned (`prop:V1`), the upload's order (sync, solve, dry run, confirm, apply), and a PC member who may not classify or apply. The negative control "core with the 'assign unaccepted' mutant" is a required spec mutant in `controls.json`.
    - T12: `AssignmentUiTest` (`view:assignment`), no Argos baseline yet.
    - Fresh harness: `:seed:integrationTest`, `:core:integrationTest`, `:runner:integrationTest` 68 tests; `:app:uiTest` 11; `./gradlew check` green; assurance report 0 failing, `rule:composition`, `rule:load`, `rule:cycle-free`, `prop:A1` to `A5`, `V1`, `V2`, `V5`, `M3`, `S11`, `L2`, `mutant:2`, `mutant:9` covered.
  - **Not done / deferred:**
    - `mutant:9` (cycle K = 1) is killed by the scenario test at the `core` level, not by a runner trace: no model subsystem has cycles, so there is nothing for `check-evidence` to replay.
    - The appointment traces are witnesses, not bounded-exhaustive: no T3 transition coverage is claimed for the subsystem, and no `cell:*` is covered for its L1 first-use traces (only `pc-member/classify` and `pc-member/apply-writeback`).
    - The 4,000-paper size is the model report's and M14's scale test; `check` runs the oracle comparison at 150 papers.
    - The second partition has no data source (the mirror has no affiliation), so `AssignmentData` never sets one; affinity from openreview-expertise or HotCRP preferences has the normalization hook and no importer (preferences aren't in the mirror).
    - `PCS_SOLVER_SLOT_BONUS` is accepted and unused: with a uniform bonus the soft solve is already a max flow, so the bonus changes nothing; a per-slot weighting would.
    - Argos baselines for the Assignment tab; the TPMS round trip's CSV isn't a separate artifact (the corrected plan is a report section, the plan's CSV is the artifact).
  - **Ambiguities resolved (listed for the maintainer):**
    - A senior-seat reviewer is assigned as `primary` and a third-seat reviewer as `secondary`; spec §10.5 gives only `paper,action,email,round`.
    - A nominee's cap is `owes(u)` in whole reviews, rounded up and never above the band (the model's `loadCaps`); a nominee who is not accepted gets the band, so V1 is the only thing that excludes them.
    - A PC member with no sheet row is senior (M7); an accepted nominee not yet on the HotCRP PC is planned but not in the CSV until the membership artifact is applied.
    - Q13 "zero to two juniors": ruled on 2026-11-15 (juniors may take first-pass seats beside the seniors, or come in as reciprocal reviewers, two at most); see "Rulings applied" below.
    - M3's thresholds (qualified = affinity of at least 50; at least 3 excluded, at least half of the qualified, and 2 standard deviations over the mean) are ours, kept by ruling and now settings `PCS_M3_*`; the spec says only "unusual share".
    - Cycle repair covers rings of up to `PCS_CYCLE_MAX_K` (default 3), repeating until none remain (cap `PCS_CYCLE_REPAIR_MAX_ROUNDS`, default 10, ruled 2026-11-15); what is left is reported (A3).
  - **Findings about HotCRP:** `primary` and `secondary` rows through `/api/assign` pass the dry run, apply, and sync back as review types 4 and 3; the `conflict` action in `batch/assign.php` records a declared conflict that the sync reads from `pc_conflicts`; both are confirmed by the scenario test (the next sync observed the reviews with their types, and #210's seven conflicts reached the plan). Nothing in M15 needs a HotCRP change.

---

# Phase D: Reviewing and decisions

## M16: Reviewing progress and accountability requests (spec §10.4 D)

- **Scope:** progress by tier with a nominee view; the coaching queue; accountability-request suggestions from metadata only; the request and disposition traces of spec §11; the engagement record under Q21; Accountability cases under Q20 and Q11; an `accountability` scenario.
- **Done when:** the model's accountability cards (C1–C8) pass as generated tests; on the `accountability` scenario, the engagement record equals the dispositions recorded in HotCRP, a dismissed suggestion leaves no trace (AR4), and "no reply" appears only after the due date, reminder, and grace (AR5); a test shows the suggestion code never reads review text (AR3).
- **Evidence:** `card:C1`–`card:C8`; `prop:AR1`–`prop:AR6`, `prop:V4` through T3 over every transition of the accountability subsystem; `prop:AR3` and `prop:AR4` through T4 (pairs differing only in review text, or in whether a suggestion was dismissed, give identical suggestions and engagement records); `prop:C1` through T7; the mutants "dismissed suggestion counts" and "heuristic sends itself" killed end to end.

- **Progress (2026-11-14, branch `m16-accountability`):** done locally on a fresh harness (CI not run); details and decisions below.
  - **Done:**
    - Model: cards **C2** and **C5** (the model had C1, C3, C4, C6, C7, C8), and X10's case rule: `Share`, `unmetPapers`, `casesFor` (one case per nominee, listing every nominating paper whose share went unmet) and `escalationTarget`, with the oracle query `caseListing` (corpus `oracle-caseListing.jsonl`, CI regenerates it) and `RulesDifferentialTest`. Accountability observations in `actions.json`, `traces-acc.json` (57 witness traces under both readings of Q20: first use of each granted cell, cards C1-C5, AR1, AR2, AR4, AR5, AR6, V4, denials), `transitions-acc.json` (every effective transition of the subsystem, 3,576 and 7,056 states, with the policy's granted cells), a `Verdict.observed` kind, and the `check-evidence` replay for the subsystem.
    - `core`: `rules/Accountability` gained `AccSt`, `AccAct` and `AccFlow` (the model's `accRule` guards); `accountability/` (`AccountabilityPlan`: progress by tier and the nominee view, the coaching queue, suggestions, requests, the engagement record, cases; `Suggestions`: the six heuristic signals over `ReviewMeta`; `AccDrafts`: the request text, the HotCRP Mail-tool steps, and the Writeback artifacts that record sent, reminder, disposition and case outcome; `AccLocal`: dismissals, manual suggestions, case status). Migration 006 (`tag_seen`, `acc_dismissal`, `acc_suggestion`, `acc_case`); the sync records when it first saw each `pcs-req`, `pcs-remind` and `~~pcs-case` tag. `Session.accountability()`. Conventions gained `pcs-remind-<ordinal><n>`. Settings `PCS_CRITERION_<n>`, `PCS_REQUEST_DUE_H`, `PCS_FIELD_WEAKNESS`, `PCS_FIELDS_REQUIRED` (spec §10.4 D).
    - `runner`: the eleven accountability actions and fourteen observations are bound (no `UnboundAction` left for the subsystem); `AccountabilityBinding` uses the HotCRP actor for a person's action, `core` through Writeback for a chair's, the mirror for what the heuristics derive.
    - `app`: an Accountability tab (progress and nominee view, coaching queue, suggestions with a request draft and dismiss, requests with reminder and disposition records, the engagement record with Q21, cases). It sends nothing; every write to HotCRP is a Writeback artifact a chair confirms.
    - `seed`: the `accountability` scenario (papers 301-303).
  - **Evidence:**
    - T1: `CardsTest` runs C1-C8 and X10 (generated from `cards.json`; C2 and C5 are new) under every reading, and the model's mutants 6 and 7.
    - T2/T3: `AccountabilityTransitionsTest` checks every transition and refusal of `transitions-acc.json` (1.2 million rule evaluations) against `AccFlow` behind the policy's cells, with AR1, AR2, AR4, AR5, AR6 and V4 evaluated on each transition `core` takes; `AccountabilityPlanTest` covers progress, the coaching queue, suggestions, request timing at the boundaries, engagement and cases over a hand-built mirror.
    - T4: `AccountabilityInformationFlowTest`: 200 pairs of worlds differing only in review text give identical suggestions and coaching (AR3), with a canary in the text appearing in nothing produced; 200 pairs differing only in whether suggestions were dismissed give identical engagement records, requests and cases (AR4); the signal type holds no field that can carry text, and the module's one `review_text` query selects field ids only.
    - T3/T5/T6 end to end: `RunnerTest` ran the 57 accountability traces against the harness (no mismatch, no boundary violation); `ControlsTest` caught the two named mutants, "dismissed suggestion counts" (the engagement record disagrees) and "heuristic sends itself" (`sent` disagrees); `check-evidence` replays the traces and controls.
    - T11: `AccountabilityScenarioTest` (seeded `accountability`): reminders and "no reply" at the boundaries (+47 h no, +49 h reminder, +96 h still inside the grace period, +97 h yes), the engagement record equal to the dispositions HotCRP's tags hold, a dismissed suggestion with no trace in HotCRP or on the record, and one case listing the nominee's papers, opened locally and upheld through Writeback.
    - T12: `AccountabilityUiTest` (5 tests, no harness).
  - **Not done / deviations:**
    - A dismissal, a manual suggestion, and an opened case are local to the chair's copy (the only HotCRP-visible state is the tags). Two chairs' copies agree on requests, dispositions and upheld cases, and may disagree on dismissals.
    - Mail sending is not exercised: the Mail page answers a Bearer token with 401, so a chair sends. The draft was not run through `GET /api/{p}/mailtext` (spec §11 says it is checkable that way).
    - `prop:AR1` is the model's "send needs the criteria list"; "the reviewer sees which criteria" is the draft's text and is checked by `AccountabilityPlanTest` and the UI test, not end to end.
    - A review's lateness is when a sync first saw it complete, so a mirror that first synced after the deadline dates everything late (the scenario syncs before it).
    - The `tag_seen` hook adds a few queries per paper to every sync; at 4,000 papers it is inside the measured full sync (M19: 9.4 s).
    - Transition coverage in the assurance report is still desk-reject only.
  - **Decisions needed:** (1) The reminder is the hidden tag `pcs-remind-<ordinal><n>` and the case tag is on every paper a case lists with `<n>` the nominee's number in the sorted accepted-nominee list; both are in spec §11's existing rows (no row added, so `conv:` claims are not renumbered). (2) The tag does not say who sent a request, so Q21's "the AC who sent each request" is read as the paper's AC. (3) Which Q20 reading the venue wants: both are implemented and shown while it is open. (4) `PCS_FIELD_WEAKNESS` has no default: a venue whose form has a weakness field must name it for the card C1 signal. (The grace period became a model parameter and `PCS_ACC_GRACE_H` on 2026-11-15.)

## M17: Early reject (spec §10.4 E)

- **Scope:** candidates under Q15, the bump window under Q16 from snapshots, the drafted mail search, and the decision artifact.
- **Done when:** the model's early-reject cards (R1–R4) pass as generated tests; a multi-stage scenario computes candidates at window open, some reviewers bump within the window and others don't, and at close the lists match expectations.
- **Evidence:** `card:R1`–`card:R4`; `prop:E-1`, `prop:E-2` through T3 over every transition of the early-reject subsystem; the mutant "early reject before the window closes" killed end to end.

## M18: Discussion dashboard (spec §5)

- **Scope:**
  - The discussion rules (spec §5a–§5c) as a pure Kotlin module: `(snapshot view, phase, now, thresholds) → per-paper reasons + severity`, plus per-AC and per-reviewer metrics. Each rule is its own function, with a weight and threshold setting and a reason string that includes the numbers.
  - The triage list (reason chips; filters by AC, rule, and tier), the paper drawer (timeline of reviews, score changes, comments, mentions, and the response), the AC table, reviewer outlier lists by tier, the person page, and the overview with the no-consensus burndown.
  - The wording rules of spec §7, enforced by a test over the UI strings for "disengaged", "absent", and "lazy".
- **Done when:** unit tests encode the golden table, each rule with positive, negative, and boundary tests, and the phase logic at several `PCS_NOW` values; UI tests on golden show the triage order computed from the table, no chips on paper 1, the day +3 ping in paper 4's drawer, and AC-busy and AC-idle distinguishable by the load column; Argos baselines exist for the triage list, paper 4's drawer, the AC table, a person page, and the overview.
- **Evidence:** every `golden:*` row through the view reader, in both directions (no missing and no extra chips); `prop:H3`.

## M19: Scale

- **Scope:** the `scale` scenario in the nightly job, across every module that exists.
- **Done when:** a full sync and a no-change re-sync, a full solve, and the main tables' render and filter times all meet budgets recorded in this milestone at its first run (starting points: sync under 8 minutes, re-sync under 3, solve under 30 s, table filter under 300 ms); DB size is reported in the job summary.
- **Evidence:** `prop:Q1` and each budget through T9, with the workload, environment, and statistical test in the evidence record. The residual-risk estimate of §A9 for T2–T4, first reported here and calibrated against held-out specification mutants.

**Progress (2026-11-15, branch `m19-scale`; CI, and the nightly job, not run):**

- **Budgets, recorded at the first run** (`docs/scale-budgets.json`; the four starting points are kept, the table render budgets are ours): measured on this host (32 cores, JDK 25, harness in Docker on localhost, `scale` seeded: 4,000 papers, 15,997 reviews including 4,000 metareviews, 9,076 comments, 3,366 PC members, 197,399 candidate edges), 10 runs each, 95th percentile (nearest rank) with its bootstrap 95% interval:

  | Budget | Limit | Measured p95 (interval) | Median |
  |---|---|---|---|
  | `sync.full` (empty store to mirror) | 8 min | 10.5 s (9.4 to 10.5 s) | 9.4 s |
  | `sync.noop` (re-sync, zero rows written, asserted) | 3 min | 6.9 s (6.4 to 6.9 s) | 6.4 s |
  | `solve.full` (build, flow, repair, audit, CSV; no pinned reviews) | 30 s | 5.1 s (4.6 to 5.1 s) | 4.5 s |
  | `table.papers.render` (4,000 rows) | 2 s | 0.95 s (0.37 to 0.95 s) | 0.34 s |
  | `table.reviews.render` (15,997 rows) | 2 s | 0.30 s (0.16 to 0.30 s) | 0.16 s |
  | `table.papers.filter` (slowest keystroke of a typed query) | 300 ms | 155 ms (63 to 155 ms) | 61 ms |
  | `table.reviews.filter` | 300 ms | 114 ms (53 to 114 ms) | 51 ms |

  Every budget holds, most by a wide margin. The harness is on localhost: a real instance adds network latency to every request (about 100 requests per sync), so the sync margin is not as wide as it looks, and the starting points are kept. The first cold run of the table is the p95 (JIT warm-up). Not budgeted, single timings: TPMS import of 240,000 rows 1.8 s, the discussion state 1.8 s, accountability 0.8 s, early reject 0.13 s. Store size **132.8 MiB** (encrypted SQLite; 241,500 import rows, 15,997 review versions, 31,854 FTS rows); HotCRP's own database was 143 MB. Seeding `scale` took 20.0 minutes on this host (the done-when for M2 is under 20; it needs the raised limits, ~35 minutes with the job's checkout and build).
- **Bottleneck found and fixed (contained, in `Plan.kt`).** The first 10-run measurement of `solve.full` missed its budget: median 31 s, p95 70 s (runs of 13 to 17 s early on, then 31 s and worse while the host was under memory pressure). The flow itself was never the cost (about 0.8 s for 12,000 units). The time was quadratic scans: `Planner.assess` filtered all 240,000 candidates once per paper (4,000 times) for the weak-affinity check and again per short paper in `reason`, looked each short paper up with `papers.first`, and recounted a nominee's eligible papers per nominee; `Cycles.find` compared all 16 million pairs of papers. They are now indexed once (candidates by paper, papers by id, an author-to-papers index that follows the reviews, a lazy per-person count). Output is unchanged (`PlanTest`, `PlanOracleTest`, the scenario tests). After: median 4.5 s, p95 5.1 s; 3 s of that is `AssignmentData.build` reading the mirror.
- **Workload notes.** The solve is the first assignment (the mirror's pinned reviews are dropped, so every seat is open); with them pinned it is 8 to 14 s before the fix and about the same after, with almost nothing to place. The scenario has no nominee fields, conflicts or institutions, so the appointments sheet the test imports classifies 300 juniors and 1,200 of the nominee accounts as junior (the rest are seniors with no row) and the solve fills all 4,000 papers (2 senior seats and the Q13 third seat). The 60 TPMS candidates per paper are random.
- **Evidence.** New record kind `measurement` (T9): the raw samples in integer milliseconds, the budget, the claim (`prop:Q1`), the workload, the environment and provenance. `lake exe check-evidence` re-derives the nearest-rank p95, the percentile-bootstrap interval (10,000 resamples of the sorted runs, SplitMix64 seed `0x5EED0019`, the same stream in Kotlin and Lean) and the verdict, and fails a record with fewer runs than it requires, a tampered sample or a missed budget (checked on tampered copies). The seven records pass. What the test can show: with 10 runs the nearest-rank p95 is the slowest run, and a clean sample shows "fewer than 5% of runs over budget" only at 40% confidence (59 clean runs for 95%); the record says so. `prop:Q1` here is the sync and solve parts of the scenario row (concepts §3.10). The "all checks within 72 h" part waits for the screening agent's checks (M8 to M12) and is not measured.
- **Residual risk (§A9), first report.** `ResidualRiskTest` (in `:core:test`, section in the assurance report). Units are the 18,500 inputs of the Lean corpus generator, taken as the T2 generator; each is run through `core` signed and under each of the ten specification mutants. A species is (rule, signed output, kill signature over the tuned mutants); the estimate is Good-Turing, f1 over n, with an upper bound, plus the rule-of-three bound 3 over n for a fault n units never hit; the stated risk is the larger. Mutants the corpus can kill: #0 to #5 and #7 (tuned #0, #2, #4, #7; held out #1, #3, #5); #6, #8 and #9 are generator-blind (T3, T5, T6 must catch them). Calibration: against 300 campaigns per rule and size (100, 300, 1,000 units), the estimate over the realised share of new species in the remaining units is 0.98, 0.98 and 0.95, and the realised share is under the upper bound in 96% of campaigns. Against the held-out mutants (300 campaigns each at n = 30, 100, 300), the novelty bound alone is under a surviving mutant's true detection rate in some campaigns (mayRemove #1, whose cells the species do not separate), and the stated risk gives false assurance (mutant survived, true rate above the stated risk) in 0.56% of 2,700 campaigns, under the 5% the report requires. Current estimate for T2 (n = 1,500 to 2,000 units per rule): the next unit is a new species with probability 0 for ten of the twelve rules, 0.0073 for `owes` (11 singletons in 1,500) and 0.0013 for `caseListing`; the stated residual risk is 0.0015 to 0.0020 for the ten (the 3 / n term), 0.0111 for `owes` and 0.0032 for `caseListing`. T3 (83 deterministic witness traces, not sampled) and T4 (not built) have no sampling generator, so they get no estimate. It says nothing about an attacker who searches.
- **Wiring.** Root `./gradlew scaleTest` runs `:runner:scaleTest` (sync, re-sync, imports, analyses, solve, store size; `PCS_SCALE_RUNS` overrides the 10 runs), then `:app:scaleUiTest` (render and filter in-process on the semantics clock under `xvfb-run`, on the store the first leaves in `build/scale`), then `:core:scaleSummary` writes `build/scale/summary.md`. CI: a separate `scale` job on `ripley-cloud-large`, schedule only, with a harness of its own (`pcs-scale-<run>`, port 18097, API limits 1,000,000 an hour and 50,000 a minute), seeding `scale`, measuring, appending the summary to the job summary (budgets, p95 and interval, DB size), then `lake exe check-evidence build/scale/records`, uploading the results, and tearing the harness down. It replaces the in-job "Scale scenario" step, which could not fit the 30-minute job.
- **Not done / deferred.** The 72-hour screening part of `prop:Q1`. The history backfill at `PCS_HISTORY_RPS` (default 1 per second) is a chair-triggered action outside the sync budget: for the 15,997 reviews it would take about 4.4 hours at the default. Residual risk for T3 and T4 until a sampling generator exists. Argos baselines for tables at scale. The CI job has not run on `ripley-cloud-large`, so its timings there are unknown (the budgets are judged on whatever host it runs on; the record names the runner).
- **Verification:** `./gradlew check` green (ktlintFormat first); on fresh golden harnesses, `integrationTest` green (6 min 20 s), `checkEvidence` 0 failing, `uiTest` 25 tests green; the assurance report has 0 failing claims, and `prop:Q1` is covered by T9. Both harnesses torn down.
- **Decisions needed:** (1) Whether to tighten the budgets now that the first run is in: sync, re-sync and solve have 40x to 5x margin on localhost, which suggests nothing, but a real instance's latency is unmeasured (a probe against a live instance would settle sync). (2) Whether 10 runs per budget is enough: it supports "all runs under budget", not "95% of runs" (59 runs for 95/95; the sync and solve are cheap enough, about 25 minutes more, if the chairs want that). (3) Whether the 240,000-row TPMS file, the appointments split and the 5-second solve stand for a real conference; the scenario has no conflicts, institutions or nominee data.

---

# Phase E: Afterwards

## M20: Process report and pseudonymous export (spec §10.4 G)

- **Done when:** the report renders from the `shadow` and `scale` scenarios; exported rows contain no email, only HMAC pseudonyms, stable for a given key.
- **Evidence:** `prop:C3`; T7 over the export (no email or name canary appears).

## M21: Federated evaluation kit

- **Scope:** one command (`pcs eval`) a past venue's chair runs on their own HotCRP export or token, offline by default, with their own engine choice (deterministic only, `openai-compat` local, or their own provider account). It computes check precision and recall against recorded desk rejects, TPMS profile coverage, composition feasibility under real conflicts, the early-reject rate under each Q15 reading, and cost per paper. It emits one deterministic aggregate report (counts and rates only; cells under 5 suppressed; no IDs, titles, names, or text) that the chair reads before sending. It ships as a signed installer, like the app.
- **Done when:** on the seeded conference, the report contains no identifier from the input (checked by scanning the report for every ID, title, and name in the export), every count under 5 is suppressed, and two runs give byte-identical reports with the replay engine.
- **Progress (2026-11-15, branch `m21-fedkit`):**
  - **Built (all in `cli`, package `net.jonbell.pcs.cli.eval`; `core` and the agent's check code are untouched):** `pcs eval (--export <dir> | --token-file <file>) [--pdfs dir] [--engine id] [--class ...] [--tpms-scores f] [--tpms-registrations f] [--desk-decision text] [--min-cell n] [--authors f] [--cfp f] [--abstracts-by-paper f] [--format-policy f] [--out f]`.
    - Input: a token reads `pc`, `search`, `papers`, `reviews` through `HotcrpClient` (no other path exists in it); an export is a directory of `pc.json`, `papers.json`, `reviews.json` as HotCRP's API returns them. Review text fields are dropped on the way in. PDFs are `<pid>.pdf` in a directory (the client has no PDF read path). A recorded desk reject is a paper whose decision text contains `desk` (`--desk-decision`).
    - Metrics: per-check and any-check precision and recall of the screening flags against the recorded desk rejects; TPMS profile coverage (members with a profile, papers with at least `PCS_REVIEWS_REQUIRED` usable non-conflicted scores); composition feasibility (the solver on the real conflicts and authorships, flat affinity, tiers from `PCS_TIER_TAGS`, untagged members senior, Q14 "tier decides", one solve per Q13 reading); early-reject candidates under each Q15 reading from final scores, and how many of them were rejected; cost per paper from the calls' costs.
    - Report: one Markdown file, no date, path or host. `Disclosure` is the only way a number is rendered: counts under 5 (zero included) show `<5`; a rate shows only if numerator and complement are both at least 5; precision, recall and true positives show only if all three confusion cells are at least 5; a check row must also differ from the any-check row by at least 5; nested counts (Q15 readings) must differ by at least 5. `--min-cell` can raise the minimum, never lower it. Nothing is sent: the code has no upload path, and the report goes to `--out` or standard output.
    - Offline by default: `NetworkGate` is asked before the only two things that can connect (`HotcrpClient` for `--token-file`, an engine for `--engine`); `replay` asks for nothing. The reference resolver and OCR are never configured. The engine runs the LLM checks (`Screener`, every check routed to it) with the dispatcher's clearance and qualification gate; the default data class is `confidential`. Engines come from `PCS_ENGINES` as for `pcs agent`.
  - **Evidence:**
    - `EvalKitTest` (unit, T7 family): a scan of the report for every ID, title, name, address, PDF hash, path and review-text canary of a synthetic conference (deterministic and replay); no integer under 5 in any cell; non-interference (any small cell, or one whose complement is small, can change without changing a byte of the report); nesting and rate rules; two runs byte-identical, deterministic and with the replay engine (whose recorded costs show); offline: zero gate calls and no proxy lookups or connections with no token and no engine, the gate asks for exactly `hotcrp` or `engine:<adapter>`, and a source scan that `HotcrpClient(` and `EngineFactory.create(` sit behind `gate.open(` and no kit file names a socket, HTTP client, process or writer.
    - `EvalHarnessTest` (integration, `cli`): on the harness's seeded conference, token mode, the same scan, the token absent from the report, and the same data as an export gives the same report.
    - `@Covers`: `prop:C1`, `prop:S5`, `prop:H4`, `prop:H5`. The model has no claim for the kit, so these are the nearest; see decisions below.
  - **Installer:** `scripts/package-pcs-linux.sh` builds `pcs` as a .deb the way `package-linux.sh` builds the app (cli uber jar, jlink'd runtime, jpackage; smoke test runs `pcs eval`), and a step in the `linux-package` CI job runs it. macOS and Windows are not done: they need the owner's runner and Developer ID credentials (macOS) and a Store account (Windows); the same script's jpackage call becomes `--type dmg|msi` there, unsigned until those exist, and `release.yml` has no `pcs` step yet. `pcs eval --engine` needs `PCS_AGENT_CHECKS` pointing at a checkout's `agent/checks` (the checks' directory is not packaged); a deterministic run needs nothing.
  - **Decisions needed:** (1) claim IDs for the kit (for example "the report discloses no cell under 5", "the kit is offline unless asked") in the model/spec, so the evidence is not borrowed from `prop:C1`; (2) whether zero counts should be suppressed (as built, following "counts under 5") or shown, since a zero recall numerator is the interesting failure; (3) the desk-reject marker (`desk` in the decision text) against what real venues call it; (4) whether a past venue's chairs may use a `confidential` engine, the same open item as M12's clearances.
  - **Deferred:** macOS and Windows installers and signing; packaging the checks directory; reusing M20's pseudonym helper (not needed: the report has no rows); a TPMS-aware composition (the solve uses flat affinity on purpose); early reject from the snapshot at a window's opening (needs review history, which an export lacks); a `pcs eval` option to dump a ready export from a token.

## Formal model ([model/](model/README.md))

The Lean model of docs/concepts.md. It grows alongside the milestones, and every milestone that implements a rule takes its tests from it.

- **Done (2026-11-12):** readings for Q1–Q21 except Q9 and Q12; rules for removal, early reject, nominee obligations, composition, cycles, dry run and accountability requests; 19 theorems (two are helper lemmas); 36 example cards with the legibility check; 10 mutants; a synthetic conference.
- **Done (2026-11-13):**
  - The policy table (§3.9) as a function of the reading, with Q4 added. Every trace step is gated by it, and eight theorems cover it: S6, only a PC chair removes, AR2, H2, nothing leaves the system, C2, Q4 = never.
  - The L1/L2 trace search over four subsystems: desk reject, early reject, accountability requests, appointment and Writeback. Every admitted ground, early reject, and nominee appointment is reachable; grounds the reading does not admit are unreachable.
  - Plan as a solver: min-cost max-flow on the spec §10.5 network (primal-dual), cycle repair, and a brute-force self-check. `a2_plan_eligible` proves A2 and V1 for any flow, and A1, A3, A4 and V5 are checked on every solve.
- **Next (needed by M1 and M3a):**
  - `lake exe export`: the readings, the example cards, the claim inventory (`claims.json`), and the model's actions and observations, as JSON, for M1's code generation and test generation.
  - `lake exe oracle`: the JSON-lines oracle of §A3 (rules, subsystem steps, observations, property predicates on recorded traces).
  - An observation function per role for each subsystem (what an AC, a PC member, an author, and a chair can see in each state), so traces carry expected observations, not just states.
  - Trace export from the trace search: witnesses, bounded-exhaustive traces per subsystem, and seeded random walks.
  - `lake exe check-evidence` (§A6).
  - The spec §11 conventions in the model: an encoding of each non-chair action as a HotCRP trace, a decoding, a proof that decoding an encoded action gives it back, and a proof that a trace written by a role whose cell is denied decodes to nothing.
- **Next (model content):**
  - Model the four direct HotCRP-write cells the trace search does not cover (PC chair, AC, junior PC chair, author), or narrow those cells. Spec §11 gives each a HotCRP trace; the model should check that table against the policy.
  - Ruling statuses (provisional, assumed) in the answers-file format, in both parsers.
  - A minimal set of cards for Q2.

## Rulings applied (2026-11-15)

Branch `rulings-model`. The owner's rulings on the Lean model, each with its Lean change, oracle query and corpus, Kotlin rule, tests, cards and spec text; the model report, the exports and the corpora were regenerated.

- **Venue parameters.** `Venue` in the model (`nomineesMax`, `patternMin`, `accGraceH`, defaults 3, 3, 48) rides on `Reading`; an answers file sets `venue.nominees-max`, `venue.pattern-min`, `venue.acc-grace-h`; the app reads `PCS_NOMINEES_MAX`, `PCS_PATTERN_MIN`, `PCS_ACC_GRACE_H` (`Settings.venue`, `pcs.conf.example`). Cards that depend on one (X3, X3b, X8, X9, X11, C3) export a case per sampled value; `CardsTest` runs each, and the mutants, under every one.
- **Q8 "up to n".** `compliance` uses `Venue.nomineesMax`; the oracle's `compliance` corpus varies it; `NominationRules.build` takes the venue. New card X11.
- **Q13 "zero to two juniors".** Reading: no seat is required (`thirdSlots` stays 0), but up to two may be filled (`thirdCap` = 2): juniors from the PC take first-pass seats beside the two seniors, and reciprocal nominee juniors take seats too, and both count toward the two (pinned reviews included). A reciprocal junior counts as a junior under this reading whatever Q14 says; a senior-classified nominee under "nominee not senior" still has no seat. The solver fills seats up to the cap wherever the band and owes(u) leave room, so on the synthetic conference nominees now meet what they owe (100%, from 43%). Other readings unchanged. `Planner` (cap 2, pinned count), `Pc.thirdCap`, `Pc.fillsThird`, `Pc.compositionOk`, the Lean `solveOnce`, `PlanOracleTest` (a new variant under "nominee not senior") and `PlanTest`.
- **Accountability grace.** `mayDispose` takes the venue's grace; the accountability rule, card C3 (its probe hours follow the grace), `transitions-acc.json` (carries `graceH`), `AccFlow`, `AccountabilityPlan` and `AccountabilityTransitionsTest` use it. New oracle query `mayDispose` and corpus.
- **Q9 repeats.** The model's signal already counted nominations rather than distinct nominees; it is now explicit (card X3b, repeated nominees in the `pattern` corpus, `NominationReportTest`), and the threshold is `Venue.patternMin`.
- **Appointment authority.** Model rule `decisionCounts`, oracle query `appointmentAuthority` and corpus, `RulesDifferentialTest`; policy cell `pc-chair/classify` granted ("in the sheet, any candidate"; `only_chair_or_ac_classify` proves nobody else holds it); T6 traces: a PC chair's classification is effective and the nominee is appointed, and a PC member, an author, a nominee and the junior PC chair are denied. No new sheet column: `ac_email` names who decided and the mirror's `person.roles` says who is a chair. Card X12.
- **Interpreted:** "a PC chair" is the model's `pcChair` role. The process chair's `classify` cell stays unexamined (denied); HotCRP has one chair role, so `core` cannot tell them apart and treats any chair as a PC chair. The card gallery shows the venue's values only where the model sampled them (nominees max 1, 2, 3, 5; pattern 2, 3, 4; grace 0, 24, 48, 72), else the defaults' outcome.

### Branch `rulings-infra` (owner's rulings on behaviour and infrastructure)

- **Cycle repair.** `PlanConfig.repairRounds` defaults to 10 (`PCS_CYCLE_REPAIR_MAX_ROUNDS`, replacing `PCS_REPAIR_ROUNDS`); the loop already repeated until no ring remained, only the cap was 3. The model's `maxRepairRounds` is 10 too, so the report (`model-report.txt`: 0 rings left, was 1) and oracle test agree. `PlanTest`: a hub paper needing more than 3 rounds (the 3-round cap leaves a ring, reported; 10 clears it).
- **M3 monitor.** `PCS_M3_AFFINITY_MIN`, `_MIN_EXCLUDED`, `_MIN_SHARE`, `_SIGMA` in `AssignmentSettings.monitor`, `pcs.conf.example`, tested at non-default values (`PlanTest`).
- **Spec §11.** Rows 15 `pcs-er-object`, 16 `pcs-remind-…`, 17 `~~pcs-case-<n>` appended; the text left rows 8 and 10 (row 10 is now the chair's decision, pointing at row 17). `ConventionsTest` has harness tests for 15 and 16 and covers 17 with the chair-only-tag test; the round trip and `ConventionsCodecTest` cover all three. Assurance: 17 convention claims, 17 covered, 0 failing.
- **Early-reject backfill.** `SnapshotGap` (`EarlyRejectPlan.snapshotGap`), `Session.backfillReviewHistory()`, a "Backfill review history" button on the tab, never automatic. `EarlyRejectUiTest` (stub `/reviewhistory`): gap shown, no request until the click, one request per review, candidates appear.
- **Lateness dating.** `AccReview.submitted(due)`: first complete version from `/reviewhistory` if read, else `modified_at` when not after the deadline, else unknown (not flagged late, reported). First-seen is the cross-check (`AccountabilityReport.dating`, shown on the tab). `AccountabilityPlanTest`: first sync after the deadline, reviews on time: not late.
- **M4 follow-ups.** (a) `check` depends on `:app:uiTest` when `PCS_HOTCRP_URL`/token (or `.env.test`) exist, the URL is localhost and answers, and there is a display (or Xvfb, which the task starts and stops itself); else it prints why and passes. CI's check step uses `-x :app:uiTest`. (b) `scripts/package-linux.sh` and a `linux-package` CI job (also used by `release.yml`): Temurin 25 has no jmods, so Compose's jlink step fails on `jdk.jlink` with includeAllModules (now an explicit module list, also needed for macOS and Windows, untested there), and ProGuard stops on unresolved members (release build now has it off). Even with a jlink'd runtime, the Compose-built launcher segfaults in `setenv` before the JVM starts with its ~80-entry classpath; the uber jar (one entry) works, so the script runs jpackage on it with a jlink'd runtime. Result: an 88 MB .deb that passes `--smoke` locally. (c) `HotcrpClientRateLimitTest` against a JDK stub server; the client got an injectable sleeper, attempt count and clock, reads `x-ratelimit-*` (`rateLimit`; a 429 without `Retry-After` waits for a future reset), and gives up with a clear message. (d) `model/answers/complete.txt`; `CardGalleryUiTest` and `ShellUiTest` use it.
- **Evidence (fresh harness):** `check` 0 failures with `:app:uiTest` inside it; seed 5, core 56, runner 11 integration tests green; `check-evidence`: 144 records, 0 failing; assurance report 0 failing claims.
- **Interpreted:** the early-reject gap is mirror-wide (no review version at or before the opening); the cycle-repair setting name replaced the old one.

## Open items (maintainer)

- Shadow PC phase dates. These are only needed for real use; CI uses synthetic dates. If the shadow PC's discussion phase comes before the target conference's submissions open, M18 moves ahead of Phase B (it depends only on M1–M5).
- Whether to add a post-hoc shadow-vs-real comparison (spec §5d). Not scheduled.
- Upstream HotCRP PRs (spec §10.6): action-log and mail-log endpoints; JSON `override` fix.
- **Questions for the TPMS operator**: can we get the score matrix, and the registration status as a CSV? What is the assignment CSV's column layout? Current price and turnaround?
- Screening agent: which engines get `confidential` clearance (needs a settled decision on the provider agreement); where a self-hosted GPU engine runs; permission for any `confidential` evaluation corpus.
- Make sure the `ripley-cloud-gha` App installation covers this repo (docs/ci.md, one-time setup).
- Attach the maintainer's macOS CI runner to the repo and store the Developer ID signing and notarization credentials as CI secrets (M4's release workflow). Windows needs a Microsoft Store developer account, not a certificate.
- Kotlin + Compose vs. Java 21 + JavaFX: Kotlin is the default; switching is cheap until M4 starts.
- **Decided 2026-11-13:** ACs are metareviewers and PC chairs are the paper administrators; requests to reviewers go through HotCRP's mail tool; Q5 = the second-opinion member reviews a kept paper (their screen review is unsubmitted automatically); JDK 25; macOS signing in CI, Windows through the Store. With ACs as metareviewers, the AC acts through reviews and the chairs keep the tags: triage is a field in the AC's screen-round metareview; PC Supervisor mirrors it into a hidden tag and unsubmits and moves the review to the normal round; findings are a reviewer-visible comment. All verified on the harness (spec §11, `ConventionsTest`).

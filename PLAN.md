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
- **M2** mostly done: the seeder and `golden` (seeds in about 2 s), verified against the table through the strict client. The `shadow` (150 papers) and `scale` (4,000 papers) generators exist, with a fixed seed and reviews submitted 50 per request; neither has been seeded yet. Seeding `scale` needs the harness image rebuilt with the raised API limits (`HOTCRP_API_PER_MINUTE`, `HOTCRP_API_PER_HOUR`).
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
    - This machine's JDK 25 has no `jmods`, so Compose's jlink step (`:app:packageDeb`) can't run here. `scripts/package-linux-local.sh` runs the same jpackage step with the whole JDK as runtime image. CI's Temurin 25 has jmods, and `release.yml` uses the Gradle task, unrun.
    - `uiTest` includes tests that need no harness (gallery, shell, settings); only `GoldenUiTest` needs it, so `check` stays harness-free and doesn't run the UI tests.
    - "What an unresolved question blocks" is derived from `model/export/cards.json` and `policy.json` (shipped as `core` resources) because no feature-level map exists. The screen says so. Questions that no card or ruling cell depends on say "nothing in the model's cards or policy table yet".
    - Window size is fixed (1280x1400) and density is the test default of 1.0; the test API in this Compose version has no density parameter.
    - The `synthetic.txt` answers file leaves 12 questions unresolved, so the gallery shows blocked cards too.
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
| `card:` | concepts §3.11 example cards (`card:X9`, `card:C3`), one claim per card and reading | 38 cards |
| `rule:` | concepts §3.8 rules (`rule:may-remove`, `rule:owes`, `rule:composition`) | ~10 |
| `cell:` | concepts §3.9 policy cells (`cell:ac/triage`), one per role and permission | 207 (9 roles × 23) |
| `conv:` | spec §11 HotCRP conventions, one per row | 12 |
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
| **T1 Cards** | `card:*`, `q:*` | the exported cards: one test per card and per reading that changes its outcome | `core` (fast), then as a scenario end to end | 38 cards × their readings |
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

## M7: Nominations and appointments (spec §10.4 A)

- **Scope:** per-paper nominee checks against Q8 and Q10; `owes(u)` under Q18, Q19, and Q19b; nomination patterns for the PC chairs (Q9); the submission cap (Q17); the appointments import driving Writeback drafts for PC membership and tier tags; a `nomination` scenario.
- **Done when:** the model's cards for Q7, Q8, Q10, Q18, Q19, Q19b (X1–X10) pass as generated tests; the `nomination` scenario (a paper with no nominee, a person nominated by three papers, a declined co-nominee, an author over the cap) is fully reported; a candidate accepted, classified, and consenting in the sheet produces a membership artifact that passes its dry run.
- **Evidence:** `rule:owes`, `rule:eligible` (T1, T2); `card:X1`–`card:X10` under every reading of Q7, Q8, Q10, Q18, Q19, Q19b; `prop:V2`, `prop:V3`, `prop:V5`, `prop:M4`; T5 witnesses for nominee appointment (`prop:L2`); T6 for an appointment trace written by someone who isn't the paper's AC.

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

## M10: LLM checks

- **Scope:** `anonymity` (the LLM half), `scope`, `refs.use` (abstract variant), and `summary`; the classifier half of `injection.addressed`; `injection.effect` (the with-and-without rerun and the per-call monitors); anchor verification; flag cards; decision records and the manifest.
- **Done when:** the manifest renders from check directories and decisions; unverifiable anchors are never shown; a flag depending on an `unresolved` decision renders as blocked.

## M11: Evaluation

- **Scope:** the `public` and `held-out` corpora, mutation operators, the metrics of agent.md §7.3 including stability and scaffold delta, and the `pcs agent shootout` report.
- **Done when:** a shootout over at least 3 engines (including one self-hosted) on `held-out` produces per-check frontiers with confidence intervals and a projected cost at `PCS_AGENT_SCALE_PAPERS`.

## M12: Qualification and the screening bundle

- **Scope:** qualification records and refusal of unqualified (check, engine) pairs; change classification in `plan`; batch submission; **the screening bundle** (encrypted, content-addressed, with its manifest) that `core` imports.
- **Done when:** a run on the harness's seeded conference produces a bundle that another copy of the app imports with identical findings; a prompt edit shows up as "needs requalification" with the flags it moves.
- **Evidence:** `prop:S6` (the agent has no write path; checked by T6 attempting each write with the agent's credentials).

## M13: Triage and desk reject (spec §10.4 B)

- **Scope:** the triage queue from bundle findings; the triage, second-opinion, remedy, and disposition traces of spec §11; notices rendered from grounds; timing under Q3; TriageFeedback under Q4; the per-AC consistency view; a `screening` scenario.
- **Done when:** the model's desk-reject cards (P1–P5, E3–E11, S12) pass as generated tests; on the `screening` scenario, every paper's disposition matches the model's, including a referral with no second opinion that stays in review (S8) and an anonymity case honoring Q1's fix window; the decision artifact passes its dry run.
- **Evidence:** `rule:may-remove` (T1, T2); `prop:S1`, `prop:S2`, `prop:S7`–`prop:S10`, `prop:S12` through T3 over every transition of the desk-reject subsystem (1,356 states today); `prop:S7`, `prop:S11`, `prop:C2` through T4; every admitted ground reached end to end and every unadmitted one unreachable (T5); `prop:M1`; the specification mutants "second opinion from anyone" and "silence removes" killed end to end.

---

# Phase C: Assignment

## M14: Solver core

- **Scope:** min-cost max-flow in `core`, on primitive arrays. Port HotCRP's `lib/mincostmaxflow.php` (lower bounds, cost scaling), keeping its copyright notice, or implement the primal-dual algorithm of the Lean reference; either way, test against both.
- **Done when:** on at least 200 random instances (including ones with lower bounds), the flow value and cost equal both HotCRP's PHP `MinCostMaxFlow` (run in the harness container) and the Lean solver, and flows are feasible; a 4,000-paper, 3,300-reviewer pruned instance solves in under 30 s in CI.
- **Evidence:** `prop:A5`; T2 against the Lean solver on random instances (equal flow value and cost) and against brute force on small ones.

## M15: Assignment (spec §10.4 C, §10.5)

- **Scope:** the network of spec §10.5 under Q13 and Q14; load bands and nominee caps from `owes(u)`; pinned edges; affinity normalization; cycle and second-partition repair; the conflict-engineering monitor; TPMS round-trip validation; the bulk-assign CSV and the solve report; an `assignment` scenario.
- **Done when:** on the `assignment` scenario (an all-junior panel, an overloaded senior, an unaccepted nominee, and deliberate reciprocal 2- and 3-cycles), every paper meets its composition or is reported with a reason, no band is exceeded, no ineligible edge appears, the cycles are broken, and the CSV passes its dry run; on the model's synthetic conference, `core`'s solve report matches the Lean report's composition and shortfall counts.
- **Evidence:** `rule:composition`, `rule:load`, `rule:cycle-free` (T1, T2); `prop:A1`–`prop:A4`, `prop:V1`, `prop:V5`, `prop:M3`; `prop:S11` through T4 (two runs differing only in second-opinion answers give the same loads); the mutants "assign unaccepted" and "cycle K = 1" killed end to end.

---

# Phase D: Reviewing and decisions

## M16: Reviewing progress and accountability requests (spec §10.4 D)

- **Scope:** progress by tier with a nominee view; the coaching queue; accountability-request suggestions from metadata only; the request and disposition traces of spec §11; the engagement record under Q21; Accountability cases under Q20 and Q11; an `accountability` scenario.
- **Done when:** the model's accountability cards (C1–C8) pass as generated tests; on the `accountability` scenario, the engagement record equals the dispositions recorded in HotCRP, a dismissed suggestion leaves no trace (AR4), and "no reply" appears only after the due date, reminder, and grace (AR5); a test shows the suggestion code never reads review text (AR3).
- **Evidence:** `card:C1`–`card:C8`; `prop:AR1`–`prop:AR6`, `prop:V4` through T3 over every transition of the accountability subsystem; `prop:AR3` and `prop:AR4` through T4 (pairs differing only in review text, or in whether a suggestion was dismissed, give identical suggestions and engagement records); `prop:C1` through T7; the mutants "dismissed suggestion counts" and "heuristic sends itself" killed end to end.

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

---

# Phase E: Afterwards

## M20: Process report and pseudonymous export (spec §10.4 G)

- **Done when:** the report renders from the `shadow` and `scale` scenarios; exported rows contain no email, only HMAC pseudonyms, stable for a given key.
- **Evidence:** `prop:C3`; T7 over the export (no email or name canary appears).

## M21: Federated evaluation kit

- **Scope:** one command (`pcs eval`) a past venue's chair runs on their own HotCRP export or token, offline by default, with their own engine choice (deterministic only, `openai-compat` local, or their own provider account). It computes check precision and recall against recorded desk rejects, TPMS profile coverage, composition feasibility under real conflicts, the early-reject rate under each Q15 reading, and cost per paper. It emits one deterministic aggregate report (counts and rates only; cells under 5 suppressed; no IDs, titles, names, or text) that the chair reads before sending. It ships as a signed installer, like the app.
- **Done when:** on the seeded conference, the report contains no identifier from the input (checked by scanning the report for every ID, title, and name in the export), every count under 5 is suppressed, and two runs give byte-identical reports with the replay engine.

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

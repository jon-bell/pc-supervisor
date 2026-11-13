# PC Supervisor: spec

A desktop application for the chairs of a program committee that runs on HotCRP. It mirrors the HotCRP instance, keeps what HotCRP can't (snapshots over time, imports, screening findings, plans), and drafts every change to HotCRP as an artifact a chair reviews and applies. It supports the whole review process in [concepts.md](concepts.md):
- nominations and PC appointments;
- submission screening and desk reject;
- assignment;
- reviewing, with accountability requests;
- early reject;
- discussion and decisions.

concepts.md is the conceptual design: concepts, rules, policy, properties, and examples. This spec implements it. Where the two disagree, concepts.md wins. The Lean model in [`model/`](../model/README.md) is the executable form of concepts.md, and the implementation is tested against it (§9.1).

The first deployment is a shadow PC of a few hundred papers. The design target is a large conference:
- ~4,000 submissions and ~12k reviews;
- two senior PC reviews plus one junior PC or reciprocal-nominee review per paper;
- ~3,300 reviewers, counting accepted nominees.

Moving between the two deployments must be a configuration change, not a rewrite.

> **Decided:**
> - PC Supervisor is a **desktop app on the JVM** (Kotlin, Compose Multiplatform), installed by each chair. There is no server and no open port (§4).
> - **HotCRP is the shared record.** Everyone except the chairs acts in HotCRP, or, for appointments, in the appointments sheet. Each chair's copy rebuilds its state from HotCRP, the imports, the answers file, and the screening bundle, so two chairs' copies agree without a shared server (§11).
> - The users are the process chairs and the PC chairs, each with a chair (sysadmin) API token.
> - Area chairs are **metareviewers** (`rtype` 5).
> - Review and comment text is **stored locally, encrypted**.
> - Policy choices come from the **answers file** that the Lean model also reads. Operational settings come from the environment or a conference file. Secrets come from the OS keychain (§4.1).
> - CI runs a disposable HotCRP and seeds it (§9).
>
> API facts below are from HotCRP `master` @ `60f693f` (2026-10-06) and were re-checked against a running instance of that commit (`hotcrp/`). Live hosted instances may lag master, so M0 in [PLAN.md](../PLAN.md) probes the real one.

---

## 1. What the API gives us (and what it doesn't)

Auth is a bearer token: *Account settings → Developer* on a real instance, or `batch/apitoken.php` in the test harness. A chair token gives a site-admin view, and `forceShow` defaults to true.

| Need | Endpoint | Notes |
|---|---|---|
| Paper list, status, decision, tags | `GET /search?q=all&f=…&format=csv` · `GET /papers` | `f` takes display fields: `title status decision tags lead shepherd manager reviewers revstat`. The default scope `t=s` covers submitted papers only, so pass `t=all` when you need drafts and withdrawn papers. |
| Who's assigned what, by role | `GET /searchaction?action=get/pcassignments&q=all` | CSV `paper,action,email,title`. Actions are `metareview`, `primaryreview`, `secondaryreview`, `pcreview`, `lead`, `shepherd`, plus a leading `clearreview` row per paper. **Verified.** |
| Reviews: scores, text, status, type, reviewer | `GET /reviews?q=all` | Fields: `rid pid rtype status ordinal reviewer_email version`, plus one field per review-form UID. In the default form those are `OveMer RevExp PapSum ComAut ComPC`; read the real UIDs from the instance. `rtype` 1 ext · 2 PC · 3 secondary · 4 primary · 5 metareview. `status` is empty/acknowledged/draft/delivered/approved/complete. **Verified.** |
| Review edit history | `GET /{p}/reviewhistory?r=…` | Admin-only, one review per call. **Used for backfill only** (§4). In steady state we diff our own snapshots. |
| Discussion comments | `GET /comments?q=all` | `cid pid author_email text topic visibility response draft modified_at tags by_author by_shepherd`. **Verified**, including `actas`-authored comments and `@mention` detection. |
| PC roster + user tags | `GET /pc` | Roles and visible user tags. Tiers (junior / reciprocal) come from user tags. |
| Activity feed | `GET /events` | Pre-rendered HTML, 10 per page. **Don't use it.** |
| Ratings of reviews | **included in `GET /reviews`** (`ratings` field) | Flags: `good needswork short vague narrow disrespectful wrong`. Encoding: a sorted **multiset** of flags (`["short","short","vague"]` means 2 raters said short and 1 said vague); a bare string for a single flag; absent when unrated. **No rater identity and no timestamp, even for chairs.** Raters must be able to see the review (co-reviewers after submitting, or the metareviewer), and nobody can rate their own review. Per-review `GET /{p}/reviewrating` exists but isn't needed. `rate:<flag>` works in searches. **Verified.** |

**API facts that differ from what the docs suggest (from the harness):**

- **Review `version` is an opaque version tag, not a counter.** Seen values: 269888, 455859, 157921. Detect change by inequality only, never by ordering.
- **Review `modified_at` is admin-visible, but HotCRP suppresses it when `reviewModified <= timeRequested`, which includes a review requested and submitted in the same second.** That matters for seeding (§9.3). In production, treat a missing `modified_at` as "unknown" and fall back to `first_seen_at`.
- **Comment `word_count` is null for ordinary comments.** We compute word counts ourselves.
- **Ratings depend on instance settings.** `review_rating` (`pc` | `all` | `no`) controls who may rate, and `review_rating_visibility` controls who sees them. `pcs probe` reports both; if ratings are off, the rating-based signals are hidden, not shown as zero.
- **`POST /reviews` ignores `override=1` for JSON bodies**; only text-form uploads honor it. The seeder works around this by opening review deadlines in settings. This may be worth an upstream issue.

**Gaps that shape the design:**

- **Comments have no creation timestamp.** We only get `modified_at`, and an edit overwrites it. The sync therefore **snapshots**: it records `first_seen_at` for every `cid` and `rid`, and timestamped metrics use the earliest time observed. Items that already existed at the first sync take `modified_at` as a best guess, and the UI marks them as approximate.
- **No action log or mail log via the API.** Reminder emails sent through HotCRP's Mail tool, assignment changes, and logins are all invisible. A "nudge" is therefore defined as **activity inside HotCRP**: AC comments, `@mentions`, and tags. A scraper for the admin `/log` page is a possible later adapter.
- **No read activity.** We can see who *writes*, not who *reads*. The UI wording reflects this (§7).
- **Token handling.** `core` reads the bearer token from the OS keychain. It never reaches the UI layer, a log, or an error message.

---

## 2. Design choices

| Axis | Choice |
|---|---|
| Data freshness | Periodic full sync (`PCS_SYNC_INTERVAL_MIN`, default 15) plus a manual "sync now". Live calls can't give us history. |
| Store | SQLite (SQLCipher), one file per conference on each chair's machine. |
| Writes | Every change to HotCRP is a **Writeback** artifact (concepts §3.2): drafted, dry-run in HotCRP, confirmed by a chair, applied, and observed on the next sync. Nothing writes before PLAN M5. |
| Users | The process chairs and PC chairs, each running their own copy. Every other role acts in HotCRP (§11). No accounts, no server, no open port. |
| Shared state | Derived, not shared. Each copy rebuilds from the same inputs (§11), so there's nothing to keep in step between chairs. |
| Policy | Rulings come from the answers file. A question with no answer is unresolved, and whatever depends on it is blocked and shown as blocked (concepts §3.1). |
| Metric style | Rules that fire with a human-readable reason, rolled into a ranked attention list. No single opaque score. |
| People views | An outlier list plus per-person drill-down. **No leaderboards.** |
| Phase awareness | Thresholds depend on the current phase, which comes from the phase dates (§10.1) and the clock. |
| LLMs | **None over review or comment text**: the dashboard uses text heuristics only, and review text never leaves the machine. The separate **submission-screening agent** ([agent.md](agent.md)) reads submissions, and only on inference engines cleared for their data class. |

---

## 3. Data model (local)

```
person(email PK, name, roles[], tags[], tier)          -- /pc; tier from tag mapping
paper(pid PK, title, status, decision, tags[], synced_at)
assignment(pid, email, role)                           -- get/pcassignments
review(rid PK, pid, email, rtype, status, round, ordinal, vtag,
       modified_at NULL, first_seen_at, first_complete_seen_at,
       scores JSON, word_count, ratings JSON)                 -- ratings as {flag: count}
review_version(rid, vtag, seen_at, source, scores JSON, status)  -- source: snapshot|history
rating_change(rid, seen_at, before JSON, after JSON)    -- ratings carry no vtag change or timestamp; diff per sync
review_text(rid, vtag, field_uid, text)
comment(cid PK, pid, email, topic, visibility, is_response, draft,
        word_count, mentions[], modified_at, first_seen_at, deleted_seen_at NULL)
comment_text(cid, modified_at, text)
sync_run(id, started_at, finished_at, now_used, counts JSON, errors JSON)
fts(text)                                              -- FTS5 over review_text + comment_text
```

- **Area chairs** are the reviewers holding `rtype` 5 on a paper, so a paper can have co-ACs. The AC's own metareview status comes straight from that review's `status`. `PCS_AC_ROLE` (§4.1) allows `lead`, `manager`, or `tag:<name>` in case a future instance encodes ACs differently.
- **Tiers** come from user tags (`PCS_TIER_TAGS`). Junior and reciprocal reviewers get their own outlier lists, because reciprocal reviewers are the group most likely to drop out.
- **Mentions:** parse `@Name` / `@email` out of comment text, resolve them against the roster, and store the emails.
- **Deletions and unassignments** are detected by absence in a full sync. Record them; don't silently drop rows.

**State PC Supervisor owns.** Each item can be rebuilt from an input a chair holds, so losing a machine loses nothing but snapshot history:

```
answers(qid, reading, file_hash, loaded_at)                  -- rulings, from the answers file (§4.1)
import_run(id, source, at, file_hash, rows, row_errors JSON) -- versioned imports (§10.3)
finding(pid, check, version, ground, anchors JSON, engine, status, bundle_hash)  -- from the screening bundle
artifact(id, kind, body, purpose, drafted_at, dry_run JSON,
         confirmed_by, confirmed_at, applied_at, observed_at, mismatch JSON)    -- Writeback
plan(id, inputs JSON, objective, report JSON)
plan_edge(plan, pid, email, slot, pinned)
```

Everything else (triage state, dispositions, accountability requests, engagement records) is derived at read time from the HotCRP conventions of §11.

---

## 4. Architecture

```
HotCRP ◄── bearer token ── core (sync, store, rules, solver, Writeback) ◄── in-process ── app (Compose Desktop)
                              ▲                          ▲
                imports, answers file          screening bundle ◄── pcs agent run (one chair's workstation)
```

Gradle modules:

| Module | Holds | Depends on |
|---|---|---|
| `core` | HotCRP client (Ktor client; kotlinx.serialization with strict decoding), sync, store (sqlite-jdbc with SQLCipher), rules, solver, Writeback, the answers reader, imports. **No UI imports.** | nothing else here |
| `app` | The Compose Multiplatform desktop UI. It calls `core` in-process; sync runs on a background coroutine dispatcher. | `core` |
| `cli` | `pcs`: `core` without a window. Used by CI, the probe, the screening batch, and the federated evaluation kit. | `core`, `agent` |
| `agent` | The screening agent ([agent.md](agent.md)). Writes a content-addressed, encrypted bundle that `core` imports. | `core` |
| `seed` | The scenario driver for the harness. Tests only. | `core` |
| `model/` | The Lean model (its own build). Exports the readings and the example cards as JSON, from which Gradle generates the reading types and the card tests (§9.1). | — |

- **Sync** makes a handful of bulk calls per run: `/pc`, `get/pcassignments`, `/search` with fields, `/reviews`, and `/comments`. Reviews and comments are fetched in **pid-range chunks** (`PCS_SYNC_CHUNK`, default 200), as `POST …?:method:=GET`, with bounded concurrency (`PCS_SYNC_CONCURRENCY`, default 2) and backoff on 429/5xx. Every run is a full fetch, diffed locally.
- **`/reviewhistory` is a one-time background backfill** at `PCS_HISTORY_RPS` (default 1). After that, snapshots capture changes at sync resolution.
- **Clock injection:** all phase logic reads `now` from `core`'s `Clock`. `PCS_NOW` (ISO timestamp) pins it, for tests and for replaying a past state.
- **Metrics** are SQL views plus a Kotlin rules module evaluated at read time, so changing a threshold and re-opening re-ranks everything. Indexes go on `pid` and `email`.
- **UI:** Compose Desktop with lazy (virtualized) tables; 4,000 rows must stay smooth. Every row deep-links into HotCRP in the system browser: `/paper/{pid}`, `/review/{pid}{ordinal}`, `/search?q=…`.
- **Screening runs outside the app.** It needs GROBID and engine credentials, so one process chair runs `pcs agent run` on a workstation. The resulting bundle (findings with anchors and quotations) goes to the other chairs, encrypted, with the key sent separately, and each app imports it. The app never calls an engine.
- **Packaging:** `jpackage` with a `jlink`ed runtime builds signed installers for macOS (notarized), Windows, and Linux. There is no auto-update, because the only allowed outbound calls go to HotCRP (§7). A new version is a signed release a chair downloads.

### 4.1 Configuration

Configuration comes from three sources, and startup validates all of them and lists every problem at once:

1. **The answers file (policy).** The same format `model/` reads (`model/answers/synthetic.txt`): `Qn = <reading key>` lines. The app's reading types are generated from the Lean model, so a reading the model doesn't know is a startup error. A question with no line is unresolved (§2). This replaces the old `PCS_POLICY_*` variables. Each conference keeps its answers file outside this repo.
2. **Settings.** `PCS_*` keys, read from the environment, else from the conference file `pcs.conf` (`KEY=value` lines, the same names). `pcs.conf.example` is the full, documented list.
3. **Secrets.** The API token and the DB key live in the OS keychain (macOS Keychain, Windows Credential Manager, libsecret). `PCS_HOTCRP_TOKEN` and `PCS_DB_KEY` are read from the environment only when `PCS_HOTCRP_URL` is a `127.0.0.1`/`localhost` URL, which is to say in tests and CI.

| Variable | Meaning | Default |
|---|---|---|
| `PCS_HOTCRP_URL` | Instance base URL, e.g. `https://conf2027-shadow.hotcrp.com` | required |
| `PCS_ANSWERS` | Path to the answers file | required |
| `PCS_TZ` | Time zone for phase dates and display | `America/New_York` |
| `PCS_PHASE_*` | Phase dates (§10.1) | required for the phases in use |
| `PCS_NOW` | Pin the clock | unset = real time |
| `PCS_AC_ROLE` | `meta` \| `lead` \| `manager` \| `tag:<t>` | `meta` |
| `PCS_TIER_TAGS` | e.g. `junior=junior,nominee=nominee`; untagged PC members are senior | empty |
| `PCS_FIELD_MERIT` / `PCS_FIELD_EXPERTISE` | Review-form UIDs | `OveMer` / `RevExp` |
| `PCS_MERIT_ACCEPT_MIN` | Lowest merit value on the accept side | `3` |
| `PCS_EXPERTISE_OK_MIN` | Lowest "knowledgeable" expertise value | `3` |
| `PCS_REVIEWS_REQUIRED` | Complete reviews needed per paper | `3` |
| `PCS_RULE_<NAME>_WEIGHT`, `PCS_THRESH_<NAME>` | Rule weights and thresholds (§5c) | see code |
| `PCS_LOAD_<TIER>_MAX` | Load band per tier (concepts rule `load`) | senior 15, junior 8 |
| `PCS_DB_PATH` | SQLite file | the OS's app-data directory, `<host>.db` |
| `PCS_SYNC_INTERVAL_MIN`, `PCS_SYNC_CHUNK`, `PCS_SYNC_CONCURRENCY`, `PCS_HISTORY_RPS` | Sync tuning | 15 / 200 / 2 / 1 |
| `PCS_FORCE_SHOW` | `false` = respect the chair's own conflicts | `true` |

---

## 5. Metrics and rules

Windows are relative to the phase-date env vars. Every threshold has an env override.

### 5a. Reviewer engagement (per person)

| Signal | Definition |
|---|---|
| Outstanding / late | Assigned reviews not complete (or delivered) after `REVIEW_DUE`. |
| Review depth & quality | Word count vs. the PC median (flag the bottom decile), plus **rating flags received**: counts of `short`/`vague`/`needswork`/`narrow`/`wrong` vs. `good`, across all their reviews. A reviewer whose reviews repeatedly draw negative flags from different papers is a coaching case. |
| Discussion participation | Share of their in-discussion papers where they've commented since `DISCUSSION_OPEN`. |
| Responsiveness | After an `@mention`, or an AC comment on their paper: the median time to their next comment there. Unanswered pings older than `PCS_THRESH_PING_DAYS` are listed. |
| Movement | Score/expertise changes after `DISCUSSION_OPEN` (from `review_version`). |
| Silent on split papers | Their "split" papers (§5c) with no comment from them. **This is the most actionable reviewer flag.** |

The view is an outlier list plus a person page (every paper, their score, their last comment, open pings).

### 5b. Area chair activity (per AC)

| Signal | Definition |
|---|---|
| Coverage | Share of their papers with an AC comment since `DISCUSSION_OPEN`. |
| Time to first post | From `DISCUSSION_OPEN`, or from the last review landing if later, to the AC's first comment. |
| Nudges | AC comments that `@mention` a reviewer, or that are posted while ≥1 reviewer is silent (a labeled proxy). |
| Stale papers | No activity in `PCS_THRESH_STALE_DAYS` during discussion. |
| Metareview status | Their `rtype` 5 reviews by status, against `DECISIONS_DUE`. |
| Load | Paper count vs. flagged count, so a load problem reads differently from an engagement problem. |

The view is one row per AC (activity sparkline, coverage, stale, flagged). Clicking a row filters the triage list.

### 5c. Paper risk

Each rule fires with a reason string. Rating-based reasons quote the counts, e.g. "review B: 2× short, 1× vague". Severity is the sum of weights. Sort by severity, then by time to `DECISIONS_DUE`.

| Rule (`NAME`) | Fires when | Default weight |
|---|---|---|
| `MISSING_REVIEWS` | complete < `PCS_REVIEWS_REQUIRED` after `REVIEW_DUE` | 3 |
| `SPLIT` | merit range ≥ `PCS_THRESH_SPLIT_RANGE` (2), or there are scores on both sides of `MERIT_ACCEPT_MIN` | 3 |
| `UNRESOLVED_SPLIT` | split, no movement since `DISCUSSION_OPEN`, discussion older than `PCS_THRESH_UNRESOLVED_DAYS` | +2 |
| `SILENT_DISCUSSION` | in discussion, 0 comments since `DISCUSSION_OPEN` | 3 |
| `GONE_QUIET` | last activity older than `PCS_THRESH_STALE_DAYS`, no decision | 2 |
| `AC_ABSENT` | no AC comment since `DISCUSSION_OPEN` | 2 |
| `CHAMPION_MISSING` | the top merit is ≥ `MERIT_ACCEPT_MIN`, and that reviewer hasn't commented | 1 |
| `LOW_EXPERTISE` | no review with expertise ≥ `EXPERTISE_OK_MIN` | 2 |
| `THIN_REVIEWS` | a review under `PCS_THRESH_MIN_WORDS`, or flagged short/vague by ≥ `PCS_THRESH_RATING_RATERS` (2) raters | 1 |
| `RESPONSE_UNADDRESSED` | an author response exists, with no reviewer comment after it | 2 |
| `REVIEW_FLAGGED` | any review on the paper carries a `disrespectful` or `wrong` rating. **Phase-independent**, because a disrespectful review needs chair action before authors see it | 4 |
| `DEADLINE_NO_CONSENSUS` | < `PCS_THRESH_DEADLINE_DAYS` (3) to `DECISIONS_DUE`, no decision, and split or silent | +3 |

Views:

- **Triage list:** pid, title, AC, scores, reason chips, last activity, and a link.
- **Paper drawer:** a timeline of reviews, score changes, comments (author, word count, mentions), and the response.
- **Overview:** counts by phase, a score-spread histogram, flagged papers per AC, and a **burndown of papers without consensus** against the phase dates.

### 5d. Shadow-PC extras

- **Review-quality view for coaching:** depth, rating flags, specificity.
- (Later, optional) Compare shadow outcomes with real outcomes, if they become available.

---

## 6. Writeback (actions)

Every change to HotCRP is a Writeback artifact (concepts §3.2). PC Supervisor never sends email; mail goes through HotCRP's Mail tool, sent by a chair from a drafted search and template.

| Artifact | HotCRP mechanism | Dry run |
|---|---|---|
| A search for any filtered set | a copyable `/search?q=…` | none needed |
| Nudge or request comments | comment text to paste, or a batch posted with `actas` after confirmation | preview only |
| Tags (attention, triage handoff, early-reject candidates) | `POST /assigntags` | `dry_run=1` |
| Assignments (a Plan, a fix-up of an imported TPMS assignment) | bulk-assign CSV, `POST /assign` | `dry_run=1` |
| PC membership and tier tags (Appointment) | `POST /assign` user actions, or `saveusers` | `dry_run=1` where supported |
| Decisions for desk and early reject, with notices | decision CSV plus a rendered notice for the Mail tool | `dry_run=1` |

After an artifact is applied, the next sync must show its effect, or the artifact is flagged with the mismatch (H2). Every write path is end-to-end tested against the harness, never against a live instance.

---

## 7. Confidentiality and tone

- **Local only.** There's no hosted mode and no telemetry. At runtime, the app's only outbound calls go to `PCS_HOTCRP_URL`. The screening agent's calls are governed separately (agent.md §5).
- **No open port.** The UI and `core` share a process. Nothing listens on a socket.
- **The DB is the most sensitive artifact** (every review and comment, plus reviewer identities).
  - Encrypt it with SQLCipher. The key lives in the OS keychain.
  - The default path is the OS's app-data directory, outside the repo and outside any synced folder.
  - `pcs wipe` deletes it.
  - The repo holds **synthetic data only**. No real review text, names, or emails ever go into fixtures, tests, issues, or screenshots.
- **The screening bundle** holds quotations from submissions. It is encrypted, and the key travels separately from the file.
- **No LLM over review text.** The screening agent reads submissions only, under the clearance and egress rules in agent.md §5.
- **Wording:** "no comments yet", not "disengaged"; "no in-HotCRP activity", not "absent".
- **Conflicts:** `PCS_FORCE_SHOW=false` hides papers the chair is conflicted with.

---

## 8. Milestones

See [PLAN.md](../PLAN.md).

---

## 9. Testing

### 9.1 Layers

These layers implement the assurance method in [PLAN.md](../PLAN.md) (§A1–§A11): which claims each test is evidence for, how expected results come from the Lean model, how the real system is bound to the model's actions and observations, and the coverage gates.

| Layer | What it covers | Where it runs |
|---|---|---|
| Unit | Rules, metrics, the mention parser, config validation, snapshot diffing. JUnit 5 with in-memory SQLite and a fixed `PCS_NOW`. | Every push |
| Property | jqwik properties for the solver (composition met or reported, no band exceeded, no ineligible edge) and for snapshot diffing. | Every push |
| Model | Tests generated from the Lean model: one parameterized test per example card and reading, checking the Kotlin rule gives the card's outcome. The Lean solver is the oracle for `core`'s solver on random instances (equal flow value and cost). | Every push |
| API contract | Strict kotlinx.serialization schemas for every HotCRP response we consume, checked against the seeded harness. This catches drift when `HOTCRP_REF` is bumped. | Every push; nightly against HotCRP `master` |
| Integration | Seed scenario → sync → assert DB state. Multi-stage scenarios: seed stage 1, sync, mutate, advance `PCS_NOW`, sync, assert diffs. Writeback paths: draft → dry run changes nothing → confirm → apply → the next sync observes it. | Every push |
| UI | Compose UI tests drive the app against a synced golden scenario: the triage ranking, reason chips, AC table, person page, drawer timeline, and the Writeback review screen. | Every push |
| Visual (Argos) | Screenshots from the UI tests at fixed states of the golden scenario, plus the card gallery (every example card rendered under the answered reading), uploaded with the Argos CLI. Roborazzi gives developers the same comparison offline. Stability: fonts are bundled, animations don't auto-advance, `PCS_NOW` is pinned, window size and display scale are fixed, and relative-time text and sync timestamps are masked. Linux is the baseline; macOS and Windows upload a smoke set as separate builds. Uploads come from CI only, through the Argos GitHub App (tokenless), and they show **synthetic harness data only**. An approval is recorded as a human-reviewed view in the assurance manifest (PLAN §A5, T12). | Every push (Argos diffs PRs against `main`) |
| Scale | The `scale` scenario (~4,000 papers, ~12k reviews). Assert sync time, solve time, and UI interaction budgets. | Nightly / manual |

### 9.2 The harness (`hotcrp/`)

- `hotcrp/Dockerfile` builds HotCRP from a pinned commit: PHP 8.3 + Apache, with MariaDB 10.11 running on tmpfs. `scripts/hotcrp-up.sh` brings it up, creates a chair, mints a token, and writes `.env.test`. Each run gets a fresh database.
- Gotchas already solved in the image:
  - Apache needs `SetEnvIf Authorization` to pass bearer tokens through to PHP.
  - The MariaDB client needs `--skip-ssl`.
  - HotCRP is fetched as a codeload tarball, not a git clone.

### 9.3 The seeder (`seed/`)

Scenarios are declarative files: PC members (with tags), papers, assignments, and a **timeline** of events at day offsets relative to the phase dates (review submitted, score changed, comment posted, response posted, decision set). The driver runs in three steps:

1. **Structure via batch scripts** (`docker compose exec`):
   - `batch/settings.php save` for settings. Open review deadlines here, because `override` doesn't work for JSON reviews.
   - `batch/saveusers.php` for users.
   - `batch/savepapers.php` for papers. They need a PDF to count as submitted; the PDF's `content_file` must be relative to the JSON file's directory.
   - `batch/assign.php` for assignments: a CSV of `paper,action,user` with actions `metareview|primary|secondary|pcreview`.
2. **Activity via the API:**
   - `POST /reviews` with `notify=0`.
   - `POST /{p}/comment?actas=<email>&notify=0`, which is how comments get authored "by" ACs and reviewers.
3. **Time-warp via SQL.** Shift each object's timestamps **as a unit**, preserving HotCRP's invariants:
   - For a review: `timeRequested ≤ reviewModified`, `reviewSubmitted`, and `timeDisplayed`. Otherwise `modified_at` disappears from the API.
   - For a comment: `timeModified`, `timeDisplayed`, `timeNotified`.

Open item: the user-JSON keys for **name and tags** in `saveusers.php` didn't take in the smoke test (`tags` and `given_name` were ignored). Check `batch/saveusers.php` / `UserStatus` for the right keys.

Scenarios to ship:

- **`golden`**: ~12 papers, each built to trigger exactly one rule (plus a clean control). The expected reasons live beside the scenario. This is the E2E oracle.
- **`shadow`**: ~150 papers with realistic spread. Used for demos and manual UI work.
- **`scale`**: generated from a fixed RNG seed.

### 9.4 CI

See [docs/ci.md](ci.md).

---

## 10. Large-conference modules (PLAN Phase B onward)

These modules implement concepts.md §3.3–§3.6 for a large conference with blended reviewing:
- **two senior PC reviews plus one junior PC or reciprocal-nominee review** per paper (the exact slots are Q13 and Q14);
- **reciprocal nominees**: each submission names nominees from among its authors (Q8). An AC accepts and classifies each one before they join the PC (Appointment);
- assignment by our own solver, from TPMS scores or other affinity sources (§10.5);
- **screening and desk reject** at submission;
- **early reject** after initial reviews (Q15, Q16);
- **accountability requests** during reviewing.

HotCRP remains the system of record. Where action is needed, the tool drafts **HotCRP-native artifacts** (§6) for a chair to apply, dry-run first.

### 10.1 Extended phase model

Each phase date is an env var:

`PCS_PHASE_REGISTRATION_DUE`, `PCS_PHASE_SUBMISSION_DUE`, `PCS_PHASE_DESKREJECT_DUE`, `PCS_PHASE_APPOINTMENTS_DUE`, `PCS_PHASE_ASSIGNMENT_DONE`, `PCS_PHASE_REVIEW_DUE`, `PCS_PHASE_EARLYREJECT_OPEN`, `PCS_PHASE_EARLYREJECT_CLOSE`, `PCS_PHASE_RESPONSE_OPEN/_CLOSE`, `PCS_PHASE_DISCUSSION_OPEN/_CLOSE`, `PCS_PHASE_DECISIONS_DUE`.

The modules activate by phase. **Single cycle (decided).** There is no resubmission linking and no per-cycle phase sets.

### 10.2 Tiers

A PC member's tier is `senior` or `junior`, as their AC classified them, and they joined as invited, self-nominated, or a reciprocal nominee (concepts `Tier`). Both come from PC user tags (`PCS_TIER_TAGS`). Accepted nominees are **added to the PC**, not requested as external reviewers, because HotCRP can't change an external reviewer's round without a new request. Which slot a nominee fills follows Q14.

### 10.3 Imported data (local files, `pcs import <kind> <file>`)

| Kind | Content | Keyed by |
|---|---|---|
| `appointments` | The appointments sheet (CSV export): every PC candidate, whether invited, self-nominated, or nominated by papers, with columns `email, origin, nominated_by (pids), area, ac_email, decision (accept/decline/pending), tier (senior/junior), consent, on_pc_at`. **This sheet is the source of truth for AC decisions, tiers, and consent; the tool never edits it** | email |
| `tpms-assignments` | TPMS's assignment CSV, the only output a HotCRP venue is documented to receive. **The column layout is unpublished**, so the importer takes a column mapping (`--map paper=…,email=…[,round=…]`) | pid + email |
| `tpms-scores` | The affinity matrix `paper,email,score`, with scores as floats in 0–1 (the same shape as CMT's TPMS download and openreview-matcher's `--scores`). It must be requested from the TPMS operator; whether HotCRP venues get it is **unconfirmed** | pid + email |
| `tpms-registrations` | Reviewer registration status. TPMS has an operator-run status page with no confirmed export, so the importer accepts `email, registered[, n_papers, last_updated]` and degrades to a plain registered list. Repeated imports are diffed | email |
| `screening-bundle` | The screening agent's output (agent.md): findings with anchors, the manifest, and qualification records | pid |
| `refcheck` | Output of an external reference checker. Superseded by the screening agent, but kept so an external tool's output can be imported | pid |

Imports are versioned like snapshots, so "what did the sheet say on day X" is answerable. An import takes all rows or none, and reports row-level errors.

**Exports to TPMS** (`pcs export tpms <dir>`). TPMS has no API, no HotCRP integration, and no chair self-service; data is exchanged as files with the operator. The tool prepares:
- the PC list with emails;
- the HotCRP conflicts CSV;
- one load-group file per tier and load band;
- the reviews-per-paper target.

The PDF ZIP comes from HotCRP's own download.

### 10.4 Modules

**A. Nominations and appointments** (from registration through assignment; concepts Nomination, Appointment, SubmissionLimit)
- Per paper: the nominees named, against Q8. A paper that names none follows Q10, which can make it a referral on the ground `nomination-noncompliance`, through the two-person path of module B.
- Per person: what they owe, `owes(u)`, combined across the papers that name them under Q18 and split under Q19. The model's rule is the specification, and the model's cards are the tests.
- A declined nominee's share goes to the paper's other nominees or is left unmet (Q19b). It never goes to someone the authors didn't name (V2).
- Nomination patterns across an author's papers (Q9) are shown to the PC chairs as a signal, never as a ground (V3).
- Authors over Q17's cap are reported to the PC chairs; the tool never withdraws a paper.
- Appointment: from the `appointments` import, a candidate who is accepted, classified, and consenting, but not yet on the PC, produces a Writeback draft that adds them with their tier tag.
- Evidence about seniority for the AC (optional): self-declared fields, TPMS registration if imported, and an **optional DBLP lookup** that counts papers at a configurable venue list. It sends only public author names, never submission content. It's a hint for a human, never a verdict.

**B. Screening triage and desk reject** (concepts §3.4; the agent's side is agent.md)
- A queue of `paper → findings (from the screening bundle), refcheck, AC flag → AC triage (keep, or refer with grounds) → second opinion (one unconflicted PC member who isn't the AC; Q2) → remedy where Q1 grants one → chair action → notice`.
- The timing follows Q3. Desk rejects after the desk-reject window (`PCS_PHASE_DESKREJECT_DUE`) are tracked as late.
- Silence never removes (S8): with no verdict, an unanswered request, or a disagreement, the paper stays in review.
- **TriageFeedback** under Q4: once a reviewer's review is submitted, they're shown the screening record and asked for feedback on the triage. Answers are collected for the evaluation (agent.md §8) and never affect that paper.
- **Consistency across ACs:** flag rate, triage outcomes, and desk-reject rate per AC and per topic area, with their spread. The UI shows distributions, not a ranked list of people (§7).

**C. Assignment** (the highest-value module; concepts Affinity, Plan)
- **Composition** per paper, from Q13 and Q14 (concepts rule `composition`); **load** per tier from `PCS_LOAD_<TIER>_MAX`, and for accepted nominees, `owes(u)` as a target and never more than their band.
- **Eligibility** (concepts rule `eligible`, V1): only people an AC accepted and classified, who consented, and who aren't authors of or conflicted with the paper.
- **Conflict sanity:** same affiliation, DBLP co-authorship (optional), and **reciprocal cycles**. Because nominees are authors, detect 2-cycles (and short k-cycles, `PCS_CYCLE_MAX_K`) in the graph whose edges run from an author of paper P to a reviewer of paper P.
- **Conflict engineering (monitor M3, concepts §3.10):** papers whose declared conflicts exclude an unusual share of the qualified reviewers in their area are reported to the PC chairs, never used as a ground.
- **TPMS round-trip:** validate an imported TPMS assignment CSV *before* it reaches HotCRP, and emit a corrected HotCRP assignment CSV (seniors first, then the third slot).
- **TPMS cannot enforce tier composition.** It maximizes affinity under per-reviewer load balancing only, and has no notion of per-paper composition requirements. TPMS also readily assigns undeclared conflicts, so the conflict cross-check above is mandatory. **We solve the assignment ourselves** (§10.5), and TPMS output becomes one input: scores if available, otherwise its assignment as a warm start that gets validated.
- **Cold-start reviewers** (no TPMS profile, which is common for junior PC members and nominees) can get local affinity scores from **openreview-expertise** (SPECTER2/MFR). It runs entirely on a chair's machine using titles and abstracts. Its hosted API is **not** allowed, because it would send submissions to a third party.

**D. Reviewing progress and accountability requests** (concepts Attention, Criterion, AccountabilityRequest, Accountability)
- Outstanding and late reviews by tier, with a dedicated nominee view.
- **Coaching queue:** junior and nominee reviews below the depth floor or rated short/vague, linked into HotCRP, where the coaching happens as comments.
- **Accountability requests:** PCS suggests a request from review metadata and structure only (AR3), citing criteria from the PC chairs' list (AR1). The AC or junior PC chair sends it and records the reviewer's reply as a disposition (`revised`, `explained`, `declined`, `no reply`, `disputed`); "no reply" only after the due date, one reminder, and the grace period (AR5). A dismissed suggestion leaves no trace (AR4).
- **Engagement record:** counts of dispositions per reviewer, visible as Q21 says. It separates reviewers who engage with mentorship from those who don't.
- **Accountability cases** about accepted nominees: a missing review, or under Q20 a quality problem after an earlier declined or unanswered request (AR6). The consequence follows Q11, always through the two-person path (V4).

**E. Early reject** (concepts EarlyReject)
- Candidates: papers whose initial reviews are all negative under Q15, each shown with its discussion signals.
- Under Q16's bump window: a drafted mail-tool search for "re-read and bump within N hours" (`PCS_EARLYREJECT_WINDOW_H`, default 48), and window tracking from snapshots. At close, list the candidates bumped, those not, and the reviewers who never responded.
- Removal follows E-1: every initial review negative at the time of removal, the window closed, no AC objection, and a chair's action.

**F. Discussion and decisions:** §5, plus tier-aware participation (do junior reviewers and nominees comment?).

**G. Process report** (after the conference)
- Junior vs. senior vs. nominee depth, timeliness, **rating-flag distributions** (flags received per review, by tier), and score agreement.
- Nominee acceptance and dropout rates, early-reject yield, desk-reject counts, and TriageFeedback results.
- **Pseudonymous IDs** (a keyed HMAC of the email, with a chair-held key, `PCS_PSEUDONYM_KEY`) on every exported row, so the data could join a future cross-conference baseline without exposing identities.

### 10.5 Assignment solver (port of HotCRP's autoassigner)

**Why a port:** HotCRP's min-cost max-flow (`lib/mincostmaxflow.php`: push-relabel max flow, then cost-scaling push-relabel, with **edge lower bounds**) and its network construction (`src/autoassigner.php`) are well documented, compact (~2.6k lines of PHP), and MIT-style licensed. Keep the copyright notice in ported files. Running it ourselves lets us add the constraints HotCRP and TPMS lack, and keep scores local.

**Network** (one solve, exact and integral, because each reviewer feeds only one slot kind of a paper):

```
source ──(one arc per unit of load up to the band; cost rising per unit for PC members,
          zero for a nominee up to owes(u))──► reviewer r
reviewer r ──(cap 1, cost from affinity; only eligible, unforbidden candidates)──► p.senior or p.third
p.senior ──(cap 2)──► sink            (reviewers who fill a senior slot under Q14)
p.third  ──(cap = Q13's remaining slots)──► sink   (junior PC, and nominees as Q13 and Q14 allow)
```

- **Soft first, hard optionally.** Hard lower bounds make the whole solve infeasible if a single paper can't be staffed (e.g. too few unconflicted seniors in its area). The default models each required slot as an edge with a large negative cost (`PCS_SOLVER_SLOT_BONUS`), so the solve always succeeds, and every unmet requirement is reported per paper. This is the same technique as HotCRP's expertise gadget. `PCS_SOLVER_HARD=1` switches to true lower bounds.
- **Load balance:** convex per-reviewer costs on the source edges, as in HotCRP (`paper_assignment_cost × i`), so loads spread within each band.
- **Fixed assignments** (reviews already made, and second-opinion members under Q5) are pinned with lower bound 1.
- **Affinity sources, in priority order:**
  1. the `tpms-scores` import;
  2. local openreview-expertise scores (SPECTER2/MFR);
  3. HotCRP preferences, expertise, and topic scores (`get/allrevpref`).
  Sources are normalized to one integer scale, with weights in env.
- **Scale:** ~3,300 reviewers and ~8,000 paper-slot nodes. Edges are pruned to the top `PCS_SOLVER_TOPK` (default 25) candidates per paper slot, plus all pinned edges, giving ~200k edges. Use primitive-array adjacency (`IntArray`); the target is under 30 s for a full 4,000-paper solve. The Lean reference solves this size in about 2 s.

**What flow can't express, handled by repair passes** (each reports what it changed):
- **Reciprocal cycles.** These are pairwise, not flow constraints. Detect 2- and short k-cycles in the assignment's author→reviewer graph; forbid the lowest-affinity edge of each cycle; re-solve warm. Repeat until clean, or until the cap is hit, then report the rest.
- **Second partitions** (e.g. at most one reviewer per institution per paper, crossing tiers): the same forbid-and-re-solve loop. FairIR (openreview-matcher, run locally) remains the fallback if those constraints become central.

**Outputs:**
- a HotCRP bulk-assign CSV (`paper,action,email,round`), always applied by a chair through HotCRP with a dry run first;
- a solve report: objective value, per-paper unmet requirements, load histogram by tier, repairs made, and the affinity coverage (papers whose best candidates are weak).

**Correctness:** the solver is **differentially tested against HotCRP's PHP implementation** and against the Lean reference solver. For random instances with no tier gadget, our min-cost-flow cost must equal `MinCostMaxFlow` run inside the harness container. Tier and repair behavior gets its own property tests:
- every paper meets its composition, or it's reported;
- no reviewer exceeds their band;
- no conflicted edge is ever used.

**Reference solver:** `model/ReviewProcess/Solver.lean` solves the same network and is the oracle: on the same instance, `core`'s flow value and cost must equal the Lean solver's. The Lean solver proves A2 and V1 by construction (`a2_plan_eligible`) and is checked against brute force on small instances.

### 10.5a Submission-screening agent

Conceptual design in [concepts.md](concepts.md) (HUSL: concepts, rules, policy, properties, examples). Implementation design in [agent.md](agent.md): checks, decision records, pluggable inference engines, clearance by data class, and the evaluation and model comparison. PLAN M8–M13.

### 10.6 Upstream HotCRP contributions (proposed as PRs, not a fork)
- An admin endpoint for the **action log**, and one for the **mail log**. Together they would make email reminders and assignment changes visible, closing the "nudges are invisible" gap in §1.
- `POST /reviews`: honor `override` for JSON bodies, not just text uploads.

---

## 11. HotCRP conventions: where each role acts

Each chair's copy of PC Supervisor derives the shared process state from HotCRP, so every action by someone other than a chair must leave a trace in HotCRP (or in the appointments sheet) that the sync can read. This table is generated from the policy table (concepts §3.9; `model/ReviewProcess/Policy.lean`): every granted cell on an action has a row. Mechanisms marked *verify* depend on HotCRP visibility settings and are confirmed on the harness in PLAN M5 before anything relies on them.

| Action (concepts §3.9) | Who | Trace in HotCRP | Read by |
|---|---|---|---|
| Keep or refer (Triage) | AC | tag on the paper, `pcs-keep` or `pcs-refer-<ground>`, as a tag only chairs and the paper's managers can see (*verify*) | sync → triage state |
| See the screening findings | AC | an admin-visibility comment rendered from the bundle, posted through Writeback (*verify* that the paper's AC sees it) | — |
| Give a second opinion | PC member | a review in a dedicated round (`screen`) whose form has one field (agree / disagree, reason). The round doesn't count toward load (S11) | sync → SecondOpinion |
| Remedy | process chair | a mail-tool notice and a `pcs-remedy-due` tag; the cure is a new PDF version | sync → Remedy |
| Remove (desk or early reject) | PC chair | the decision, applied from a Writeback decision CSV | sync → Disposition |
| Accept and classify a PC candidate | AC | the appointments sheet (Import), then PC membership and tier tags through Writeback | import → Appointment |
| Coach a junior review | AC, junior PC chair | a comment on the paper | sync |
| Send an accountability request | AC, junior PC chair | a comment on the paper visible to that reviewer (*verify*: HotCRP comments go to all of a paper's reviewers, so the request text names criteria only, never the reviewer's shortcomings), plus a per-request tag `pcs-req-<n>` | sync → AccountabilityRequest |
| Record a request's disposition | AC, junior PC chair | the tag's value, e.g. `pcs-req-3#revised` (*verify* tag values) | sync → engagement record |
| Uphold an Accountability case | PC chair | a chair-only tag `~~pcs-case-<n>` with its outcome as the value | sync → Accountability |
| Submit or revise a review, reply to a request | PC member, nominee | the review or a comment | sync |
| Fix a violation (Remedy) | author | a new submission version | sync |

The tag names are configuration (`PCS_TAG_*`), with the defaults above. A trace that doesn't parse is reported on the sync screen; it is never guessed at.

# PC Supervisor: spec

A local, single-user dashboard for a program-committee chair. It reads the HotCRP API and answers three questions during reviewing and discussion:

1. **Reviewers:** who is engaging in discussion, and who isn't?
2. **Area chairs:** who is nudging their papers along, and who isn't?
3. **Papers:** which ones are most likely in trouble and need a chair to step in?

The first deployment is a shadow PC of a few hundred papers. The design target is a large SE conference: ~2,400 papers, ~40 area chairs, ~8–10k reviews, with 2 senior PC reviews plus 1 junior or reciprocal review per paper. Moving between the two deployments must be a configuration change, not a rewrite.

> **Decided:**
> - The user is one chair, who holds a chair (sysadmin) API token.
> - Area chairs are **metareviewers** (`rtype` 5).
> - Review and comment text is **stored locally, encrypted**.
> - Every setting is an **environment variable** (§4.1).
> - CI runs a disposable HotCRP and seeds it (§9).
>
> API facts below are from HotCRP `master` @ `60f693f` (2026-10-06) and were re-checked against a running instance of that commit (`hotcrp/`). Live hosted instances may lag master, so M0 in [PLAN.md](../PLAN.md) probes the real one.

---

## 1. What the API gives us (and what it doesn't)

Auth is a bearer token: *Account settings → Developer* on a real instance, or `batch/apitoken.php` in the test harness. A chair token gives a site-admin view, and `forceShow` defaults to true.

| Need | Endpoint | Notes |
|---|---|---|
| Paper list, status, decision, tags | `GET /search?q=all&f=…&format=csv` · `GET /papers` | `f` takes display fields: `title status decision tags lead shepherd manager reviewers revstat`. The response is JSON even with `format=csv` (that only makes values plain text); empty fields are omitted, and `manager` comes back as `administrator`. The default scope `t=s` covers submitted papers only, so pass `t=all` when you need drafts and withdrawn papers. An unknown `t` silently becomes `none`. |
| Who's assigned what, by role | `GET /searchaction?action=get/pcassignments&q=all` | CSV `paper,action,email[,round][,review_token],title`. Actions are `metareview`, `primaryreview`, `secondaryreview`, `pcreview`, `externalreview`, plus a leading `clearreview` row per paper (email `#pc`, with the title). **Review assignments only**: at `60f693f` it emits no `lead`/`shepherd` rows (`ListAction::pcassignments_csv_data`), so take those from `/search` fields. **Verified.** |
| Reviews: scores, text, status, type, reviewer | `GET /reviews?q=all` | Fields: `rid pid rtype status ordinal reviewer_email version`, plus one field per review-form UID. In the default form those are `OveMer RevExp PapSum ComAut ComPC`; read the real UIDs from the instance. `rtype` 1 ext · 2 PC · 3 secondary · 4 primary · 5 metareview. `status` is empty/acknowledged/draft/delivered/approved/complete. **Verified.** |
| Review edit history | `GET /{p}/reviewhistory?r=…` | Admin-only, one review per call. **Used for backfill only** (§4). In steady state we diff our own snapshots. |
| Discussion comments | `GET /comments?q=all` | `cid pid author_email text topic visibility response draft modified_at tags by_author by_shepherd`. **Verified**, including `actas`-authored comments and `@mention` detection. |
| PC roster | `GET /pc` | Name, email, affiliation, `roles: "chair"` for chairs. **No per-user tags**: only `color_classes` (tags that have colors) and a top-level list of tag names. Tiers (junior / reciprocal) come from user tags, so M0/M3 must find another source for them (e.g. the users page's CSV, which is not an API endpoint). |
| Review-form fields | `GET /searchaction?action=get/jsonrqc&q=NONE` | `reviewform` keyed by field UID (the keys in `/reviews`), with type and score labels; `q=NONE` keeps paper content out. A download: no `ok` key, always pretty-printed. `GET /settings?filter=rf` has the same fields by internal id (`s01`, `t01`) with per-value symbols, but no UIDs. |
| Activity feed | `GET /events` | Pre-rendered HTML, 10 per page. **Don't use it.** |
| Ratings of reviews | `GET /{p}/reviewrating` | Optional quality signal (`short`, `vague`, `disrespectful` …). |

**API facts that differ from what the docs suggest (from the harness):**

- **Review `version` is an opaque version tag, not a counter.** Seen values: 269888, 455859, 157921. Detect change by inequality only, never by ordering.
- **Review `modified_at` is admin-visible, but HotCRP suppresses it when `reviewModified <= timeRequested`, which includes a review requested and submitted in the same second.** That matters for seeding (§9.3). In production, treat a missing `modified_at` as "unknown" and fall back to `first_seen_at`.
- **Comment `word_count` is null for ordinary comments.** We compute word counts ourselves.
- **A bad search query is not an error.** An unknown keyword returns `ok: true`, empty results, and a `message_list` warning (status 1). The client treats warnings on read endpoints as errors, so a typo can't look like "every review was deleted".
- **Rate limits:** by default 250 requests/minute and 5000/hour per user (`src/contactcounter.php`), reported in `x-ratelimit-*` headers; a 429 carries `Retry-After` in seconds. A `/reviewhistory` backfill of 10k reviews therefore takes over two hours.
- **`reviewer` (reviews) and `author` (comments) are HTML.** Use `reviewer_email` / `author_email`.
- **`/reviewhistory` deltas (`object: "review_delta"`) have no `modified_at`**, and text fields may appear as `<UID>:p` patches.
- **`POST /reviews` ignores `override=1` for JSON bodies**; only text-form uploads honor it. The seeder works around this by opening review deadlines in settings. This may be worth an upstream issue.

**Gaps that shape the design:**

- **Comments have no creation timestamp.** We only get `modified_at`, and an edit overwrites it. The sync therefore **snapshots**: it records `first_seen_at` for every `cid` and `rid`, and timestamped metrics use the earliest time observed. Items that already existed at the first sync take `modified_at` as a best guess, and the UI marks them as approximate.
- **No action log or mail log via the API.** Reminder emails sent through HotCRP's Mail tool, assignment changes, and logins are all invisible. A "nudge" is therefore defined as **activity inside HotCRP**: AC comments, `@mentions`, and tags. A scraper for the admin `/log` page is a possible later adapter.
- **No read activity.** We can see who *writes*, not who *reads*. The UI wording reflects this (§7).
- **CORS / token handling.** The bearer token stays in the local server process and never reaches the browser.

---

## 2. Design choices

| Axis | Choice |
|---|---|
| Data freshness | Periodic full sync (`PCS_SYNC_INTERVAL_MIN`, default 15) plus a manual "sync now". Live calls can't give us history. |
| Store | SQLite (SQLCipher), one file per instance. |
| Read vs. write | **Read-only through v0.** v1 adds copyable searches, drafted nudges, and dry-run-previewed tagging (§6). |
| Users | One user. The server binds to `127.0.0.1` and has no auth layer. |
| Metric style | Rules that fire with a human-readable reason, rolled into a ranked attention list. No single opaque score. |
| People views | An outlier list plus per-person drill-down. **No leaderboards.** |
| Phase awareness | Thresholds depend on the current phase, which comes from the phase-date env vars and the clock. |
| LLMs | None. Review text must not leave the machine. Use text heuristics only. |

---

## 3. Data model (local)

```
person(email PK, name, roles[], tags[], tier)          -- /pc; tier from tag mapping
paper(pid PK, title, status, decision, tags[], synced_at)
assignment(pid, email, role)                           -- get/pcassignments
review(rid PK, pid, email, rtype, status, round, ordinal, vtag,
       modified_at NULL, first_seen_at, first_complete_seen_at,
       scores JSON, word_count)
review_version(rid, vtag, seen_at, source, scores JSON, status) -- source: snapshot|history
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

---

## 4. Architecture

```
HotCRP ◄── bearer token ── server (Node/TS: sync + JSON API, SQLite) ◄── localhost ── web (React/Vite)
```

- **Sync** makes a handful of bulk calls per run: `/pc`, `get/pcassignments`, `/search` with fields, `/reviews`, and `/comments`. Reviews and comments are fetched in **pid-range chunks** (`PCS_SYNC_CHUNK`, default 200), as `POST …?:method:=GET`, with bounded concurrency (`PCS_SYNC_CONCURRENCY`, default 2) and backoff on 429/5xx. Every run is a full fetch, diffed locally.
- **`pcs probe` (M0)** makes the same reads once, plus one `/reviewhistory` and `/reviewrating` sample, and prints a shape report: keys and types with presence counts, counts by status/type, form fields with declared and observed score ranges, user-tag names, Zod pass/fail per endpoint (drift is reported, not thrown), and rate-limit headers. It is the one command the chair runs against the real instance, so it skips the harness guard but is GET-only (a fetch wrapper refuses anything but GET and POST-as-GET), and it prints no content: the renderers receive only counts and sanitized config strings (`server/src/probe/safe.ts`), and a unit test feeds it sentinel names, emails, titles, and text and checks none come out. `--markdown` gives an issue-ready version and `--json` a machine-readable one.
- **`/reviewhistory` is a one-time background backfill** at `PCS_HISTORY_RPS` (default 1). After that, snapshots capture changes at sync resolution.
- **Clock injection:** all phase logic reads `now` from one function. `PCS_NOW` (ISO timestamp) pins it, for tests and for replaying a past state.
- **Metrics** are SQL views plus a TS rules module evaluated at read time, so changing a threshold env var and restarting re-ranks everything. Indexes go on `pid` and `email`.
- **UI:** React + Vite + TanStack Table/Query, with virtualized tables (2,400 rows must stay smooth). Every row deep-links into HotCRP: `/paper/{pid}`, `/review/{pid}{ordinal}`, `/search?q=…`.

### 4.1 Configuration (environment only)

There's no config file. `.env.example` is the full, documented list. Startup validates the env with a schema and refuses to run on missing or invalid values, printing every problem at once.

| Variable | Meaning | Default |
|---|---|---|
| `PCS_HOTCRP_URL` | Instance base URL, e.g. `https://conf2027-shadow.hotcrp.com` | required |
| `PCS_HOTCRP_TOKEN` | Chair API token | required |
| `PCS_TZ` | Time zone for phase dates and display | `America/New_York` |
| `PCS_PHASE_REVIEW_DUE` | Review deadline (ISO date/time) | required |
| `PCS_PHASE_DISCUSSION_OPEN` | Discussion opens | required |
| `PCS_PHASE_DISCUSSION_CLOSE` | Discussion closes | required |
| `PCS_PHASE_DECISIONS_DUE` | Decisions due | required |
| `PCS_PHASE_RESPONSE_OPEN` / `_CLOSE` | Author-response window | optional |
| `PCS_NOW` | Pin the clock | unset = real time |
| `PCS_AC_ROLE` | `meta` \| `lead` \| `manager` \| `tag:<t>` | `meta` |
| `PCS_TIER_TAGS` | e.g. `junior=junior,reciprocal=reciprocal`; untagged reviewers = senior | empty |
| `PCS_FIELD_MERIT` / `PCS_FIELD_EXPERTISE` | Review-form UIDs | `OveMer` / `RevExp` |
| `PCS_MERIT_ACCEPT_MIN` | Lowest merit value on the accept side | `3` |
| `PCS_EXPERTISE_OK_MIN` | Lowest "knowledgeable" expertise value | `3` |
| `PCS_REVIEWS_REQUIRED` | Complete reviews needed per paper | `3` |
| `PCS_RULE_<NAME>_WEIGHT`, `PCS_THRESH_<NAME>` | Rule weights and thresholds (§5c) | see code |
| `PCS_DB_PATH` | SQLite file | `~/.local/share/pc-supervisor/<host>.db` |
| `PCS_DB_KEY` | SQLCipher key (or read from keychain) | required outside tests |
| `PCS_SYNC_INTERVAL_MIN`, `PCS_SYNC_CHUNK`, `PCS_SYNC_CONCURRENCY`, `PCS_HISTORY_RPS` | Sync tuning | 15 / 200 / 2 / 1 |
| `PCS_FORCE_SHOW` | `false` = respect the chair's own conflicts | `true` |
| `PCS_PORT` | Local server port | `5317` |

---

## 5. Metrics and rules

Windows are relative to the phase-date env vars. Every threshold has an env override.

### 5a. Reviewer engagement (per person)

| Signal | Definition |
|---|---|
| Outstanding / late | Assigned reviews not complete (or delivered) after `REVIEW_DUE`. |
| Review depth | Word count vs. the PC median. Flag the bottom decile and reviews rated `short`/`vague`. |
| Discussion participation | Share of their in-discussion papers where they've commented since `DISCUSSION_OPEN`. |
| Responsiveness | After an `@mention`, or an AC comment on their paper: the median time to their next comment there. Unanswered pings older than `PCS_THRESH_PING_DAYS` are listed. |
| Movement | Score/expertise changes after `DISCUSSION_OPEN` (from `review_version`). |
| Silent on split papers | Their "split" papers (§5c) with no comment from them. **This is the most actionable reviewer flag.** |

The view is an outlier list plus a person page (every paper, their score, their last comment, open pings).

Precise definitions are in the header of `server/src/rules/reviewer-metrics.ts`. Notable choices: a ping is an `@mention` of the reviewer or any AC comment on their paper; pings that arrive before the reviewer replies merge into one episode. "Bottom decile" means strictly below the PC's 10th-percentile word count. Outlier lists use absolute bars (≥ 1 silent split paper, ≥ 1 unanswered ping, ≥ 1 late review, ≥ 1 thin/flagged review), never a rank cutoff, and are grouped by tier.

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

Precise definitions are in the header of `server/src/rules/ac-metrics.ts`. Coverage and time to first post count only comments at or after `DISCUSSION_OPEN`. The sparkline buckets the AC's comments per 24 h from `DISCUSSION_OPEN`.

### 5c. Paper risk

Each rule fires with a reason string. Severity is the sum of weights. Sort by severity, then by time to `DECISIONS_DUE`.

| Rule (`NAME`) | Fires when | Default weight |
|---|---|---|
| `MISSING_REVIEWS` | complete < `PCS_REVIEWS_REQUIRED` after `REVIEW_DUE` | 3 |
| `SPLIT` | merit range ≥ `PCS_THRESH_SPLIT_RANGE` (2), or there are scores on both sides of `MERIT_ACCEPT_MIN` | 3 |
| `UNRESOLVED_SPLIT` | split, no movement since `DISCUSSION_OPEN`, discussion older than `PCS_THRESH_UNRESOLVED_DAYS` | +2 |
| `SILENT_DISCUSSION` | in discussion, 0 comments since `DISCUSSION_OPEN` | 3 |
| `GONE_QUIET` | last activity older than `PCS_THRESH_STALE_DAYS`, no decision | 2 |
| `AC_ABSENT` | no AC comment since `DISCUSSION_OPEN` | 2 |
| `CHAMPION_MISSING` | the top merit is ≥ `MERIT_ACCEPT_MIN`, and no reviewer holding it has commented since `DISCUSSION_OPEN` | 1 |
| `LOW_EXPERTISE` | no review with expertise ≥ `EXPERTISE_OK_MIN` | 2 |
| `THIN_REVIEWS` | a review under `PCS_THRESH_MIN_WORDS`, or rated short/vague | 1 |
| `RESPONSE_UNADDRESSED` | an author response exists, with no reviewer comment after it | 2 |
| `DEADLINE_NO_CONSENSUS` | < `PCS_THRESH_DEADLINE_DAYS` (3) to `DECISIONS_DUE`, no decision, and split or silent | +3 |

Clarifications (the precise semantics, with every threshold comparison, are in the header of `server/src/rules/rules.ts`):

- "Reviewer" means a non-AC review on the paper; "complete" means status `delivered`, `approved`, or `complete`. Merits and expertise come from submitted reviewer reviews only.
- **A paper with a decision fires nothing.** Undecided means HotCRP's decision is unset/"undecided".
- Thresholds named "older than" / "under" are strict (`>` / `<`); `SPLIT_RANGE` is inclusive (`≥`).
- Phase gates: `MISSING_REVIEWS` and `LOW_EXPERTISE` only after `REVIEW_DUE`; the discussion rules (`UNRESOLVED_SPLIT`, `SILENT_DISCUSSION`, `GONE_QUIET`, `AC_ABSENT`, `CHAMPION_MISSING`, `RESPONSE_UNADDRESSED`) only once `DISCUSSION_OPEN` has passed; `SPLIT` and `THIN_REVIEWS` in any phase.
- "Comments" are published (non-draft) comments; author responses are not comments for `SILENT_DISCUSSION`, and not activity for `GONE_QUIET`.
- **Movement** is a merit change between consecutive observed versions where the later one was seen at or after `DISCUSSION_OPEN`.
- **Last activity** is the latest review `modified_at` (falling back to `first_complete_seen_at`), AC reviews included, or published non-response comment, AC comments included. `GONE_QUIET` measures quiet time from `max(last activity, DISCUSSION_OPEN)`.
- `RESPONSE_UNADDRESSED` looks for a reviewer comment strictly after the **latest** response.
- `DEADLINE_NO_CONSENSUS` keeps firing once `DECISIONS_DUE` has passed; "silent" means the `SILENT_DISCUSSION` condition.
- With one global `DECISIONS_DUE`, the secondary sort key ties for every paper, so ties fall through to pid.

Views:

- **Triage list:** pid, title, AC, scores, reason chips, last activity, and a link.
- **Paper drawer:** a timeline of reviews, score changes, comments (author, word count, mentions), and the response.
- **Overview:** counts by phase, a score-spread histogram, flagged papers per AC, and a **burndown of papers without consensus** against the phase dates.

### 5d. Shadow-PC extras

- **Review-quality view for coaching:** depth, rating flags, specificity.
- (Later, optional) Compare shadow outcomes with real outcomes, if they become available.

---

## 6. Actions (v1)

These are human-in-the-loop only; the app never sends email.

- **Copy a HotCRP search** for any flag set, to paste into the Mail tool.
- **Draft a nudge comment** with the reason text filled in.
- **Tag** flagged papers `#chair-attention` via `POST /assigntags`, behind a `dry_run=1` preview and a confirm step. This is the first write path, and it's E2E-tested against the harness, never against a live instance.

---

## 7. Confidentiality and tone

- **Local only.** There's no hosted mode and no telemetry. The only outbound calls go to `PCS_HOTCRP_URL`.
- **The DB is the most sensitive artifact** (every review and comment, plus reviewer identities).
  - Encrypt it with SQLCipher (`better-sqlite3-multiple-ciphers`).
  - The default path is outside the repo and outside any synced folder.
  - `pcs wipe` deletes it.
  - The repo holds **synthetic data only**. No real review text, names, or emails ever go into fixtures, tests, issues, or screenshots.
- **No LLM over review text.**
- **Wording:** "no comments yet", not "disengaged"; "no in-HotCRP activity", not "absent".
- **Conflicts:** `PCS_FORCE_SHOW=false` hides papers the chair is conflicted with.

---

## 8. Milestones

See [PLAN.md](../PLAN.md).

---

## 9. Testing

### 9.1 Layers

| Layer | What it covers | Where it runs |
|---|---|---|
| Unit | Rules, metrics, the mention parser, env validation, snapshot diffing. Uses in-memory SQLite and fixed `PCS_NOW`. | Every push |
| API contract | Zod schemas for every HotCRP response we consume, checked against the seeded harness. This catches drift when `HOTCRP_REF` is bumped. | Every push; nightly against HotCRP `master` |
| Integration | Seed scenario → sync → assert DB state. Multi-stage scenarios: seed stage 1, sync, mutate, advance `PCS_NOW`, sync, assert diffs. | Every push |
| E2E (Playwright) | Seed → sync → server + built UI. Assert the triage ranking, reason chips, AC table, person page, drawer timeline, and (v1) the tagging dry run. | Every push |
| Visual (Argos) | `argosScreenshot` at fixed states of the golden scenario: triage list, paper drawer, AC table, person page, overview. `PCS_NOW` is pinned, and relative-time text and sync timestamps are masked. Uploads come from CI only, through the Argos GitHub App (tokenless), and they show **synthetic harness data only**. | Every push (Argos diffs PRs against `main`) |
| Scale | The `scale` scenario (2,400 papers, 40 ACs, ~10k reviews). Assert sync time and UI interaction budgets. | Nightly / manual |

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

## 10. Large-conference modules (post-MVP, PLAN M9+)

These modules target a large conference with tiered reviewing:
- **2 senior PC reviews + 1 junior-PC or reserve review** per paper (a 4th is possible);
- **TPMS-only assignment** (no bidding);
- **reserve ("reciprocal") reviewers**: each submission designates a senior author, who is activated only on shortfall and approved by the paper's AC;
- a **quick-reject** phase;
- an **early-reject** phase.

The tool stays read-only and chair-only. HotCRP remains the system of record. Where action is needed, the tool **generates HotCRP-native artifacts** (assignment CSVs, tag sets, mail-tool searches) for a chair to apply through HotCRP, dry-run first.

### 10.1 Extended phase model

Each phase date is an env var:

`PCS_PHASE_REGISTRATION_DUE`, `PCS_PHASE_SUBMISSION_DUE`, `PCS_PHASE_QUICKREJECT_DUE`, `PCS_PHASE_ASSIGNMENT_DONE`, `PCS_PHASE_REVIEW_DUE`, `PCS_PHASE_EARLYREJECT_OPEN`, `PCS_PHASE_EARLYREJECT_CLOSE`, `PCS_PHASE_RESPONSE_OPEN/_CLOSE`, `PCS_PHASE_DISCUSSION_OPEN/_CLOSE`, `PCS_PHASE_DECISIONS_DUE`.

The modules activate by phase. Single-cycle only for now; a two-cycle conference would duplicate this set per cycle and still needs design.

### 10.2 Tiers

There are four tiers: `senior`, `junior`, `reserve-pool` (designated but not activated), and `reserve-active`. They come from PC user tags (`PCS_TIER_TAGS`). Activated reserve reviewers are **added to the PC**, not requested as external reviewers, because HotCRP can't change an external reviewer's round without a new request.

### 10.3 Imported data (local files, `pcs import <kind> <file>`)

| Kind | Content | Keyed by |
|---|---|---|
| `invites` | The reserve-reviewer invitation sheet (CSV export). Columns: `pid, candidate_email, tpms_score, seniority_note, ac_email, ac_decision (approve/reject/pending), invited_at, response (accept/decline/none), activated_at`. **This sheet is the source of truth for AC approval and invitations; the tool never edits it.** | pid + email |
| `tpms-assignments` | TPMS's assignment output CSV | pid + email |
| `tpms-registrations` | TPMS reviewer registration status (registered with HotCRP email; number of papers uploaded), if TPMS provides it | email |
| `refcheck` | Output of an external reference checker (hallucinated references, no in-field references) | pid |
| `do-not-invite` | The chair-to-chair do-not-invite list, stored encrypted alongside the DB | email |

Imports are versioned like snapshots, so "what did the sheet say on day X" is answerable.

### 10.4 Modules

**A. Reserve-reviewer compliance** (around the registration and submission deadlines)
- Per paper: is a designee present, or is there a valid exemption claim? Exemption reasons are an enumerated, configurable set.
- Per person: is the designee identical across every paper that names them? How many papers do they cover? Coverage does not scale their obligation; it's flagged against `PCS_RESERVE_MAX_COVER`.
- Seniority and exemption evidence: self-declared fields, plus an **optional DBLP lookup** that counts papers at a configurable venue list. The lookup sends only public author names, never submission content. It's a hint for a human, never a verdict.
- TPMS registration status, if it's imported.
- Output: a non-compliance list with evidence, plus drafted mail-tool searches for warnings.

**B. Quick-reject / desk-reject tracker**
- A queue of `paper → signals (refcheck, AC flag, quick-reject review verdict) → AC decision → chair action → appeal status`.
- Quick-reject reviews are a dedicated review round, tracked against `QUICKREJECT_DUE`.
- Evidence is stored with each item. An appeal state is required.

**C. Assignment validator** (the highest-value module)
- **Composition** per paper, from the policy env vars: `PCS_POLICY_MIN_SENIOR` (2) and `PCS_POLICY_THIRD_SLOT` (`exactly1`|`atleast1`). Flag papers with all-junior panels, a missing senior, or a missing third slot.
- **Load bands per tier:** `PCS_LOAD_<TIER>_MIN/_MAX`.
- **Conflict sanity:** same affiliation, DBLP co-authorship (optional), and **reciprocal cycles**. Because reserve reviewers are authors, detect 2-cycles (and short k-cycles, `PCS_CYCLE_MAX_K`) in the graph whose edges run from an author of paper P to a reviewer of paper P. These are surfaced for human review, never auto-acted on.
- **TPMS round-trip:** validate an imported TPMS assignment CSV *before* it reaches HotCRP; emit a corrected HotCRP assignment CSV (seniors first, then the third slot).
- Reserve candidates must be AC-approved in the `invites` import and absent from `do-not-invite` before they appear in any generated assignment.

**D. Reviewing progress, by tier**
- Outstanding and late reviews by tier, with a dedicated **reserve dropout** view and its escalation state.
- **Reserve accountability:** each reserve reviewer's own submissions, shown next to their review performance (late, thin, rated). This is evidence for a human decision about consequences, not an automated decision.
- **Coaching queue:** junior reviews below the depth floor or rated short/vague, linked into HotCRP, where the coaching itself happens (as comments). The tool only reads this.
- *(If the policy is adopted)* `PCS_POLICY_WITHHOLD_REVIEWS`: list the authors whose own papers' reviews would be withheld because their reserve reviews are outstanding, and draft the HotCRP-side change.

**E. Early reject**
- Candidates under `PCS_POLICY_EARLYREJECT` (`reject_only`|`include_weak_reject`), each shown with its discussion signals.
- A drafted mail-tool search for "re-read and bump within N hours" (`PCS_EARLYREJECT_WINDOW_H`, default 48).
- Window tracking from snapshots: at close, list the candidates that were bumped, those that weren't, and the reviewers who never responded.

**F. Discussion and decisions:** §5, plus tier-aware participation (do junior reviewers comment?).

**G. Process report** (after the conference)
- Junior vs. senior depth, timeliness, rating distributions, and score agreement.
- Reserve activation and dropout rates; early-reject yield; quick/desk-reject counts and appeals.
- A carry-forward export of the do-not-invite list.
- **Pseudonymous IDs** (a keyed HMAC of the email, with a chair-held key, `PCS_PSEUDONYM_KEY`) on every exported row, so the data could join a future cross-conference baseline without exposing identities.

### 10.5 Upstream HotCRP contributions (proposed as PRs, not a fork)
- An admin endpoint for the **action log**, and one for the **mail log**. Together they would make email reminders and assignment changes visible, closing the "nudges are invisible" gap in §1.
- `POST /reviews`: honor `override` for JSON bodies, not just text uploads.

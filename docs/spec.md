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
| Paper list, status, decision, tags | `GET /search?q=all&f=…&format=csv` · `GET /papers` | `f` takes display fields: `title status decision tags lead shepherd manager reviewers revstat`. The default scope `t=s` covers submitted papers only, so pass `t=all` when you need drafts and withdrawn papers. |
| Who's assigned what, by role | `GET /searchaction?action=get/pcassignments&q=all` | CSV `paper,action,email,title`. Actions are `metareview`, `primaryreview`, `secondaryreview`, `pcreview`, `lead`, `shepherd`, plus a leading `clearreview` row per paper. **Verified.** |
| Reviews: scores, text, status, type, reviewer | `GET /reviews?q=all` | Fields: `rid pid rtype status ordinal reviewer_email version`, plus one field per review-form UID. In the default form those are `OveMer RevExp PapSum ComAut ComPC`; read the real UIDs from the instance. `rtype` 1 ext · 2 PC · 3 secondary · 4 primary · 5 metareview. `status` is empty/acknowledged/draft/delivered/approved/complete. **Verified.** |
| Review edit history | `GET /{p}/reviewhistory?r=…` | Admin-only, one review per call. **Used for backfill only** (§4). In steady state we diff our own snapshots. |
| Discussion comments | `GET /comments?q=all` | `cid pid author_email text topic visibility response draft modified_at tags by_author by_shepherd`. **Verified**, including `actas`-authored comments and `@mention` detection. |
| PC roster + user tags | `GET /pc` | Roles and visible user tags. Tiers (junior / reciprocal) come from user tags. |
| Activity feed | `GET /events` | Pre-rendered HTML, 10 per page. **Don't use it.** |
| Ratings of reviews | `GET /{p}/reviewrating` | Optional quality signal (`short`, `vague`, `disrespectful` …). |

**API facts that differ from what the docs suggest (from the harness):**

- **Review `version` is an opaque version tag, not a counter.** Seen values: 269888, 455859, 157921. Detect change by inequality only, never by ordering.
- **Review `modified_at` is admin-visible, but HotCRP suppresses it when `reviewModified <= timeRequested`, which includes a review requested and submitted in the same second.** That matters for seeding (§9.3). In production, treat a missing `modified_at` as "unknown" and fall back to `first_seen_at`.
- **Comment `word_count` is null for ordinary comments.** We compute word counts ourselves.
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

Each rule fires with a reason string. Severity is the sum of weights. Sort by severity, then by time to `DECISIONS_DUE`.

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
| `THIN_REVIEWS` | a review under `PCS_THRESH_MIN_WORDS`, or rated short/vague | 1 |
| `RESPONSE_UNADDRESSED` | an author response exists, with no reviewer comment after it | 2 |
| `DEADLINE_NO_CONSENSUS` | < `PCS_THRESH_DEADLINE_DAYS` (3) to `DECISIONS_DUE`, no decision, and split or silent | +3 |

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

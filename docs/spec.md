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
| Lead / shepherd emails | `GET /searchaction?action=get/lead` (`get/shepherd`) `&q=all&t=all` | CSV `paper,title,given_name,family_name,leademail` (`shepherdemail`), one row per paper that has one. Needed because `/search`'s `lead`/`shepherd`/`manager` fields are **display names**, not emails. There is no list action for managers, so the sync resolves the `administrator` name against the roster. **Verified (M3).** |
| Reviews: scores, text, status, type, reviewer | `GET /reviews?q=all` | Fields: `rid pid rtype status ordinal reviewer_email version`, plus one field per review-form UID. In the default form those are `OveMer RevExp PapSum ComAut ComPC`; read the real UIDs from the instance. `rtype` 1 ext · 2 PC · 3 secondary · 4 primary · 5 metareview. `status` is empty/acknowledged/draft/delivered/approved/complete. **Verified.** |
| Review edit history | `GET /{p}/reviewhistory?r=…&expand=1` | Admin-only, one review per call. **Used for backfill only** (§4). In steady state we diff our own snapshots. With `expand=1`, every older version is a full `review` object with its own `modified_at`, so the backfill avoids `review_delta` patches. **Verified (M3).** |
| Discussion comments | `GET /comments?q=all` | `cid pid author_email text topic visibility response draft modified_at tags by_author by_shepherd`. **Verified**, including `actas`-authored comments and `@mention` detection. |
| PC roster | `GET /pc` | Name, email, affiliation, `roles: "chair"` for chairs. **No per-user tags**: only `color_classes` (tags that have colors) and a top-level list of tag names. The users page's `pcinfo` CSV has tags, but pages ignore bearer tokens (API only). |
| Who holds a user tag (tiers) | `GET /reviews?q=<pids>&rq=re:%23<tag>` | `rq` is a per-review search; `re:#tag` keeps reviews written by holders of user tag `<tag>`. The sync runs one such query per tier tag (in pid chunks) and keeps only the reviewer emails. PC members with no reviews at all aren't seen this way. A tag nobody holds yields a warning (*User tag … not found*), so only query tags listed in `/pc`'s `tags`. **Verified (M3).** |
| Review-form fields | `GET /searchaction?action=get/jsonrqc&q=NONE` | `reviewform` keyed by field UID (the keys in `/reviews`), with type and score labels; `q=NONE` keeps paper content out. A download: no `ok` key, always pretty-printed. `GET /settings?filter=rf` has the same fields by internal id (`s01`, `t01`) with per-value symbols, but no UIDs. |
| Authors, submission options (M10) | `GET /papers?q=…&t=all&forceShow=1` | One `paper` object per paper: `authors` (`email given_name family_name affiliation`) and every submission option under its **name** (e.g. `"Reserve designee": "x@…"`; dropdown = choice name). Also carries the abstract and document metadata, which the sync drops unread. For a blind submission even a chair gets **no `authors` without `forceShow=1`**. **Verified (M10).** |
| Submission-option definitions | `GET /settings?filter=sf` | `sf` list; configured options have numeric `id`s (intrinsic fields have string ids like `title`), `type`, and dropdown `values`. **Verified (M10).** |
| Assignment dry run (M10) | `POST /assign?dry_run=1&forceShow=0&format=json` | Body: a JSON array of row objects with the CSV columns (`paper action user`). Returns `valid`, `assignment_count`, and the `assignments` HotCRP *would* make; nothing changes. An invalid set is **HTTP 403** with `ok: false`, `valid: false`, and the error messages. `forceShow=0` keeps conflicts enforced (`1` overrides them). **Verified (M10).** |
| Tag changes (v1, the only write) | `POST /assign?dry_run=1&format=json` with a JSON body `[{pid, action: "tag"\|"cleartag", tag}]`, then the same without `dry_run` | **Not `POST /assigntags`**: at `60f693f` `Tags_API::assigntags` (`src/api/api_tags.php`) only adds tags and executes at once, with no `dry_run`. `Assign_API::assign` (`src/api/api_assign.php`) runs the same `AssignmentSet` and honors `dry_run=1`; with `format=json` it lists exactly the rows that would change state (a `tag` on a paper that already has the tag, or a `cleartag` on one that doesn't, is omitted), so that list is the preview diff. An unknown pid (*Submission #N does not exist*) or an empty list (*Empty file*) is HTTP 403 with `ok: false`; the tag client treats that as an error. **Verified (M8).** |
| Activity feed | `GET /events` | Pre-rendered HTML, 10 per page. **Don't use it.** |
| Ratings of reviews | `GET /{p}/reviewrating` | Optional quality signal (`short`, `vague`, `disrespectful` …). No per-review calls are needed: `/reviews` already carries `ratings` (one name or a list) on every rated review. **Verified (M3).** |

**API facts that differ from what the docs suggest (from the harness):**

- **Review `version` is an opaque version tag, not a counter.** Seen values: 269888, 455859, 157921. Detect change by inequality only, never by ordering.
- **Review `modified_at` is admin-visible, but HotCRP suppresses it when `reviewModified <= timeRequested`, which includes a review requested and submitted in the same second.** That matters for seeding (§9.3). In production, treat a missing `modified_at` as "unknown" and fall back to `first_seen_at`.
- **Comment `word_count` is null for ordinary comments.** We compute word counts ourselves.
- **A bad search query is not an error.** An unknown keyword returns `ok: true`, empty results, and a `message_list` warning (status 1). The client treats warnings on read endpoints as errors, so a typo can't look like "every review was deleted".
- **Rate limits:** by default 250 requests/minute and 5000/hour per user (`src/contactcounter.php`), reported in `x-ratelimit-*` headers; a 429 carries `Retry-After` in seconds. A `/reviewhistory` backfill of 10k reviews therefore takes over two hours.
- **`reviewer` (reviews) and `author` (comments) are HTML.** Use `reviewer_email` / `author_email`.
- **`/reviewhistory` deltas (`object: "review_delta"`) have no `modified_at`**, and text fields may appear as `<UID>:p` patches.
- **`POST /reviews` ignores `override=1` for JSON bodies**; only text-form uploads honor it. The seeder works around this by opening review deadlines in settings. This may be worth an upstream issue.
- **HotCRP can't see the request `Content-Type` under Apache mod_php** (`Qrequest::header()` reads `HTTP_CONTENT_TYPE`, which mod_php doesn't set). Endpoints that branch on it fall back to sniffing: a body starting with `[`/`{` is JSON; anything else is unknown. `POST /assign` with a CSV or form body therefore prints PHP warnings ahead of its JSON on the harness, so the client sends assignments as a JSON body (M10's dry runs and M8's tag writes). (Found in M10, again in M8.)
- **After truncating `PaperStorage`, re-insert row 1** (the "empty document", `src/schema.sql`). Otherwise the first PDF stored gets id 1, and that paper silently stays a draft. `seed reset` does this since M10.

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
| Read vs. write | **Read-only through v0.** v1 adds copyable searches, drafted nudges, and dry-run-previewed tagging (§6); tagging is the only write. |
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
- The implemented schema adds to the sketch above: lead/shepherd/manager, review ratings, review-form fields, `*_approx` flags, `deleted_seen_at`/`removed_seen_at` on reviews, assignments, papers, and people, and `paper.decision_seen_at` (when the sync first saw the current decision; HotCRP has no decision timestamp, so a decision already present at the first sync gets that sync's time, flagged approximate). See [server/src/store/README.md](../server/src/store/README.md).

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
- **UI:** React + Vite + TanStack Table/Query, with virtualized tables (2,400 rows must stay smooth). Every row deep-links into HotCRP: `/paper/{pid}`, `/review/{pid}{ordinal}` (unsubmitted reviews have no ordinal: `/review?p={pid}&r={rid}`), `/search?q=…`.
- **Server (M5, `server/src/server/`):** `pcs serve [--watch]` runs Fastify on `127.0.0.1:PCS_PORT` and serves `web/dist` with an SPA fallback. Routes: `GET /api/meta` (phase, now, pinned, HotCRP base URL, rule weights, tiers), `GET /api/triage?ac=&rule=&tier=` (every paper in triage order with reasons, AC, merits, tier mix, last activity, plus facet counts), `GET /api/papers/:pid` (the drawer: reviews with versions and text, comments with author, word count, mentions and text, one merged timeline), `GET /api/sync/status`, `POST /api/sync` (202, or 409 while a sync runs; one at a time per process). Requests whose `Host` isn't a loopback name get 421 (DNS rebinding); every response carries a CSP that allows only `'self'`; sync errors are redacted; a unit test checks no body or header contains the token. M6 adds `/api/acs`, `/api/reviewers`, `/api/people/:email`, `/api/overview` to the same route list; M8 adds `/api/actions`, `/api/papers/:pid/nudge`, `POST /api/tags/preview`, and `POST /api/tags/commit` (§6).
- **Store → rules adapter (`server/src/views/snapshot.ts`):** builds the rules engine's snapshot view in six statements (papers, people, ACs, reviews, review versions, comments), each one indexed scan regardless of size, with scores extracted by `json_extract` and no text read. Version times are `coalesce(modified_at, seen_at)`; a comment's time is the earliest of `first_seen_at` and the first `modified_at` the sync saw, so an edit never moves it. The server caches the evaluated analysis per (latest sync run, clock minute).
- **Movement before the first sync needs the backfill.** The first sync sees one version per review, so score changes that happened before it are only visible after `pcs backfill`. The golden integration test and the E2E setup run sync then backfill; without the backfill golden pids 3 and 12 also fire `UNRESOLVED_SPLIT`.

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
| `PCS_PHASE_REGISTRATION_DUE`, `_SUBMISSION_DUE`, `_QUICKREJECT_DUE`, `_ASSIGNMENT_DONE`, `_EARLYREJECT_OPEN` / `_CLOSE` | Extended phase model (§10.1) | optional |
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
| `PCS_ATTENTION_TAG` | Paper tag the v1 tagging action adds/removes (no `#`) | `chair-attention` |

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

Views (M6): `/reviewers` shows the four lists, each with one group per tier (`senior` plus every `PCS_TIER_TAGS` tier, empty groups included). Each list states its bar. Entries sort by count or by name, with no rank numbers. Because any AC comment on a reviewer's paper counts as a ping, a reviewer who never comments on an AC-active paper appears under unanswered pings too (golden R-silent does). The person page `/people/:email` lists every paper the person reviews or chairs, with their review status and scores, their last comment (time, words, an excerpt on hover), the paper's fired rules, and their own flags there. It also lists their **open pings**: every open ping episode on an undecided paper, of any age, marked when it is over `PCS_THRESH_PING_DAYS`. An episode's age runs from its first ping.

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

The AC table (`/acs`, M6) lists ACs alphabetically. The load column reads "6 papers · 5 flagged", next to a bar whose length is the AC's load relative to the largest load and whose dark part is the flagged share. So a chair with many papers looks different from one whose few papers are all flagged. Nudges are labelled "(proxy)". The table also shows the AC's comment count since `DISCUSSION_OPEN`. Clicking a row opens `/?ac=<email>`.

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
  - "Counts by phase" means paper counts by stage: awaiting reviews (undecided, fewer than `PCS_REVIEWS_REQUIRED` submitted reviewer reviews), in discussion (undecided, with enough), decided, no consensus (undecided and split), and flagged (severity > 0). The configured phase dates are listed beside them.
  - The spread histogram counts papers with ≥ 2 submitted reviewer merits by range (max − min). It highlights ranges ≥ `PCS_THRESH_SPLIT_RANGE`. Splits that come only from straddling `MERIT_ACCEPT_MIN` aren't highlighted.
  - The burndown (`rules/burndown.ts`) is an inline-SVG line chart, daily from `REVIEW_DUE` to now. It shows no-consensus and all-undecided papers, with markers at every configured phase date and at now. A decision counts from when the sync first saw it.

### 5d. Shadow-PC extras

- **Review-quality view for coaching:** depth, rating flags, specificity.
- (Later, optional) Compare shadow outcomes with real outcomes, if they become available.

---

## 6. Actions (v1)

These are human-in-the-loop only; the app never sends email and never posts comments.

- **Copy a HotCRP search** for any filtered set: the triage list under any AC, rule, or tier filter, and a person page's papers. The search is the pid list with consecutive pids collapsed into ranges (`1 3 4 8-10`); HotCRP reads bare numbers and ranges as exactly that set (checked on the harness, and the E2E test runs every copied search through `/api/search`). The bar shows the search, a **Copy search** button (clipboard), and a link to `${PCS_HOTCRP_URL}/search?q=…&t=all`. The builder is `server/src/actions/search.ts`, shared with the web app.
- **Draft a nudge comment** from the paper drawer (`GET /api/papers/:pid/nudge`, `server/src/actions/nudge.ts`). The draft @mentions people by roster name, the form HotCRP's comment editor uses:
  - `MISSING_REVIEWS`: the reviewers whose reviews aren't submitted;
  - any discussion rule, or none: the submitted reviewers with no comment since `DISCUSSION_OPEN` (all of them if everyone has commented), plus the ACs if `AC_ABSENT` fired;
  - only `AC_ABSENT` / `LOW_EXPERTISE` / `THIN_REVIEWS`: the ACs.

  It lists the fired rules' reason strings verbatim ("Where things stand: …") and asks politely, in spec §7 wording. The app only copies it to the clipboard; the chair edits and posts it in HotCRP.
- **Tag papers `#PCS_ATTENTION_TAG`** (default `chair-attention`) from the triage list (the filtered set, add or remove) or the drawer (one paper). This is the only write path (AGENTS.md rule 3). It goes through `POST /assign` (§1), not `/assigntags`, because only `/assign` has a dry run.
  1. **Preview** (`POST /api/tags/preview {add, remove}`): the server runs HotCRP's dry run and returns the exact diff (papers that gain and lose the tag, plus those already as requested) and, if the diff isn't empty, a **token**: 32 random bytes, created server-side, bound to that diff, single-use, valid 5 minutes on a monotonic clock (so a pinned `PCS_NOW` can't keep it alive), at most 16 pending.
  2. **Confirm** in a modal that shows the diff; the commit button stays disabled until the tag name is typed exactly.
  3. **Commit** (`POST /api/tags/commit {token, gain, lose, confirm}`): the server consumes the token first, then rejects it if it is unknown or used (409), expired (410), or the sets differ from the preview (409), or `confirm` isn't the tag name (400). It then re-runs the dry run and refuses (409) if HotCRP changed since the preview. Only then does it write the **previewed** diff (never the request's), with the client's `allowWrites`, which nothing else in the app passes; without it `assignTags` throws `writes_disabled` before any request. Writes never retry.
  4. The server starts a re-sync so the tags show in the list (a chip on the row) and the drawer.

  Both tag routes refuse a cross-origin `Origin` header (403) on top of the loopback-`Host` check, and HotCRP errors come back redacted. The app targets the real instance at runtime because the chair uses it there; **tests never do**: the flow is E2E-tested only against the harness (`e2e/specs/tagging.spec.ts`), and the client contract test (`server/test/contract/tags.test.ts`) uses its own tag.

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
| E2E (Playwright) | Seed → sync → server + built UI. Assert the triage ranking, reason chips, AC table, person page, drawer timeline, and (v1) copy search and nudge drafts through the clipboard, and tagging: the dry run leaves HotCRP's tags unchanged, the confirmed run sets them, the re-sync shows them in the UI and the store. The tagging spec is the only one that writes, so it runs in its own Playwright project after all the others and removes the tag at the end. | Every push |
| Visual (Argos) | `argosScreenshot` at fixed states of the golden scenario: triage list, paper drawer, AC table, person page, overview. `PCS_NOW` is pinned, and relative-time text and sync timestamps are masked (class `volatile`, `data-visual-test="transparent"`). Playwright runs with `bypassCSP`, because Argos injects an inline script that the app's CSP blocks; the CSP is asserted on response headers instead. Uploads come from CI only, through the Argos GitHub App (tokenless), and they show **synthetic harness data only**. | Every push (Argos diffs PRs against `main`) |
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

**Resolved (M2): `saveusers.php` JSON keys.** JSON input goes through `CsvParser::make_json` without the CSV header synonyms, so only canonical keys work: `firstName`, `lastName`, `affiliation`, `roles`, and `tags` as **one space-separated string** (`"tags": "junior"`). `given_name`/`family_name` are silently ignored in JSON (they work only as CSV headers), and a `tags` array crashes `trim()`.

What the seeder (`seed/`, see its README) learned:

- **Seeder token.** Seeding uses its own `seeder@example.org` sysadmin token (not on the PC) with raised per-user limits (`ContactCounter.apiRefreshAmount*`; limits are per token owner, checked before `actas`). The chair token's budget stays clean for the sync. Responses also cost budget: 0.01 units per KB (`apiKbytePrice`), so a 15 MB `/reviews` read costs ~150 requests' worth.
- **Bulk writes.** `POST /reviews` and `POST /comments` take JSON arrays. Comments can span papers, one call per `actas` author. An author response is `{pid, response: "1", text}` as `actas=<author contact>`, which works for placeholder author accounts once a response round is open. Edits pass `cid`; deletes pass `cid` and `delete: true`, and the row disappears.
- **Decisions** go through `batch/assign.php` (`paper,action,decision` / `1,decision,Accepted`), or `POST /{p}/decision`. There's no API-visible decision timestamp.
- **Unassignment** is `batch/assign.php` `paper,action,user` with `clearreview`, and the review row is deleted.
- **Review history.** A score change writes a `PaperReviewHistory` row that copies the old version's `reviewModified`, so backdating the first version *before* the change gives `/reviewhistory` the earlier version at its earlier time. `version` is `reviewTime`, an opaque vtag that the warp never touches. Deltas still carry no `modified_at`.
- **Comment edits** keep `timeDisplayed`/`timeNotified` and update `timeModified`, which is what `modified_at` reports.
- **Reset.** `npm run seed -- reset` truncates content tables and deletes non-sysadmin accounts, so tests can re-seed in about a second without rebuilding the harness.
- **Timing.** `scale` (2,400 papers, 9,600 review rows, 6,594 comments, 1,068 responses) seeds in 2 min 0 s on a 9-core dev machine: papers 35 s, reviews and comments 60 s, everything else under 20 s. `seed verify scale` takes 67 s. `golden` seeds in about 9 s.

Scenarios to ship:

- **`golden`**: 12 papers, each built to fire an exact rule set (plus a clean control). The expected reasons live beside the scenario (`seed/scenarios/golden/expected.ts`). This is the E2E oracle.
- **`multistage`**: 3 papers in two stages (score change, new/edited/deleted comment, unassigned review in stage 2), for the M3 snapshot-diff test. `seed/README.md` lists both stages exactly.
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

**Implemented (M9).** The six new dates are optional, so the MVP runs without them. Startup checks that the configured ones are in this order and reports every violation at once: `REGISTRATION_DUE ≤ SUBMISSION_DUE ≤ QUICKREJECT_DUE ≤ ASSIGNMENT_DONE ≤ REVIEW_DUE ≤ EARLYREJECT_OPEN ≤ EARLYREJECT_CLOSE ≤ RESPONSE_OPEN` (if set) `≤ DISCUSSION_OPEN`. Unset dates are skipped. Only pairs that involve a new date are checked, so MVP validation doesn't change. `EARLYREJECT_OPEN`/`_CLOSE`: set both or neither.

`phaseAt()` (M4) stays the MVP model. `extendedPhaseAt()` (`server/src/rules/phase.ts`) refines it only where a new date is configured; with none configured, the two return the same phase. As with the MVP phases, a deadline instant belongs to the phase it ends:

| Phase | Interval |
|---|---|
| `registration` | `now ≤ REGISTRATION_DUE` |
| `submission` | previous set deadline `< now ≤ SUBMISSION_DUE` |
| `quick-reject` | `… < now ≤ QUICKREJECT_DUE` |
| `assignment` | `… < now ≤ ASSIGNMENT_DONE` |
| `before-review-due` | `… < now ≤ REVIEW_DUE` |
| `early-reject` | `EARLYREJECT_OPEN ≤ now ≤ EARLYREJECT_CLOSE` (replaces `reviewing-late` there) |
| `reviewing-late`, `response`, `discussion`, `decisions`, `after-decisions` | as in `phaseAt()` |

Each pre-review phase starts at the previous *configured* deadline, so leaving a date unset removes its phase. For example, with only `SUBMISSION_DUE` set, everything before it is `submission`.

`activeModules(phase)` gives the §10.4 modules for a phase. The spec leaves the exact spans open, so these are the M9 choices (`MODULE_PHASES`; change the table to change them):

| Module | Active in |
|---|---|
| A reserve compliance | registration, submission, quick-reject (follow-up of warnings) |
| B quick-reject tracker | quick-reject, assignment (appeal tail) |
| C assignment validator | assignment, before-review-due, reviewing-late, early-reject (reserve activations add assignments) |
| D reviewing by tier | before-review-due, reviewing-late, early-reject, response |
| E early reject | early-reject (the close report is computed at the close instant, which is inside the window) |
| F discussion and decisions | response, discussion, decisions |
| G process report | after-decisions |

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

**Implemented (M9): `server/src/imports/`, migration 2, `pcs import`.**

*File format.* Files must be UTF-8 CSV (RFC 4180, with an optional BOM) and need a header row. Headers are matched case-insensitively after trimming, with runs of spaces or hyphens read as `_`, so `Candidate Email` matches `candidate_email`. Each column also accepts the aliases listed below. Column order doesn't matter, and unrecognized columns are ignored (their count is reported). An empty cell means unset. Emails are lowercased and must look like `x@y.z`. Dates can be `YYYY-MM-DD` (midnight) or `YYYY-MM-DD[T ]HH:MM[:SS]`, in `PCS_TZ` unless they carry `Z` or an offset, and are stored as epoch seconds. Enum values are case-insensitive. Within one file, a key may appear only once (checked after lowercasing).

There's no public spec for the TPMS formats. The TPMS kinds therefore use a minimal documented column set plus aliases for likely header names. No `PCS_*` mapping variable was needed; if a real export uses other headers, rename them or add an alias in `kinds.ts`.

| Kind | Key | Columns (`*` = required; aliases in parentheses) |
|---|---|---|
| `invites` | pid + candidate_email | `pid`\* integer ≥ 1 (paper, paper_id, paperid, submission, submission_id); `candidate_email`\* (email, candidate); `tpms_score` number (score); `seniority_note` text (seniority); `ac_email` email (ac); `ac_decision` `approve`\|`reject`\|`pending`, empty = `pending`; `invited_at` date; `response` `accept`\|`decline`\|`none`, empty = `none`; `activated_at` date |
| `tpms-assignments` | pid + email | `pid`\* (as above); `email`\* (reviewer, reviewer_email); `score` number (tpms_score, affinity) |
| `tpms-registrations` | email | `email`\* (reviewer, reviewer_email): the HotCRP email the reviewer registered with; `registered`\* `yes`/`no`, `true`/`false`, `1`/`0`, `y`/`n`; `papers_uploaded` integer ≥ 0 (papers, num_papers) |
| `refcheck` | pid | `pid`\* (as above); `total_refs` integer ≥ 0 (refs, references); `hallucinated_refs`\* integer ≥ 0 (hallucinated, unresolved_refs); `in_field_refs`\* integer ≥ 0 (in_field); a 0 here is the "no in-field references" flag; `note` text (notes, comment) |
| `do-not-invite` | email | `email`\*; `reason` text (note); `source` text (e.g. the conference the entry came from) |

*Atomic.* The whole file is parsed and validated before anything is written. Any problem rejects the file and imports **nothing**. The report lists every problem as `line N, column C: problem`, where N is the 1-based file line and the header is line 1. Problems can be a cell that fails validation, a row with more fields than the header, a duplicate key, a missing required column, a column given twice, a CSV syntax error (reported at the line where the bad quote opened), an empty file, or non-UTF-8 bytes. A row that fails validation doesn't claim its key. The report never echoes a cell value. The run and its rows are written in one transaction.

*Versioning.* Every import, including a re-import of an identical file, adds one `import_run` row: `id`, `kind`, `file_sha256` (of the raw bytes), `file_name` (basename), `imported_at` (app clock, so `PCS_NOW` applies; epoch seconds), and `row_count`. The rows go in a per-kind table (`import_invite`, `import_tpms_assignment`, `import_tpms_registration`, `import_refcheck`, `import_do_not_invite`) under that `run_id`, in typed columns named after the canonical CSV columns, with the source `line`. Nothing is updated or deleted. Queries (`imports/store.ts`):
- `runAsOf(kind, t)` returns the latest run with `imported_at ≤ t`, breaking ties by the highest id. `rowsAsOf(kind, t)` returns "what the sheet said at t".
- `diffRuns(kind, a, b)` and `diffWithPrevious(run)` return added, removed, and changed rows (same key, different values) plus an unchanged count.

*Confidentiality.* The do-not-invite list, like every import, lives only in its table inside the SQLCipher-encrypted store (`PCS_DB_KEY`). That is what "stored encrypted alongside the DB" means here. `pcs wipe` removes it with everything else. Don't keep the source CSV around.

*CLI.* `pcs import <kind> <file>` prints the run id, the row count, the +added/−removed/~changed counts against the previous version, and a hash prefix. On errors it prints the report (the first 50 problems), exits 1, and writes nothing. `pcs import --list [kind]` prints the history: run id, kind, time, row count, diff counts, and hash prefix. It shows counts only, never content. `pcs import --help` lists the columns. Synthetic fixtures for every kind, including malformed variants, are in `seed/fixtures/imports/`.

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

**Implemented (M10): `server/src/modules/assignment/`, `pcs validate-assignments [--tpms] [--out fixup.csv]`.**

*Inputs.* Everything comes from the local store and the imports, never from HotCRP directly: live papers with their authors (email, affiliation; store migration 4, synced from `GET /papers`), people with tier and affiliation (`/pc`), current review assignments with their review's status, area chairs per `PCS_AC_ROLE`, and the latest `invites`, `do-not-invite`, and (with `--tpms`) `tpms-assignments` imports as of the app clock. The assignment being validated is either the current HotCRP one (default) or the TPMS proposal (`--tpms`).

*Tiers.* A reviewer's tier is `PCS_TIER_TAGS` applied to their user tags (§10.2), else `senior`. Seniors fill the senior slots. Every other tier (`junior`, `reserve-active`, `reserve-pool`, or a custom one) fills the third slot. Load bands exist for `senior`, `junior`, `reserve-active`, and `reserve-pool`. A PC member with no review rows at all can't be tiered through the API (§1), so they count as senior.

*Review slots.* Only `primary`, `secondary`, and `pc` review assignments count. Metareviews (ACs) and external reviews don't.

*Row checks (dropped before anything else).* `DUPLICATE_ROW` (same pid and email twice), `UNKNOWN_PAPER` (not a live paper at the last sync), and `NOT_PC_MEMBER` (activated reserves must be added to the PC first). The rows that remain are the **panel**. Composition, load, and cycles are judged on the panel, that is, on the assignment as proposed.

*Composition* (per paper; in `--tpms` mode only for papers the proposal covers):
- `ALL_JUNIOR_PANEL`: 0 seniors and at least 1 third-slot reviewer.
- `SENIOR_MISSING`: otherwise, fewer than `PCS_POLICY_MIN_SENIOR` seniors.
- `THIRD_SLOT_MISSING`: no third-slot reviewer.
- `THIRD_SLOT_EXTRA`: more than one, under `PCS_POLICY_THIRD_SLOT=exactly1`.
Extra seniors are allowed (a 4th review is possible).

*Load bands* (per PC member; chairs and ACs exempt): `LOAD_OVER` when the count of review assignments is greater than `PCS_LOAD_<TIER>_MAX`, `LOAD_UNDER` when it is less than `_MIN`. In `--tpms` mode, people the proposal doesn't mention aren't flagged as under. Defaults: senior 4–12, junior 2–8, reserve-active 1–3, reserve-pool 0–0 (a designee who hasn't been activated should have no assignment).

*Conflict sanity* (per panel row; each such row is left out of the fix-up):
- `AUTHOR_IS_REVIEWER`: the reviewer is an author of the paper.
- `SAME_AFFILIATION` (`PCS_CONFLICT_AFFILIATION`, default on): the reviewer's `/pc` affiliation equals an author's affiliation on the paper, ignoring case, accents, punctuation, and spacing. An empty affiliation never matches.
- `COAUTHOR` (`PCS_CONFLICT_DBLP`, default off): asks a `CoauthorshipSource` (`dblp.ts`). No source ships in M10, and there are no network calls. With the flag on, the report notes that the check was skipped.

*Reserve candidates* (each such row is left out of the fix-up):
- `DO_NOT_INVITE`: any reviewer on the latest `do-not-invite` import.
- `RESERVE_NOT_APPROVED`: a reviewer in a `reserve-*` tier needs a row for *that paper* in the latest `invites` import with `ac_decision=approve` and `response≠decline`. With no `invites` import, no reserve candidate is approved.

*Reciprocal cycles* (`RECIPROCAL_CYCLE`, for human review only, never dropped). Nodes are people; there is an edge a → r when a is an author of a paper P in the panel and r reviews P. The validator reports every simple cycle of length 2..`PCS_CYCLE_MAX_K` (default 3, max 6). Each cycle is listed once, starting at its smallest email, with the papers behind each edge. The graph is first pruned to nodes with both incoming and outgoing edges, which leaves only people who are both authors and reviewers. A depth-bounded DFS from each node then visits only larger nodes, so no dedup pass is needed. Listing stops after `PCS_CYCLE_MAX_REPORT` cycles (default 500), with a note. 2,400 papers and ~10k review edges take well under a second (unit perf test).

*Fix-up CSV* (`--out`, `report.fixup.csv`): `paper,action,user`, ordered by paper. For each paper, the lines are:
1. `clearreview` lines;
2. the kept seniors, by TPMS score and then email;
3. the third slot, trimmed to the single best-scored reviewer under `exactly1`.
A reviewer who already holds that assignment keeps their current type (`primary`/`secondary`/`pcreview`). New seniors get `primary`; a new third slot gets `secondary`. A `clearreview` line is emitted only when it is **needed and safe**: the reviewer currently holds a review assignment on a paper in scope that the fix-up doesn't keep (dropped, trimmed, or not in the TPMS proposal), *and* their review is still `empty`. Started reviews are kept and listed instead. Metareviews are never touched. Papers in scope: all live papers (default), or only those the TPMS proposal covers (`--tpms`). What a paper still lacks after the fix-up (seniors, third slot) is reported as a **gap**, not as a finding. Re-emitted unchanged lines are no-ops in HotCRP. The chair dry-runs the CSV (HotCRP's upload preview, or `HotcrpClient.assign(csv, { dryRun: true })`) before applying it.

*Output.* Each finding is `{ check, code, pid?, emails, cyclePids?, reason, dropped? }`, where `reason` carries the numbers and the `PCS_*` setting involved. Findings never include review or comment text. The CLI prints findings grouped by check, then the fix-up summary and gaps, and exits 0 when it has run (whether or not there are findings). For the server, `validateAssignments(store, cfg, { source, clock })` in `modules/assignment/index.ts` returns the same report.

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

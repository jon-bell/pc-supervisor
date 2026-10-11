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
| PC conflicts | `GET /searchaction?action=get/pcconf&q=all&t=s` (managers only) | CSV `paper,title,given_name,family_name,email,conflicttype`, one row per conflicted (paper, PC member) pair, PC author conflicts included; `conflicttype` is the text label (`Author`, `Contact`, `Conflict`, …). Used only by `pcs export tpms` (§10.3). **Verified (TPMS exchange).** |
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
| Ratings of reviews | **included in `GET /reviews`** (`ratings` field) | Flags: `good needswork short vague narrow disrespectful wrong`. Encoding: a sorted **multiset** of flags (`["short","short","vague"]` means 2 raters said short and 1 said vague); a bare string for a single flag; absent when unrated. **No rater identity and no timestamp, even for chairs.** Raters must be able to see the review (co-reviewers after submitting, or the metareviewer), and nobody can rate their own review. Per-review `GET /{p}/reviewrating` exists but isn't needed. `rate:<flag>` works in searches. **Verified.** |

**API facts that differ from what the docs suggest (from the harness):**

- **Review `version` is an opaque version tag, not a counter.** Seen values: 269888, 455859, 157921. Detect change by inequality only, never by ordering.
- **Review `modified_at` is admin-visible, but HotCRP suppresses it when `reviewModified <= timeRequested`, which includes a review requested and submitted in the same second.** That matters for seeding (§9.3). In production, treat a missing `modified_at` as "unknown" and fall back to `first_seen_at`.
- **Comment `word_count` is null for ordinary comments.** We compute word counts ourselves.
- **A bad search query is not an error.** An unknown keyword returns `ok: true`, empty results, and a `message_list` warning (status 1). The client treats warnings on read endpoints as errors, so a typo can't look like "every review was deleted".
- **Search grammar and composing searches (`PCS_PAPER_SEARCH`).** Operators bind loosest to tightest as `HIGHLIGHT`, `THEN`, unnamed space-OR, `OR`, `XOR`, `AND`, space (= AND), and `NOT`/`-`. Parentheses group, and inside parentheses a space always means AND (`src/searchoperatorset.php`, `SearchParser::parse_expression`). A run of bare numbers and ranges inside one space group (`3 7-9 40`) merges into a single paper-number set, a union, even inside parentheses (`searchterm.php`, the `pn` merge). So the client turns a scope `S` and a query `Q` into `(S) AND (Q)`, each side wrapped by a port of HotCRP's own `SearchParser::safe_parenthesize` (`server/src/hotcrp/search-parens.ts`), which keeps what HotCRP's forgiving parser does with a side alone: a stray `)` (or `]`, `}`) is dropped, an unclosed `"` or bracket is closed, brackets inside quotes (with `\` escapes and curly quotes) don't count. `THEN` and `HIGHLIGHT` survive the wrapping: a `THEN`'s papers are the union of its groups and a `HIGHLIGHT`'s are its left operand's wherever the term sits (`Then_SearchTerm`), and an `in:` limit keyword inside still widens the collection when no `t` is sent. `Q` = `all` or empty becomes `(S)`, and `Q` = `NONE` stays `NONE`. Every paper read is composed this way: `/search`, the `searchaction` downloads (`get/pcassignments`, `get/lead`, `get/shepherd`, `get/pcconf`, `get/allrevpref`), `/reviews` (the `q`, not the per-review `rq`), `/comments`, and `/papers`. Config still refuses a scope with unbalanced parentheses or an unclosed quote (`strictSearchProblem`): HotCRP would accept it, but in `.env` it is almost surely a typo. **Verified** on the harness, including `(#tag) AND (P Q R)` returning only the tagged papers among P, Q, and R, and by `server/test/integration/search-parity.test.ts`: for ~55 queries from HotCRP's help pages (THEN, HIGHLIGHT, NOT/`-`, quoted phrases, `#tag>1`, `#tag#2`, ranges, `re:any`, `ovemer:>=4`, `status:`, `dec:yes`, `sort:`/`show:`, `in:all`, unbalanced brackets and quotes, unicode, `&`, `+`, `%`, `#`) and for every collection, the filter's pids equal HotCRP `/search(q, t)` ∩ `/search(S, t=all)` made directly, and HotCRP warns exactly when the filter reports a warning.
- **Search completion.** HotCRP has `GET /api/searchcompletion` (`src/api/api_completion.php`, what its own search box completes after a `keyword:`): a list of strings and `{pri, nosort, i}` priority groups covering `has:`, `dec:`, `round:`, `topic:`, `style:`, `show:`/`hide:` columns, submission-field keywords (`abstract:{text}` is a template), `ss:` saved searches and `sclass:`. It has no tags, users or keyword list; its `script.js` gets tags from `GET /api/alltags` (names only, no counts) and PC members from `/pc`. Both are read-only and need no paper content. The keyword grammar itself is `etc/searchkeywords.json` (names, aliases, and regex keywords for `[c|i|p]re`, `pri/sec/ext/meta`, `cmt`, responses, review-field and option abbreviations). One of its suggestions is broken: on an instance with review rounds it offers `round:any`, which its own parser rejects ("Review round not found": `Review_SearchTerm::parse_round` calls `ReviewSearchMatcher::parse_round` without `allow_generic`); the app drops it (§10.6). **Verified** at `60f693f`.
- **Search collections (`t=`).** `/search` takes `t` = a collection (`Limit_SearchTerm::$reqtype_map`): `s`, `accepted`, `undecided`, `active`, `all`, `unsub`, `r`, `rout`, `req`, `lead`, `admin`, `alladmin`, `reviewable`, `viewable`, `a` (plus aliases such as `acc`, which HotCRP echoes back canonical). An unknown `t` silently searches nothing. Without `t`, HotCRP picks its quicksearch default for the account (for a chair: `all` while submissions are open, else `active` or `s`) and `in:` keywords in the query may widen it (`tsoft`); with an explicit `t`, `/api/search` has no way to ask for `tsoft`, so `in:` only narrows.
- **Rate limits:** by default 250 requests/minute and 5000/hour per user (`src/contactcounter.php`), reported in `x-ratelimit-*` headers; a 429 carries `Retry-After` in seconds. A `/reviewhistory` backfill of 10k reviews therefore takes over two hours.
- **`reviewer` (reviews) and `author` (comments) are HTML.** Use `reviewer_email` / `author_email`.
- **`/reviewhistory` deltas (`object: "review_delta"`) have no `modified_at`**, and text fields may appear as `<UID>:p` patches.
- **Review-field values depend on the field type** (`ReviewField::unparse_json`): `text` is a string; `radio`/`dropdown` is the score symbol (a number or a letter), or `false` for "no entry"; `checkbox` is a boolean; `checkboxes` is a list of symbols; any type can be `null`. Only `radio`/`dropdown` fields are stored as scores, with `false` stored as `null` (never 0); `checkbox`/`checkboxes` fields are ignored. (Found on a real instance whose form had a checkbox field; the harness form has none.)
- **Ratings depend on instance settings.** `review_rating` (`pc` | `all` | `no`) controls who may rate, and `review_rating_visibility` controls who sees them. `pcs probe` reports both; if ratings are off, the rating-based signals are hidden, not shown as zero.
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
- **Tiers** come from user tags (`PCS_TIER_TAGS`). Junior and reciprocal reviewers get their own outlier lists, because reciprocal reviewers are the group most likely to drop out. With `PCS_TIER_TAGS` empty there are no tiers (everyone is `senior`): `/api/meta` says `tiersConfigured: false` and the UI shows no tier fields, columns, chips, filters, headings, or the tier-progress view and its nav entry; the report's per-tier tables read "All reviewers".
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
- **Server (M5, `server/src/server/`):** `pcs serve [--watch]` runs Fastify on `127.0.0.1:PCS_PORT` and serves `web/dist` with an SPA fallback. Routes: `GET /api/meta` (phase, now, pinned, HotCRP base URL, rule weights, tiers), `GET /api/triage?ac=&rule=&tier=` (every paper in triage order with reasons, AC, merits, tier mix, last activity, plus facet counts), `GET /api/papers/:pid` (the drawer: reviews with versions and text, comments with author, word count, mentions and text, one merged timeline), `GET /api/sync/status`, `POST /api/sync` (202, or 409 while a sync runs; one at a time per process). Requests whose `Host` isn't a loopback name get 421 (DNS rebinding); every response carries a CSP that allows only `'self'`; sync errors are redacted; a unit test checks no body or header contains the token. M6 adds `/api/acs`, `/api/reviewers`, `/api/people/:email`, `/api/overview` to the same route list; M8 adds `/api/actions`, `/api/papers/:pid/nudge`, `POST /api/tags/preview`, and `POST /api/tags/commit` (§6); M11 adds `/api/reserve` and `/api/quickreject` (§10.4 A/B); M12 adds `/api/tier-progress` and `/api/early-reject` (§10.4 D/E); M13 adds `/api/report`, `/api/report/export.zip`, `/api/report/export/:file`, and `/api/report/do-not-invite.csv` (§10.4 G). The tag write routes also refuse any `Origin` but the server's own (`http://127.0.0.1:PCS_PORT`, `localhost` or `[::1]`), plus the Vite dev server's under `PCS_DEV`. `listRoutes()` in `app.ts` enumerates every route, and the e2e security spec checks each one for the token.
- **In-app paper filter (`server/src/server/paper-filter.ts`, `web/src/components/PaperFilter.tsx`).** `/api/triage`, `/api/acs`, `/api/leads`, `/api/reviewers`, `/api/people/:email`, and `/api/overview` take `?search=<HotCRP search>` and `?t=<collection>` (HotCRP's "Search in"). The filter is on when either is set. The server resolves it to a pid set with one read-only `GET /search?q=…&t=…` to `PCS_HOTCRP_URL` (ANDed with `PCS_PAPER_SEARCH` by the client, §1), caches each (search, t) for 60 s of wall time (at most 32), and evaluates the rules over only those papers, so AC and reviewer aggregates count only them. The search goes to HotCRP as typed: nothing HotCRP accepts is refused or rewritten (only a control character or more than 1,000 characters is a 400). Without `?t=` no `t` is sent, so HotCRP uses its own default collection for the chair, exactly as its quicksearch box does; an explicit `t` must be a canonical collection name (`server/src/hotcrp/collections.ts`) or it is a 400. HotCRP's warnings (unknown keyword, no such user, a collection that can't match) don't stop the filter: as on HotCRP's search page, its matches are used and the warnings (tags stripped, token redacted) come back from `GET /api/paper-search?search=&t=` with the pids, the collection HotCRP searched, and how many matches are in the store; the box shows them beside the count. Errors are 400 for HotCRP refusing the request outright, 502 when HotCRP can't be reached (the failure kind only), and 503 without a HotCRP client. The browser never sees the token or any HotCRP URL beyond the base. In the web app `search` and `t` are sticky query parameters: `navigate()` and `<Link>` carry them to every in-app target (`router.tsx` `STICKY_PARAMS`), and data hooks add them to their API calls (`usePaperSearch`). The "Search in" selector next to the box lists HotCRP's collections with HotCRP's labels; its first entry is HotCRP's default (named after what HotCRP reports it resolves to) and leaves `t` out of the URL. HotCRP answers about its current state while the store reflects the last sync, so a paper added since then matches nothing until the next sync, and the box says so.
- **Search autocomplete (`web/src/components/SearchCombobox.tsx`, `web/src/search-complete.ts`, `server/src/server/search-completions.ts`).** The box is an ARIA combobox (input + listbox, `aria-activedescendant`, a polite live count). It completes the token under the caret, split the way HotCRP's parser splits words (whitespace and parentheses end a word except inside quotes; a leading `-`, `!` or `+` is an operator), so it works after `OR`, `-`, `(` and before `)`. ↓/↑ move (↓ also opens), Tab/Enter accept, Esc closes, Enter with the list closed (or on a token that is already complete) applies the filter; a mouse press accepts without stealing focus. Suggestions: tags as `#tag` (also after `tag:`, `notag:`, `order:`, `-#`, `show:#`) ranked by how many live store papers carry them, with the count, twiddle tags matched by their bare name, and `#tag#value` values; HotCRP keywords with a short hint (`server/src/hotcrp/search-keywords.ts`, derived from `etc/searchkeywords.json` and `h_keywords.php`, aliases matched) plus this instance's review fields (`OveMer:` with `OveMer:4`, `>=4`, `<=2`, `any`, `none`) and submission fields; operators `OR`, `AND`, `NOT`, `XOR`, `THEN`, `HIGHLIGHT`; values after `keyword:` (fixed ones such as `re:any`, `lead:none`, `dec:yes`; PC members by email or name after `re:`, `lead:`, `shepherd:`, `manager:`, `pri:`, `sec:`, `cre:`…; decisions and rounds with paper counts; everything HotCRP's `/searchcompletion` offers). Ranking: exact, prefix, word-start, substring, then subsequence (2+ characters), ties by paper count or catalog order; at most 12 shown. `GET /api/search-completions` builds this from the store (SQL over `paper.tags`, `person`, `assignment`, `review_field`, `submission_field`) merged with HotCRP's `/searchcompletion` and, when `PCS_PAPER_SEARCH` is empty, `/alltags` (tags no synced paper carries yet, count 0); cached for 60 s or until the next finished sync; if HotCRP can't be reached it answers from the store alone (`hotcrp: false`). It also carries the collections and HotCRP's default one. The integration test checks every completion it offers is a search HotCRP accepts without a warning. The app has no dark theme, so the dropdown uses the same light tokens as the rest of the UI.
- **Tables: column sort and filter (`web/src/components/DataTable.tsx`, `MiniTable.tsx`, `ColumnFilters.tsx`, `web/src/table/`).** Every table sorts and filters by column in the browser, over the rows the server sent (the server-side filters, `?search=`/`?t=` and triage's `?ac=&rule=&tier=`, apply first). A column opts in by declaring its kind in the column definition (`meta.kind`, plus `meta.value` when the cell's value isn't plain); the kind picks the comparator and the filter widget. Sorting: a header click sorts ascending, then descending, then off (back to the server's order); shift-click adds a secondary key (shown with its rank); `aria-sort` on the header. The sort is stable and type-aware: numbers and dates (ms) numerically, strings with locale and numeric collation, false before true, empty cells last in either direction. Filters open from a button in the header, as a popover (focus moves in; Esc closes and returns focus; a press outside or tabbing out closes): categorical (flags, rules, tiers, states, decisions, AC and lead names) is a searchable multi-select with per-value counts under the other filters, select all/none, and a "(none)" option for empty cells; numeric is a min/max range with a histogram strip (a bar click filters to it), two sliders and inputs; date is a from/to range in conference-zone days plus presets (last 24 hours, last 7 days, since the current phase began), all against the server's clock (`/api/meta` `now`, so `PCS_NOW` applies); text is an accent- and case-insensitive contains with suggestions from the column's values; boolean is any/yes/no. Active filters show as removable chips above the table with "Clear all" and "N of M"; triage's count, HotCRP search and tag actions follow the visible rows. State lives in the URL per table (`<key>.sort=a,-b`, `<key>.<column>=…`; encoding in `web/src/table/model.ts`), sticky like `search` and `t` (`router.tsx`), so it survives navigation, reloads and shared links; malformed values are ignored. Work is memoized per (data, columns, state): values are extracted once, each filter is a precomputed mask, and only the visible rows are sorted, so 2,400 rows stay within the M7 filter budget (`npm run test:scale` times a column sort and filter) with virtualization unchanged. The per-tier tables (tier progress, solver load, report aggregates) sort but have no filters; the report's key/value summaries stay plain.
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
| `PCS_POLICY_MIN_SENIOR`, `PCS_POLICY_THIRD_SLOT`, `PCS_LOAD_<TIER>_MIN` / `_MAX`, `PCS_CYCLE_MAX_K`, `PCS_CYCLE_MAX_REPORT`, `PCS_CONFLICT_AFFILIATION`, `PCS_CONFLICT_DBLP` | Assignment validator (§10.4 C) | 2 / `exactly1` / per tier, see §10.4 C / 3 / 500 / `true` / `false` |
| `PCS_RESERVE_*`, `PCS_DBLP_*` | Reserve compliance (§10.4 A); the DBLP lookup is opt-in | see `.env.example`; `PCS_DBLP_ENABLED=false` |
| `PCS_QR_*`, `PCS_REFCHECK_*` | Quick-reject tracker (§10.4 B) | see `.env.example` |
| `PCS_RESERVE_TIERS`, `PCS_COACH_TIERS`, `PCS_COACH_MIN_WORDS`, `PCS_RESERVE_DROPOUT_DAYS`, `PCS_POLICY_WITHHOLD_REVIEWS`, `PCS_WITHHOLD_TAG` | Reviewing by tier (§10.4 D) | `reserve-active,reciprocal` / `junior` / `PCS_THRESH_MIN_WORDS` / 3 / `false` / `reviews-withheld` |
| `PCS_POLICY_EARLYREJECT`, `PCS_MERIT_REJECT_MAX`, `PCS_MERIT_WEAK_REJECT_MAX`, `PCS_EARLYREJECT_MIN_REVIEWS`, `PCS_EARLYREJECT_WINDOW_H` | Early reject (§10.4 E) | `reject_only` / 1 / `PCS_MERIT_ACCEPT_MIN`−1 / `PCS_REVIEWS_REQUIRED` / 48 |
| `PCS_REPORT_MIN_CELL`, `PCS_REPORT_ACCEPT_DECISIONS`, `PCS_PSEUDONYM_KEY` | Process report and pseudonymous export (§10.4 G) | 5 / `accept` / unset (the export refuses to run) |
| `PCS_DB_PATH` | SQLite file | `~/.local/share/pc-supervisor/<host>.db` |
| `PCS_DB_KEY` | SQLCipher key. Reading it from the OS keychain is planned, not implemented | required outside tests |
| `PCS_SYNC_INTERVAL_MIN`, `PCS_SYNC_CHUNK`, `PCS_SYNC_CONCURRENCY`, `PCS_HISTORY_RPS` | Sync tuning | 15 / 200 / 2 / 1 |
| `PCS_FORCE_SHOW` | `false` = respect the chair's own conflicts | `true` |
| `PCS_PAPER_SEARCH` | Pin the app to the papers matching this HotCRP search (e.g. `#shadow`). Every paper read is `(<this>) AND (<q>)` (§1). Papers that leave the search are marked gone at the next sync, like deleted ones, so every view and module drops them. Their rows are kept and come back if the paper matches again. When a scoped sync sees a paper that was not live before, it times that paper's reviews, comments, and assignments as a first sync would (HotCRP's `modified_at`, approximate). The value in use is stored in `meta.paper_search`. | empty = every paper |
| `PCS_PORT` | Local server port | `5317` |
| `PCS_DEV` | `npm run dev` is running: the tag routes also accept the Vite dev origin (`http://127.0.0.1:5173`) | `false` |
| `PCS_ATTENTION_TAG` | Paper tag the v1 tagging action adds/removes (no `#`) | `chair-attention` |

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

Precise definitions are in the header of `server/src/rules/reviewer-metrics.ts`. Notable choices: a ping is an `@mention` of the reviewer or any AC comment on their paper; pings that arrive before the reviewer replies merge into one episode. "Bottom decile" means strictly below the PC's 10th-percentile word count. Outlier lists use absolute bars (≥ 1 silent split paper, ≥ 1 unanswered ping, ≥ 1 late review, ≥ 1 thin review, negative rating flags on ≥ `PCS_THRESH_FLAGGED_PAPERS` (2) different papers), never a rank cutoff, and are grouped by tier. **Rating flags** (implementation): "negative" means every flag except `good` (HotCRP's own "bad" mask), so `disrespectful` counts too; a review counts as thin by rating only when its `short` or `vague` count reaches `PCS_THRESH_RATING_RATERS`, as in `THIN_REVIEWS`. The "repeatedly flagged" list is the coaching case above; the person page shows the flags received (raters per flag) and marks each paper where their review drew a negative flag.

Views (M6): `/reviewers` shows the five lists (the rating-flag list only when ratings are on), each with one group per tier (`senior` plus every `PCS_TIER_TAGS` tier, empty groups included). Each list states its bar. Entries sort by name by default, so a list never reads as a leaderboard; `?sort=count` sorts by count instead. There are no rank numbers. Because any AC comment on a reviewer's paper counts as a ping, a reviewer who never comments on an AC-active paper appears under unanswered pings too (golden R-silent does). The person page `/people/:email` lists every paper the person reviews or chairs, with their review status and scores, their last comment (time, words, an excerpt on hover), the paper's fired rules, and their own flags there. It also lists their **open pings**: every open ping episode on an undecided paper, of any age, marked when it is over `PCS_THRESH_PING_DAYS`. An episode's age runs from its first ping.

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

The AC table (`/acs`, M6) lists ACs alphabetically. The load column reads "6 papers · 5 flagged", next to a bar whose length is the AC's load relative to the largest load and whose dark part is the flagged share. So a chair with many papers looks different from one whose few papers are all flagged. Nudges are labelled "(proxy)". The Comments column counts **every** published comment by the AC on their papers, whenever posted (up to now), and adds "(N since open)" when the count since `DISCUSSION_OPEN` differs; the person page's AC summary shows both. (Counting only comments since `DISCUSSION_OPEN` read 0 on a live PC, because HotCRP allows discussion as soon as reviews are visible and the drawer showed comments posted before the configured date. The comment JSON itself matches the harness: for a chair token `/comments` carries `author_email`, compared lowercased.) Clicking a row opens `/?ac=<email>`.

**Discussion leads** (`/leads`, `GET /api/leads`; definitions in `server/src/rules/lead-metrics.ts`). The same idea grouped by each paper's HotCRP discussion lead (synced from `get/lead` into `assignment` role `lead`), whatever `PCS_AC_ROLE` is. One row per lead, alphabetical, never ranked: their papers and flagged count (with the load bar), reviewer reviews submitted/assigned on those papers (and how many papers have `PCS_REVIEWS_REQUIRED`), everyone's comments on those papers (in all and since `DISCUSSION_OPEN`), whether the lead has commented ("on 2 of 3 papers · not yet on #11", or "no comments yet"), stale papers, and a sparkline of comments on their papers from `DISCUSSION_OPEN`. Clicking a row opens `/leads/:email` (`GET /api/leads/:email`): that lead's papers with AC, reviews, merits, comments, the lead's last comment, last activity and the fired-rule chips; a paper opens its drawer. Both honour the paper filter (`?search=`). With no leads, the page says so and how to assign them in HotCRP (the `lead` assignment action), with the paper count.

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
| `CHAMPION_MISSING` | the top merit is ≥ `MERIT_ACCEPT_MIN`, and no reviewer holding it has commented since `DISCUSSION_OPEN` | 1 |
| `LOW_EXPERTISE` | no review with expertise ≥ `EXPERTISE_OK_MIN` | 2 |
| `THIN_REVIEWS` | a review under `PCS_THRESH_MIN_WORDS`, or flagged short/vague by ≥ `PCS_THRESH_RATING_RATERS` (2) raters | 1 |
| `RESPONSE_UNADDRESSED` | an author response exists, with no reviewer comment after it | 2 |
| `REVIEW_FLAGGED` | any review on the paper carries a `disrespectful` or `wrong` rating. **Phase-independent**, because a disrespectful review needs chair action before authors see it | 4 |
| `DEADLINE_NO_CONSENSUS` | < `PCS_THRESH_DEADLINE_DAYS` (3) to `DECISIONS_DUE`, no decision, and split or silent | +3 |

Clarifications (the precise semantics, with every threshold comparison, are in the header of `server/src/rules/rules.ts`):

- "Reviewer" means a non-AC review on the paper; "complete" means status `delivered`, `approved`, or `complete`. Merits and expertise come from submitted reviewer reviews only.
- **A paper with a decision fires nothing**, except `REVIEW_FLAGGED`. Undecided means HotCRP's decision is unset/"undecided". `REVIEW_FLAGGED` keeps firing on decided papers: authors usually see the reviews together with the decision, so a decided but not yet notified paper is exactly where the chair has to act.
- **Ratings** (`THIN_REVIEWS`' rating clause, `REVIEW_FLAGGED`): "raters" for a flag is that flag's count in the multiset; `short` and `vague` are counted separately (1 short + 1 vague is not 2). `REVIEW_FLAGGED` looks at every review on the paper, metareviews included, and one rater is enough. If the synced settings say `review_rating: no`, both rating clauses are skipped and the UI hides rating counts, the "repeatedly flagged" list, and the report's rating section.
- Thresholds named "older than" / "under" are strict (`>` / `<`); `SPLIT_RANGE` is inclusive (`≥`).
- Phase gates: `MISSING_REVIEWS` and `LOW_EXPERTISE` only after `REVIEW_DUE`; the discussion rules (`UNRESOLVED_SPLIT`, `SILENT_DISCUSSION`, `GONE_QUIET`, `AC_ABSENT`, `CHAMPION_MISSING`, `RESPONSE_UNADDRESSED`) only once `DISCUSSION_OPEN` has passed; `SPLIT`, `THIN_REVIEWS`, and `REVIEW_FLAGGED` in any phase.
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

- **Local only.** There's no hosted mode and no telemetry. The only outbound calls go to `PCS_HOTCRP_URL`, with one opt-in exception: the reserve module's DBLP lookup (§10.4 A), off unless the chair sets `PCS_DBLP_ENABLED=true`. It sends public author names only, to `PCS_DBLP_URL`, and its results are hints, never verdicts.
- **The DB is the most sensitive artifact** (every review and comment, plus reviewer identities).
  - Encrypt it with SQLCipher (`better-sqlite3-multiple-ciphers`).
  - The default path is outside the repo and outside any synced folder.
  - `pcs wipe` deletes it.
  - The repo holds **synthetic data only**. No real review text, names, or emails ever go into fixtures, tests, issues, or screenshots.
- **No LLM over review text.**
- **Wording:** "no comments yet", not "disengaged"; "no in-HotCRP activity", not "absent".
- **No leaderboards by default.** People tables (ACs, leads, reviewer lists, reserve and coaching lists) keep their alphabetical or by-paper default order. The chair may sort any column, including a count, but the app never opens a people table sorted by a metric, and a column sort is cleared with a third click.
- **Conflicts:** `PCS_FORCE_SHOW=false` hides papers the chair is conflicted with.

### Visual conventions (web UI)

Colour has four separate jobs, and nothing is encoded by colour alone.

- **Scores.** Every score shows as a numbered pip coloured on the field's scale. The scale comes from the synced review form: values run 1..n, where n is the number of labels from `get/jsonrqc`, and the colour scheme is the field's HotCRP `scheme`. The form omits `scheme` when it is the default `sv`; the store keeps it in `review_field.scheme` (migration 7), and `/api/meta` returns it as `scales`. A value maps to a scheme step by HotCRP's own rule (`Discrete_ReviewField::scheme_value_class`, reversed schemes included). The app draws `sv` as a purple-to-green diverging scale (PRGn): low and high differ in both hue and lightness, so they stay apart under red-green colour blindness, and green stays "high" as in HotCRP. `bupu`, `viridis` and `orbu` (and their reverses) get their own palettes. Other HotCRP schemes fall back to `sv`, and `none` is neutral. A paper's merits also show as a dot strip on the field's axis, so a split such as 1 and 4 reads as a long range bar. Expertise is a small figure beside each merit pip, or a neutral outlined pip in the drawer. The number is always printed.
- **Severity.** A paper's severity is a bold number plus a bar. The bar's length is the severity relative to the largest in the list, and its colour steps up a five-step sequential red ramp. A reason chip's level comes from its rule's weight on a fixed three-step scale: high (weight ≥ 3, critical red), medium (2, amber), low (≤ 1, neutral). The chip repeats the level as one, two or three bars. Triage shows every reason when there are at most three, otherwise the two heaviest plus "+N", whose tooltip lists the rest. The drawer shows them all, heaviest first.
- **Outlier marks** on people tables (ACs, leads) are a reading aid, not a rule, and not a ranking. Each metric declares which direction is concerning:
  - more is better: comments, coverage, nudges, metareviews submitted, reviews submitted, papers the lead commented on;
  - less is better: days to first post, stale papers.

  A cell is marked only on the concerning side, when its value is beyond the cohort's quartile (below the 25th percentile, or above the 75th). It must also be at least a quarter of the median away from the median (half a day for days to first post), so a tight cohort marks no one. The cohort is the rows of the table: ACs against ACs, leads against leads. Counts compare per paper when loads differ. Marks need at least 3 rows with a value. A marked cell gets an amber tint and a ▼/▲ icon pointing the concerning way. Its tooltip (and the icon's accessible name) gives the numbers, e.g. "5 comments; AC median 16; below the 25th percentile of ACs". These bars are derived from the data, not configured: they are not PCS_* settings, because nothing acts on them. A column whose value is the same for every row is muted. Where a rule threshold exists, the mark uses it instead of the cohort: late reviews after the review deadline, and reviews under the word minimum (tier progress).
- **Order and wording are unchanged by marks:** people tables stay alphabetical, and marks use the §7 wording above.
- **Light and dark** themes follow `prefers-color-scheme`, from one set of CSS custom properties (`web/src/styles.css`), with text at WCAG AA contrast. The UI face is Atkinson Hyperlegible Next, self-hosted from npm (`@fontsource`, served from the app's origin), and numeric columns use tabular figures.

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
- **`earlyreject`** (M12): two stages around the early-reject window, for §10.4 D/E. Stage 2 uses the `assign` event (a review assignment added mid-scenario, with `timeRequested` warped to the event time). See `seed/README.md`.

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

The modules activate by phase. **Single cycle (decided).** There is no resubmission linking and no per-cycle phase sets.

**Implemented (M9).** The six new dates are optional, so the MVP runs without them. Startup checks that the configured ones are in this order and reports every violation at once: `REGISTRATION_DUE ≤ SUBMISSION_DUE ≤ QUICKREJECT_DUE ≤ ASSIGNMENT_DONE ≤ REVIEW_DUE ≤ EARLYREJECT_OPEN ≤ EARLYREJECT_CLOSE ≤ RESPONSE_OPEN` (if set) `≤ DISCUSSION_OPEN`. Unset dates are skipped. Only pairs that involve a new date are checked, so MVP validation doesn't change. `EARLYREJECT_CLOSE` needs `EARLYREJECT_OPEN`. Since M12, `EARLYREJECT_OPEN` alone is allowed: the window then closes `PCS_EARLYREJECT_WINDOW_H` hours (default 48) after it opens, and that derived close is order-checked like a configured one.

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
| `tpms-assignments` | TPMS's assignment CSV, the only output a HotCRP venue is documented to receive. **The column layout is unpublished**, so the importer takes a column mapping (`--map paper=…,email=…[,round=…]`) | pid + email |
| `tpms-scores` | The affinity matrix `paper,email,score`, with scores as floats in 0–1 (the same shape as CMT's TPMS download and openreview-matcher's `--scores`). It must be requested from the TPMS operator; whether HotCRP venues get it is **unconfirmed** | pid + email |
| `tpms-registrations` | Reviewer registration status. TPMS has an operator-run status page with no confirmed export, so the importer accepts `email, registered[, n_papers, last_updated]` and degrades to a plain registered list. Repeated imports are diffed | email |
| `refcheck` | Output of an external reference checker (hallucinated references, no in-field references) | pid |
| `do-not-invite` | The chair-to-chair do-not-invite list, stored encrypted alongside the DB | email |

Imports are versioned like snapshots, so "what did the sheet say on day X" is answerable.

**Implemented (M9): `server/src/imports/`, migration 2, `pcs import`.**

*File format.* Files must be UTF-8 CSV (RFC 4180, with an optional BOM) and need a header row. Headers are matched case-insensitively after trimming, with runs of spaces or hyphens read as `_`, so `Candidate Email` matches `candidate_email`. Each column also accepts the aliases listed below. Column order doesn't matter, and unrecognized columns are ignored (their count is reported). An empty cell means unset. Emails are lowercased and must look like `x@y.z`. Dates can be `YYYY-MM-DD` (midnight) or `YYYY-MM-DD[T ]HH:MM[:SS]`, in `PCS_TZ` unless they carry `Z` or an offset, and are stored as epoch seconds. Enum values are case-insensitive. Within one file, a key may appear only once (checked after lowercasing).

There's no public spec for the TPMS formats. The TPMS kinds therefore use a minimal documented column set plus aliases for likely header names. When a real file uses other headers, pass a column mapping on the command line (`--map`, see *TPMS file exchange* below) rather than a `PCS_*` variable, since the mapping belongs to one file.

| Kind | Key | Columns (`*` = required; aliases in parentheses) |
|---|---|---|
| `invites` | pid + candidate_email | `pid`\* integer ≥ 1 (paper, paper_id, paperid, submission, submission_id); `candidate_email`\* (email, candidate); `tpms_score` number (score); `seniority_note` text (seniority); `ac_email` email (ac); `ac_decision` `approve`\|`reject`\|`pending`, empty = `pending`; `invited_at` date; `response` `accept`\|`decline`\|`none`, empty = `none`; `activated_at` date |
| `tpms-assignments` | pid + email | `pid`\* (as above); `email`\* (reviewer, reviewer_email); `score` number (tpms_score, affinity); `round` text (review_round), empty = default round |
| `tpms-scores`, `affinity-local` | pid + email | `pid`\* (as above); `email`\* (reviewer, reviewer_email, reviewer_id, user, user_email); `score`\* number from 0 to 1 (affinity, tpms_score, similarity). A header-less file whose first row is `integer,email,…` is read by position, as `pid,email,score` |
| `tpms-registrations` | email | `email`\* (reviewer, reviewer_email): the HotCRP email the reviewer registered with; `registered` `yes`/`no`, `true`/`false`, `1`/`0`, `y`/`n` (is_registered); **no such column = every listed email is registered**; `papers_uploaded` integer ≥ 0 (papers, num_papers, n_papers); `last_updated` date (updated, updated_at, last_update, last_modified). A header-less file whose first cell is an email is a plain list, read by position |
| `refcheck` | pid | `pid`\* (as above); `total_refs` integer ≥ 0 (refs, references); `hallucinated_refs`\* integer ≥ 0 (hallucinated, unresolved_refs); `in_field_refs`\* integer ≥ 0 (in_field); a 0 here is the "no in-field references" flag; `note` text (notes, comment) |
| `do-not-invite` | email | `email`\*; `reason` text (note); `source` text (e.g. the conference the entry came from) |

*Atomic.* The whole file is parsed and validated before anything is written. Any problem rejects the file and imports **nothing**. The report lists every problem as `line N, column C: problem`, where N is the 1-based file line and the header is line 1. Problems can be a cell that fails validation, a row with more fields than the header, a duplicate key, a missing required column, a column given twice, a CSV syntax error (reported at the line where the bad quote opened), an empty file, or non-UTF-8 bytes. A row that fails validation doesn't claim its key. The report never echoes a cell value. The run and its rows are written in one transaction.

*Versioning.* Every import, including a re-import of an identical file, adds one `import_run` row: `id`, `kind`, `file_sha256` (of the raw bytes), `file_name` (basename), `imported_at` (app clock, so `PCS_NOW` applies; epoch seconds), and `row_count`. The rows go in a per-kind table (`import_invite`, `import_tpms_assignment`, `import_tpms_registration`, `import_refcheck`, `import_do_not_invite`) under that `run_id`, in typed columns named after the canonical CSV columns, with the source `line`. Nothing is updated or deleted. Queries (`imports/store.ts`):
- `runAsOf(kind, t)` returns the latest run with `imported_at ≤ t`, breaking ties by the highest id. `rowsAsOf(kind, t)` returns "what the sheet said at t".
- `diffRuns(kind, a, b)` and `diffWithPrevious(run)` return added, removed, and changed rows (same key, different values) plus an unchanged count.

*Confidentiality.* The do-not-invite list, like every import, lives only in its table inside the SQLCipher-encrypted store (`PCS_DB_KEY`). That is what "stored encrypted alongside the DB" means here. `pcs wipe` removes it with everything else. Don't keep the source CSV around.

*CLI.* `pcs import <kind> <file>` prints the run id, the row count, the +added/−removed/~changed counts against the previous version, and a hash prefix. On errors it prints the report (the first 50 problems), exits 1, and writes nothing. `pcs import --list [kind]` prints the history: run id, kind, time, row count, diff counts, and hash prefix. It shows counts only, never content. `pcs import --help` lists the columns. Synthetic fixtures for every kind, including malformed variants, are in `seed/fixtures/imports/`.

**Exports to TPMS** (`pcs export tpms <dir>`). TPMS has no API, no HotCRP integration, and no chair self-service; data is exchanged as files with the operator. The tool prepares:
- the PC list with emails;
- the HotCRP conflicts CSV;
- one load-group file per tier and load band;
- the reviews-per-paper target.

The PDF ZIP comes from HotCRP's own download.

**Implemented (TPMS file exchange): `server/src/imports/` (kinds, streaming parser, `scores.ts`), `server/src/modules/tpms/`, migration 5, `pcs import … --map/--no-header`, `pcs export tpms <dir>`.**

*Column mapping.* `pcs import <kind> <file> --map col=header,…`, e.g. `--map paper=Submission #,email=Assigned Reviewer,score=Match Quality,round=Phase`. Keys are canonical column names or their aliases (`paper` = `pid`). A value is a header name, matched the same way as headers, or a bare number, which is a 1-based column position. Header names can't contain commas. A mapped column is read only from its target. The mapping overrides header detection, so a header matching a mapped column's alias is ignored. Columns the mapping leaves out are still found by name and alias among the remaining headers. Without `--map`, the aliases above apply. `--no-header` reads a file without a header row: columns are taken by position in the table's column order, unless `--map` gives positions (a name there is an error). A mapping problem rejects the file atomically and is reported like a row problem, with line 1 (header) or `file`: an unknown column, a column mapped twice, two columns mapped to one cell, no or several header cells with that name, a position outside the row, or a required column still missing. The mapping works for every kind. It exists for `tpms-assignments`, whose layout is unpublished, and the round is stored with each pair.

*Large files.* Every import is streamed. The file is read in 1 MiB chunks and decoded incrementally (strict UTF-8). An incremental RFC 4180 parser (`csv-stream.ts`, same grammar and errors as `hotcrp/csv.ts`) feeds the row validator, and each valid row is inserted inside one transaction. If any problem turns up, the transaction is rolled back, so atomicity is unchanged: nothing is written. Duplicate keys are caught by the table's primary key (`insert … on conflict do nothing`), so no key set is held in memory. The report keeps the first 1,000 problems and counts the rest. A synthetic 2,400 × 600 `tpms-scores` import (1.44M rows) runs in a unit test: on the dev machine it took about 8 s to import and about 3.4 s to load with `scoresAsOf`, with RSS up about 110 MB including the in-memory database. `pcs import` and `--list` count diffs in SQL (`diffCounts`, a join on the primary key) instead of loading rows.

*Scores.* `tpms-scores` (TPMS's matrix, if the operator provides it) and `affinity-local` (cold-start scores from openreview-expertise, §10.4 C) are **two kinds** with the same columns. They version separately, so re-importing one never replaces the other. Their rows share the table `import_score` (`run_id, line, pid, email, score`, with a check that 0 ≤ score ≤ 1). openreview-expertise writes `submission_id,reviewer_id,score` with no header. Run it locally with HotCRP pids as submission ids and HotCRP emails as reviewer ids, with normalized scores in 0–1. Its file then imports as-is: the header-less row is detected. The tool only imports the output file. It never installs or runs openreview-expertise, and never calls its hosted API. `scoresAsOf(db, t, { sources? })` (`imports/scores.ts`) merges the latest run of each kind as of `t` into a dense in-memory matrix (Float64 papers × reviewers plus a source byte; 2,400 × 600 is about 13 MB):
- `pids`, `emails` (sorted; the column order), and `pairs`;
- `score(pid, email)` and `source(pid, email)` (`"tpms"` | `"local"` | null);
- `row(pid)`, a `Float64Array` over `emails`, with NaN for unscored;
- `topK(pid, k, exclude?)`, best first, ties by email;
- `paperIndex` and `reviewerIndex`, and `runs`.

A TPMS score wins; a local score fills only pairs TPMS didn't score. The two scales aren't calibrated against each other. This is the input for the solver (PLAN M10b).

*Registrations.* Besides `email, registered[, n_papers, last_updated]`, the importer accepts a file with only an email column, or a header-less list of emails, and stores everyone listed as registered. Repeated imports are diffed. `pcs import` and `--list` print +added/−removed/~changed. The reserve view (§10.4 A) adds a note, for example `tpms-registrations import #4 vs #3: 2 newly registered, 1 no longer registered (+1 -2 ~2 rows)`.

*Export bundle* (`pcs export tpms <dir>`, `modules/tpms/`). It reads the PC, tiers, and ACs (`PCS_AC_ROLE`) from the local store, so run `pcs sync` first. It reads conflicts live from HotCRP with a chair or manager token: **`GET /api/searchaction?action=get/pcconf&q=all&t=s`** (`HotcrpClient.pcConflicts`, `PcConflictsSchema`, contract test `test/contract/tpms.test.ts`). That is HotCRP's own "PC conflicts" download (`GetPcconflicts_ListAction`). The conflicts aren't stored, because nothing else needs them. The directory is created 0700, and each file is written 0600:

| File | Format |
|---|---|
| `pc.csv` | `email,name,affiliation,tier,role,load_group`: one row per current PC member. `role` is `chair`, `ac`, or `reviewer`. Only reviewers are assignable and have a `load_group`, the name of their load file. ACs are those `PCS_AC_ROLE` identifies at export time. |
| `conflicts.csv` | HotCRP's columns, unchanged: `paper,title,given_name,family_name,email,conflicttype`. One row per conflicted (paper, PC member) pair, for submitted papers, including PC members' author conflicts. `conflicttype` is HotCRP's label: `Author`, `Contact`, `Conflict`, `Pinned conflict`, or a description if the venue collects them (the harness, which doesn't, reports declared conflicts as `Conflict`). Non-PC authors never appear. |
| `load-<tier>.csv` | `email,min_papers,max_papers`: one file per tier with assignable members. Bounds come from `PCS_LOAD_<TIER>_MIN/_MAX`. A tier without a band, such as a custom `PCS_TIER_TAGS` tier, gets blank bounds. |
| `reviews-per-paper.csv` | `reviews_per_paper,senior_min,third_slot_min,third_slot_max,third_slot_tiers`, one row. The values are `PCS_POLICY_MIN_SENIOR` + 1, `PCS_POLICY_MIN_SENIOR`, 1, 1 (empty for `atleast1`), and the non-senior tiers joined with `;`. |
| `README.txt` | What each file is, the confidentiality note, where to get the PDFs, and what to send back. |

The bundle contains reviewer emails and names by necessity, because TPMS matches reviewers by email. `conflicts.csv` also carries paper titles, as in HotCRP's own format. The bundle never contains review or comment text. The CLI and `README.txt` both say so. The PDF ZIP is not fetched: the CLI prints where to download it in HotCRP (*Search → Submitted → select all → Download → Documents: Submissions*). An integration test (`seed/test/integration/tpms-export.test.ts`) seeds the `assignment` scenario, syncs it, and checks the bundle and the CLI's files.

### 10.4 Modules

**A. Reserve-reviewer compliance** (around the registration and submission deadlines)
- Per paper: is a designee present, or is there a valid exemption claim? Exemption reasons are an enumerated, configurable set.
- Per person: is the designee identical across every paper that names them? How many papers do they cover? Coverage does not scale their obligation; it's flagged against `PCS_RESERVE_MAX_COVER`.
- Seniority and exemption evidence: self-declared fields, plus an **optional DBLP lookup** that counts papers at a configurable venue list. The lookup sends only public author names, never submission content. It's a hint for a human, never a verdict.
- TPMS registration status, if it's imported.
- Output: a non-compliance list with evidence, plus drafted mail-tool searches for warnings.

**Implemented (M11): `server/src/modules/reserve/`, `pcs reserve [--no-dblp]`, `GET /api/reserve`, *Modules → Reserve*.**

*Inputs.* Everything comes from the local store and imports, never from HotCRP directly: live papers that aren't withdrawn, with their authors (email and name; migration 4); the values of three submission options named by `PCS_RESERVE_DESIGNEE_FIELD` ("Reserve designee"), `PCS_RESERVE_EXEMPTION_FIELD` ("Reserve exemption"), and `PCS_RESERVE_SENIORITY_FIELD` ("Reserve seniority", optional self-declared evidence, shown but never judged); which of those options HotCRP defines (`submission_field`); the current PC; and the latest `tpms-registrations` import as of the app clock. If neither the designee nor the exemption option exists, nothing is checked: every paper is `unchecked` and a note says why.

*Identity.* M10 seeds the designee option as a **text** field holding the designee's email, so designees are identified **by email**: the email is what HotCRP, TPMS, and the invites sheet key people by. The value is normalized first: trimmed, lowercased, and unwrapped from `Name <email>` or `mailto:`. A value with no email is matched by **normalized name** to the paper's own authors (accents, case, punctuation, and spacing ignored; `Last, First` read as `First Last`). It is accepted only if exactly one author with an email matches, and is then reported as `identifiedBy: "name"`. Names never decide identity on their own; they only resolve a name-only value and group designations for the consistency check. A non-text designee option gets a note.

*Per-paper checks* (severity `noncompliant`; one function each in `check.ts`):
- `DESIGNEE_UNRESOLVED`: the designee value is not text, an invalid email, or a name that matches zero or several authors.
- `DESIGNEE_NOT_AUTHOR`: the designee email is not among the paper's authors. The designation still counts for coverage, consistency, and TPMS.
- With no designee, the exemption decides:
  - `DESIGNEE_MISSING`: no exemption claimed either.
  - `EXEMPTION_NOT_ALLOWED`: the claimed reason is not in `PCS_RESERVE_EXEMPTIONS` (compared case-insensitively). The default set is the dropdown values M10 seeds: `no-eligible-author, all-authors-on-pc, other`.
  - `EXEMPTION_CONTRADICTED`: the claimed reason is `PCS_RESERVE_EXEMPTION_ALL_PC` (default `all-authors-on-pc`; empty disables the check), but some author isn't a current PC member. An author without an email counts as not on the PC.
- A paper with a designee is compliant even if it also claims an exemption.
- Paper states: `designee`, `exempt` (a valid claim), `noncompliant`, or `unchecked`.

*Per-designee checks* (severity `warning`):
- `DESIGNEE_INCONSISTENT`: one normalized name is designated under two or more different emails across papers (the same person designated differently). The name comes from `Name <email>`, else the matching author record, else the person table. The finding lists every email with its papers.
- `OVER_COVERED`: an email is the designee of more than `PCS_RESERVE_MAX_COVER` papers (default 3). Coverage does not scale the obligation; it is flagged for the chair. Coverage is counted per email, so the papers of an inconsistent designee are split across emails.
- `TPMS_NOT_REGISTERED` (only with a `tpms-registrations` import): the designee email has no row in the import, or a row with `registered=no`.
- `TPMS_FEW_PAPERS`: registered, but `papers_uploaded` is less than `PCS_RESERVE_TPMS_MIN_PAPERS` (default 1). An empty `papers_uploaded` is not flagged.
- Without the import, a note says TPMS wasn't checked.

*Mail drafts.* There is one HotCRP Mail-tool search per finding code: the space-separated paper numbers involved (e.g. `7 8 9 10`), to send to *Contact authors*. The integration test runs each search through `GET /search` and checks that HotCRP reads it as exactly those papers. Nothing is sent by the tool.

*DBLP lookup (optional, off by default).* `PCS_DBLP_ENABLED=true` is the **one outbound call besides `PCS_HOTCRP_URL`**, an explicit opt-in exception to §7 and AGENTS.md rule 4 that the chair enables.
- It sends only a public author name, as `GET <PCS_DBLP_URL>/search/publ/api?q=<name>&format=json&h=1000`. It never sends an email, title, abstract, review, or anything else from a submission.
- The response is Zod-parsed. A hit counts only when its author list contains the normalized name (DBLP's numeric homonym suffix is ignored), and hits are tallied per venue in `PCS_DBLP_VENUES`, matched case-insensitively against DBLP's venue string.
- Names looked up: designees, and the authors of papers that claim an exemption.
- At least `PCS_DBLP_SENIOR_MIN` papers (default 5) makes the hint read "possibly senior".
- Hints attach to designees and to an exempted paper's authors. They never create or remove a finding. Every hint's text says it is "a hint for a human, not a verdict: the name may match a different person", and the UI says the same.
- Lookups go through the `AuthorLookup` interface (`dblp.ts`): `dblpLookup()` is the real fetch implementation, and tests use a fake fetch or `staticLookup()`. No test calls the network.
- A process-lifetime `HintCache` rate-limits lookups to `PCS_DBLP_RPS` (default 1/s). The server answers at once with the hints it has and queues the rest in the background (`dblp.pending`; the view refetches while lookups are pending). `pcs reserve` waits for all lookups (`--no-dblp` skips them).
- A failed lookup gives no hint and is counted in `dblp.failed`.

*Output.* `{ papers[], designees[], findings[], mailDrafts[], counts, dblp, notes }`, where each finding is `{ code, severity, pids, emails, reason }` and the reason carries the numbers and the `PCS_*` setting involved. The CLI prints counts, reasons, and searches. It never prints titles or the self-declared seniority text (the API and view show those to the chair).

**B. Quick-reject / desk-reject tracker**
- A queue of `paper → signals (refcheck, AC flag, quick-reject review verdict) → AC decision → chair action → appeal status`.
- Quick-reject reviews are a dedicated review round, tracked against `QUICKREJECT_DUE`.
- Evidence is stored with each item. An appeal state is required.

**Implemented (M11): `server/src/modules/quickreject/`, `pcs quickreject`, `GET /api/quickreject`, *Modules → Quick reject*.**

The tool stays **read-only**. AC decisions, chair actions, and appeals are what the chair and ACs record in HotCRP as **paper tags**, plus the HotCRP decision; the tracker reads them after each sync.

*Tag vocabulary* (`PCS_QR_TAGS`, `key=tag` overrides; each state needs its own tag). The AC flag is `PCS_QR_AC_FLAG_TAG`, default `qr-flag`. Tags are matched case-insensitively, ignoring a `#value`.

| Key | Default tag | Meaning |
|---|---|---|
| `ac-reject` / `ac-keep` | `qr-ac-reject` / `qr-ac-keep` | the AC's decision |
| `chair-desk-reject` / `chair-keep` | `qr-chair-desk-reject` / `qr-chair-keep` | the chair's action |
| `appeal` | `qr-appeal` | the authors appealed |
| `appeal-upheld` / `appeal-overturned` | `qr-appeal-upheld` / `qr-appeal-overturned` | the appeal's outcome |

*Signals* (each carries its evidence, never text):
- `refcheck`: the latest `refcheck` import as of the app clock has a row for the paper with `hallucinated_refs ≥ PCS_REFCHECK_HALLUCINATED_MIN` (default 1) or `in_field_refs < PCS_REFCHECK_IN_FIELD_MIN` (default 1, i.e. "no in-field references"). Evidence: run id and counts. The importer's `note` is not shown.
- `ac-flag`: the paper carries `PCS_QR_AC_FLAG_TAG`.
- `qr-verdict`: at least one submitted (`delivered`/`approved`/`complete`) non-meta review in round `PCS_QR_ROUND` (default `quickreject`) votes reject, meaning its `PCS_QR_FIELD` value (default `PCS_FIELD_MERIT`) is at most `PCS_QR_REJECT_MAX` (default 1). Unsubmitted and unscored reviews don't vote. Evidence: the voting review ids, votes, and submitted/assigned counts.

*Queue.* A paper is an item when it has at least one signal or any quick-reject state tag. Each item has:
- `acDecision` (`none`|`reject`|`keep`), `chairAction` (`none`|`desk-reject`|`keep`), and the HotCRP `decision`;
- `appealState`, always present: `none`, `requested` (`appeal` only), `upheld`, or `overturned`. An outcome tag implies an appeal was filed.
- `stage`, whose move it is: `appeal` while an appeal is requested; else `done` once there's a chair action or an appeal outcome; else `chair-action` after an AC reject; else `done` after an AC keep; else `ac-decision`;
- `stateTags` (the vocabulary tags present), `signals`, the quick-reject `reviews`, the paper's ACs (`PCS_AC_ROLE`), and `warnings`:
  - `CONFLICTING_TAGS`: both tags of a pair are present (the reject/desk-reject/upheld one wins).
  - `DECISION_MISSING`: a desk reject (not overturned) whose decision isn't in `PCS_QR_REJECT_DECISIONS` (default `Rejected`).
  - `DECISION_STILL_REJECT`: an overturned appeal whose decision is still a reject.
  - `APPEAL_WITHOUT_DESK_REJECT`: an appeal tag without a desk reject.

*Evidence* is attached to each item when the report is computed from the store and imports. Both are versioned (snapshots and import runs), so an item's evidence names the import run and the review ids it rests on.

*Deadline.* With `PCS_PHASE_QUICKREJECT_DUE` set, every quick-reject review not submitted when `now > QUICKREJECT_DUE` is listed as overdue, with days overdue, whether or not its paper is queued. Without the date, nothing is overdue and a note says so.

*Mail drafts.* Two HotCRP Mail-tool searches (paper numbers): one for the papers with overdue quick-reject reviews (*Reviewers with incomplete reviews*), and one for the items awaiting an AC decision (to their ACs).

*Review slots.* `PCS_QR_EXCLUDE_FROM_SLOTS` (default `true`) leaves non-meta reviews in `PCS_QR_ROUND` out of the review slots. In practice:
- The rules snapshot (`buildSnapshot(..., { excludeRounds })`) leaves them out, so `MISSING_REVIEWS`, the overview counts, and reviewer metrics don't count them.
- The assignment validator's current assignment (§10.4 C composition and load bands) leaves them out too.
- Metareviews in the round are kept. The golden tables are unchanged, since golden has no rounds.
- `false` restores M4/M10 behavior.

**Module status.** Each module response carries `module`: the current extended phase, whether the module is active (`MODULE_PHASES`, M9), and the window its phases span under the configured dates (`modules/status.ts`). It is `null` when none of its phases has a date, e.g. A or B with only the MVP dates set.

*Seeded scenario* `registration` (`seed/scenarios/registration/`, `expected.ts`): papers #1–#12 plant the reserve problems (with a clean control); #13–#21 hold queue items in every stage and appeal state, an overdue quick-reject review, and a clean control. Fixtures: `tpms-registrations.csv` and `refcheck.csv`. The scenario adds `Paper.tags` to the seeder format, set through `batch/assign.php` `tag` lines.

**C. Assignment validator** (the highest-value module)
- **Composition** per paper, from the policy env vars: `PCS_POLICY_MIN_SENIOR` (2) and `PCS_POLICY_THIRD_SLOT` (`exactly1`|`atleast1`). Flag papers with all-junior panels, a missing senior, or a missing third slot.
- **Load bands per tier:** `PCS_LOAD_<TIER>_MIN/_MAX`.
- **Conflict sanity:** same affiliation, DBLP co-authorship (optional), and **reciprocal cycles**. Because reserve reviewers are authors, detect 2-cycles (and short k-cycles, `PCS_CYCLE_MAX_K`) in the graph whose edges run from an author of paper P to a reviewer of paper P. These are surfaced for human review, never auto-acted on.
- **TPMS round-trip:** validate an imported TPMS assignment CSV *before* it reaches HotCRP; emit a corrected HotCRP assignment CSV (seniors first, then the third slot).
- Reserve candidates must be AC-approved in the `invites` import and absent from `do-not-invite` before they appear in any generated assignment.
- **TPMS cannot enforce tier composition.** It maximizes affinity under per-reviewer load balancing only, and specific requirements "don't work well with TPMS assignments" (OOPSLA 2023 notes). TPMS also readily assigns undeclared conflicts, so the conflict cross-check above is mandatory. **We build our own solver** (§10.5), and TPMS output becomes one input to it: scores if available, otherwise its assignment as a warm start that gets validated.
- **Cold-start reviewers** (no TPMS profile, which is common for junior PC members) can get local affinity scores from **openreview-expertise** (SPECTER2/MFR). It runs entirely on our machine using titles and abstracts. Its hosted API is **not** allowed, because it would send submissions to a third party.

**Implemented (M10): `server/src/modules/assignment/`, `pcs validate-assignments [--tpms] [--out fixup.csv]`.**

*Inputs.* Everything comes from the local store and the imports, never from HotCRP directly: live papers with their authors (email, affiliation; store migration 4, synced from `GET /papers`), people with tier and affiliation (`/pc`), current review assignments with their review's status, area chairs per `PCS_AC_ROLE`, and the latest `invites`, `do-not-invite`, and (with `--tpms`) `tpms-assignments` imports as of the app clock. The assignment being validated is either the current HotCRP one (default) or the TPMS proposal (`--tpms`).

*Tiers.* A reviewer's tier is `PCS_TIER_TAGS` applied to their user tags (§10.2), else `senior`. Seniors fill the senior slots. Every other tier (`junior`, `reserve-active`, `reserve-pool`, or a custom one) fills the third slot. Load bands exist for `senior`, `junior`, `reserve-active`, and `reserve-pool`. A PC member with no review rows at all can't be tiered through the API (§1), so they count as senior.

*Review slots.* Only `primary`, `secondary`, and `pc` review assignments count. Metareviews (ACs) and external reviews don't, and neither do assignments in the quick-reject round while `PCS_QR_EXCLUDE_FROM_SLOTS` is on (M11, §10.4 B).

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

**Implemented (M12): `server/src/modules/tier-progress/` (D), `server/src/modules/early-reject/` (E), `pcs tier-progress`, `pcs early-reject`, `GET /api/tier-progress`, `GET /api/early-reject`, and the "Modules" views `/modules/tier-progress` and `/modules/early-reject`.**

Both modules are pure functions over the rules engine's snapshot view (§4, `views/snapshot.ts`), plus two indexed store reads (`paper_author` and the review `first_seen_approx` flags). They are read-only and never call HotCRP. Their output holds pids, titles, emails, scores, and counts, but never review or comment text. The CLI prints no titles either.

*D: shared definitions.*
- A **reviewer review** is not a metareview and is not held by one of the paper's ACs (as in §5c). Its tier is the reviewer's tier (§10.2).
- **Outstanding** means not submitted, on an undecided paper. Decided papers, e.g. early-rejected ones, are left out of outstanding and late.
- **Assigned after the deadline** means the review was first seen by a sync after `REVIEW_DUE`, and not at the first sync (whose first-seen times are best guesses). Such a review is a replacement: it counts as outstanding but never as late.
- **Late** means outstanding, `now > REVIEW_DUE`, and not assigned after the deadline. Its lateness is `now − REVIEW_DUE` in days.
- **Submitted late** means the first submitted version was after `REVIEW_DUE`. The version time is HotCRP's `modified_at`, else when a sync saw it.

*D: outstanding and late by tier.* One row per tier, in this order: `senior`, the `PCS_TIER_TAGS` tiers (empty ones included), then any other tier seen. Each row has reviewers, assigned, submitted, outstanding, late, the people with a late review, submitted late, and assigned after the deadline, plus a reason string with the numbers.

*D: reserve dropout.* This covers every late review by a `PCS_RESERVE_TIERS` reviewer (default `reserve-active,reciprocal`). Each gets one escalation state, and the first match wins:
1. `replaced`: another reviewer review on the paper was first seen after `REVIEW_DUE` and at or before now, with a non-approximate first-seen time. Someone was added after they went late.
2. `replacement-needed`: lateness `> PCS_RESERVE_DROPOUT_DAYS` (default 3).
3. `pinged`: a published, non-response comment on the paper @mentions them. It was posted at or after `REVIEW_DUE` and at or before now, by one of the paper's ACs or by a chair.
4. `late`: none of the above.

All four states come from synced data. A reminder sent through HotCRP's Mail tool is invisible (§1), so it is not a ping. A late review that is later unassigned leaves the list.

*D: reserve accountability.* There is one row per `PCS_RESERVE_TIERS` person with a reviewer review, sorted by email (never ranked). It shows their own live papers (`paper_author` by email, synced from `GET /papers`) next to their review record:
- assigned and submitted;
- late: outstanding now, plus submitted after the deadline;
- thin: submitted reviews under `PCS_THRESH_MIN_WORDS`;
- rated short and rated vague.

The UI and API say that this is evidence for a human decision about consequences, and that the tool decides and applies nothing.

*D: coaching queue.* This lists the submitted reviews by `PCS_COACH_TIERS` reviewers (default `junior`) with fewer than `PCS_COACH_MIN_WORDS` words (default `PCS_THRESH_MIN_WORDS`), or rated short or vague. Rows are sorted by pid, then email. Each row links to the review in HotCRP (`/review/{pid}{ordinal}`, or `/review?p=&r=`), where the coaching happens as comments.

*D: withholding reviews* (`PCS_POLICY_WITHHOLD_REVIEWS`, default `false`). With the policy on, every reserve reviewer with a late review gets a row: the late pids and their own undecided papers. A replaced review is still owed, so it counts. The HotCRP-side change is drafted as a bulk-assignment CSV `paper,action,tag` that tags those papers `PCS_WITHHOLD_TAG`, plus a search. The tool never applies it. HotCRP has no per-paper "withhold reviews" switch, so the note tells the chair to use the tag with HotCRP's own visibility settings, or to act by hand. With the policy off, nothing is drafted.

*D: participation by tier (§10.4 F).* Each tier gets M4's reviewer metrics (§5a participation since `DISCUSSION_OPEN`) summed: papers, papers with a comment from the reviewer, and the share. Before discussion opens, the row also counts the published non-response comments by the tier's reviewers on papers they review, up to now, and how many of those reviewers commented.

*E: review state as of an instant T.* This is the review's latest observed version with time `≤ T`, where the version time is HotCRP's `modified_at`, else when a sync first saw it. A review with no version by T didn't exist yet. "Merits as of T" are the merits of reviewer reviews submitted as of T. The result is the same at any `PCS_NOW`, whenever the syncs ran, as long as one of them saw each version. With no sync at or before `OPEN`, the earlier versions are unknown unless `pcs backfill` ran, and the report says so (`syncAtOpen`).

*E: band and candidates.* Under `reject_only`, every merit must be `≤ PCS_MERIT_REJECT_MAX` (default 1, the bottom of the default scale). Under `include_weak_reject`, every merit must be `≤ PCS_MERIT_WEAK_REJECT_MAX` (default `PCS_MERIT_ACCEPT_MIN − 1`). A paper is a **candidate as of T** when all of these hold:
- it is undecided as of T: no decision, or one the sync first saw after T;
- it has at least `PCS_EARLYREJECT_MIN_REVIEWS` merits as of T (default `PCS_REVIEWS_REQUIRED`);
- every one of those merits is in the band.

*E: the window.* `OPEN = PCS_PHASE_EARLYREJECT_OPEN`. `CLOSE = PCS_PHASE_EARLYREJECT_CLOSE`, or `OPEN + PCS_EARLYREJECT_WINDOW_H` when only `OPEN` is set (§10.1). With `OPEN` unset, the status is `unconfigured`. Otherwise:

| `now` | status | candidates as of | outcomes as of |
|---|---|---|---|
| `< OPEN` | `before` | now (provisional) | none |
| `OPEN ≤ now ≤ CLOSE` | `open` | `OPEN` | now ("so far"); at `CLOSE` exactly, the final report |
| `> CLOSE` | `closed` | `OPEN` | `CLOSE` (nothing after it counts) |

*E: outcomes.* Let E = min(now, CLOSE).
- **Bumped**: at least one reviewer's merit as of E is higher than as of `OPEN`. Any raise counts, even one that stays in the band; `stillInBand` reports whether the paper left it. A lowered merit, or a review first submitted during the window, is not a bump. Such a review shows up as a signal (`newReviewsInWindow`).
- **Not bumped**: the other candidates.
- **No response**: for each reviewer with a merit as of `OPEN` on a candidate, neither of these happened: a merit change in either direction, in a version with time in `(OPEN, E]`; or a published non-response comment by them on that paper, with time in `[OPEN, E]`. A comment's time is the earliest known (§4). Comments before `OPEN` don't count.

*E: discussion signals per candidate.* Published non-response comments up to E (or now, before the window): how many were posted during the window, how many were by ACs, and the latest one's time. Also: reviewer reviews outstanding as of the candidate instant, and reviews first submitted during the window.

*E: mail draft* (the app never sends mail). The search is the candidates' pids, space-separated: a HotCRP paper-number search, verified against the harness. The draft includes a Mail-tool path (`/mail?to=crev&t=s&q=…`, recipients "Reviewers with complete reviews"), and a subject and body that use HotCRP's `{{NUMBER}}`/`{{TITLE}}`/`{{NAME}}` mail keywords. The body names `PCS_EARLYREJECT_WINDOW_H` and the close time, and asks reviewers who agree with the early reject to say so in a comment, so that silence can be read as "no response".

*Phase activation.* The views and routes work at any instant. `activeModules()` (§10.1) still decides when the modules are relevant: D from `before-review-due` through `response`, E during `early-reject`.

*Tests.* Unit tests in `server/test/unit/modules/` (every state and boundary, at instants before, during, and after the window) and `server/test/unit/server-progress.test.ts` (routes and CLI renderers: no text, no token). The `earlyreject` integration test in `seed/test/integration/` checks `seed/scenarios/earlyreject/expected.ts` exactly. It seeds stage 1, syncs at `OPEN`, seeds stage 2, syncs at `CLOSE`, then checks the candidates per policy, the bumped / not-bumped / no-response lists at close and during the window, and the tier-progress outputs (late by tier, dropout states at both instants, accountability, coaching, withhold, participation). The e2e spec `e2e/specs/tier-progress.spec.ts` covers the views on golden.

**F. Discussion and decisions:** §5, plus tier-aware participation (do junior reviewers comment?).

**G. Process report** (after the conference)
- Junior vs. senior depth, timeliness, **rating-flag distributions** (flags received per review, by tier), and score agreement.
- Reserve activation and dropout rates; early-reject yield; quick/desk-reject counts and appeals.
- A carry-forward export of the do-not-invite list.
- **Pseudonymous IDs** (a keyed HMAC of the email, with a chair-held key, `PCS_PSEUDONYM_KEY`) on every exported row, so the data could join a future cross-conference baseline without exposing identities.

**Implemented (M13): `server/src/modules/report/`, `pcs report [--do-not-invite <file.csv>]`, `pcs export --out <dir> [--zip]`, `GET /api/report`, `GET /api/report/export.zip`, `GET /api/report/export/<file>`, `GET /api/report/do-not-invite.csv`, *Modules → Report*.**

*When.* `activeModules()` puts G in `after-decisions`, but the report works at any instant. Before that phase it says it is **provisional** (`final: false`); after it, it is the final report. Like D and E, it is a pure function over the rules engine's snapshot view, M12's tier-progress and early-reject reports, M11's quick-reject tracker, the imports, and two indexed store reads (review ratings and first-seen flags). It never calls HotCRP.

*Definitions.* A **reviewer review** is as in D (not a metareview, not held by one of the paper's ACs); its tier is the reviewer's. Tiers appear as `senior`, the `PCS_TIER_TAGS` tiers, then any other tier seen.
- **Depth:** words in submitted reviewer reviews: median, p25/p75 (nearest rank), mean, the count under `PCS_THRESH_MIN_WORDS`, and a histogram (0–99, 100–199, 200–399, 400–699, 700–999, 1000+).
- **Timeliness:** a review's submission time is its first submitted version (D's `submittedAt`). On time = at or before `REVIEW_DUE`; late = after it; reviews assigned after the deadline (D) are replacements and never late; not submitted. Plus the median of (submission − `REVIEW_DUE`) in days.
- **Merit distribution:** one bin per merit value, over the range seen in any tier, and the mean.
- **Review ratings:** for each HotCRP rating name (`/reviews` `ratings`), the submitted reviews carrying it (once per review).
- **Score agreement:** the paper mean is the mean of its submitted reviewer merits, on papers with at least 2. A merit's deviation is |merit − paper mean|; the table shows the mean deviation per tier. **Decision side:** a decision whose name starts (case-insensitively) with one of `PCS_REPORT_ACCEPT_DECISIONS` (default `accept`) is accept; any other decision is reject; none is undecided. A merit is on the decision's side when it is ≥ `PCS_MERIT_ACCEPT_MIN` on an accepted paper or below it on a rejected one.
- **Reserve activation and dropout** (from D): active = people in a `PCS_RESERVE_TIERS` tier; pool = people in `reserve-pool`. With an `invites` import, activation is the share of AC-approved candidates with `activated_at`; without one, active / (active + pool). Pool members with no review rows are invisible to the sync (§10.2, store README), so the invites import is the better source. Dropout = (not submitted + submitted late) / assigned over reserve reviewer reviews, plus D's escalation-state counts for reserve reviews that are late now.
- **Early-reject yield** (from E): candidates, bumped, not bumped, and how the candidates ended by their current decision (rejected, accepted, undecided). Yield = rejected / candidates.
- **Quick/desk reject** (from B, `summarizeQuickReject`): papers in the queue, AC reject, desk-rejected by the chair, kept (by the chair, or by the AC when the chair hasn't acted), quick-reject reviews assigned / submitted / overdue, and appeals filed (= requested + upheld + overturned), upheld, overturned, pending (= requested).

*Small cells.* The report lists no people, only aggregates, but a small group's aggregate can still point at one person (a tier with two reviewers, say). So in every per-tier table and in the reserve section, a group with fewer than `PCS_REPORT_MIN_CELL` (default 5) distinct people is **suppressed**: its numbers, the people count included, are `null`, `suppressed` is true, and the reason and the UI say "fewer than N people; withheld". Paper counts (totals, early reject, quick reject) describe papers, not people, and are shown as they are. The report JSON, page, and CLI carry no emails, names, titles, or text; tests scan them for the scenario's names, emails, titles, and affiliations.

*Pseudonymous export* (`pcs export`, the Export button). Every person column holds `HMAC-SHA256(PCS_PSEUDONYM_KEY, email)` in hex, where the email is normalized (Unicode NFC, trimmed, lowercased). The result is stable for a key and different across keys. Paper ids are a 16-hex HMAC of the paper number, unique within one export only. `PCS_PSEUDONYM_KEY` (at least 16 characters) is needed only for the export. Without it, the CLI exits 1, the routes answer 409, and both explain how to set the key; the report itself still works. `manifest.csv` carries `key_id`, a 12-hex public fingerprint of the key, so two exports can be checked for the same key without revealing it. Whoever holds the key can recompute the pseudonym of an email they already know; that is what lets a later chair join their export to this one, and it is why the key stays with the chair.
- Files: `reviews.csv` (one row per reviewer review: reviewer, paper, tier, role, submitted, merit, expertise, words, rated short/vague, rating count, days vs `REVIEW_DUE`, submitted late, assigned after the deadline, paper mean merit, deviation, decision side, on the decision's side, early-reject candidate), `reviewers.csv` (one row per reviewer: tier, assigned, submitted, late, not submitted, median words, mean deviation, on-side share, rated short/vague, comments and papers commented on papers they review), `manifest.csv`, and `README.txt` (column docs, no data). The zip holds all four.
- **No emails, names, titles, or text, by construction.** Every column has a declared kind (pseudonym, paper id, integer, decimal, boolean, or enum), and there is no free-text kind. The writer validates every cell against its column and throws, without echoing the value, on anything else. Tier names are written only if they are plain tokens (`[a-z0-9_-]`) held by at least `PCS_REPORT_MIN_CELL` reviewers; other tiers are written as `other`, so a pseudonym in a tiny tier can't be singled out. Times are days relative to `REVIEW_DUE`, never timestamps. Tests scan every cell for `@` and for every name, email, title, and affiliation in the scenario (unit, `shadow` integration, `scale`, and e2e).
- Rows are ordered by pseudonym, so their order reveals nothing.

*Do-not-invite carry-forward.* The spec asks for pseudonyms on rows exported **for the cross-conference baseline**. The do-not-invite list isn't baseline data: it is the chair-to-chair list, keyed by email (§10.3), and the next chair can only act on it with emails (C checks candidates by email). Pseudonymizing it would make it useless unless both chairs shared the key. So it keeps emails and is **not** part of the pseudonymous export: `pcs report --do-not-invite <file.csv>` (written mode 0600) and `GET /api/report/do-not-invite.csv` write the latest `do-not-invite` import as `email,reason,source`, which `pcs import do-not-invite` reads back unchanged. Hand it over privately.

*Downloads.* The browser downloads from the local server (`Content-Disposition: attachment`); nothing is uploaded anywhere, and the export makes no network calls. The zip is written by a ~70-line writer (`zip.ts`, deflate via `node:zlib`), so no dependency was added.

*Tests.* Unit tests: `server/test/unit/modules/report.test.ts` covers every metric and the small-cell rule at its boundary. `server/test/unit/report-export.test.ts` covers the pseudonyms (stable per key, different across keys), the key check, the structural cell validator, the `other` tier, the zip, the do-not-invite round trip, the routes (409 without a key; no token, key, or names), and the CLI renderer. The `report` integration test in `seed/test/integration/` seeds `shadow` on the harness, syncs, and renders the report (provisional and after decisions) and the export. `npm run test:scale` (`e2e/scale/run.ts`) does the same over `scale` (2,400 papers) with time budgets. The e2e spec `e2e/specs/report.spec.ts` checks the page on golden: every section, small tiers withheld, the zip download.

### 10.5 Assignment solver (port of HotCRP's autoassigner)

**Why a port:** HotCRP's min-cost max-flow (`lib/mincostmaxflow.php`: push-relabel max flow, then cost-scaling push-relabel, with **edge lower bounds**) and its network construction (`src/autoassigner.php`) are well documented, compact (~2.6k lines of PHP), and MIT-style licensed. Keep the copyright notice in ported files. Running it ourselves lets us add the constraints HotCRP and TPMS lack, and keep scores local.

**Network** (one solve, exact and integral, because tiers partition reviewers):

```
source ──(cap = load band max, convex cost for balance)──► reviewer r (tier t)
reviewer r ──(cap 1, cost = −affinity(r,p); omitted if conflicted / do-not-invite / unapproved reserve)──► p.t   (p's node for r's tier)
p.senior ──(cap = PCS_POLICY_MAX_SENIOR, lower bound PCS_POLICY_MIN_SENIOR)──► p
p.third  ──(cap 1, lower bound 1 if PCS_POLICY_THIRD_SLOT=exactly1)──► p      (junior + reserve-active feed p.third)
p ──(cap = reviews per paper)──► sink
```

- **Soft first, hard optionally.** Hard lower bounds make the whole solve infeasible if a single paper can't be staffed (e.g. too few unconflicted seniors in its area). The default models each required slot as an edge with a large negative cost (`PCS_SOLVER_SLOT_BONUS`), so the solve always succeeds, and every unmet requirement is reported per paper. This is the same technique as HotCRP's expertise gadget. `PCS_SOLVER_HARD=1` switches to true lower bounds.
- **Load balance:** convex per-reviewer costs on the source edges, as in HotCRP (`paper_assignment_cost × i`), so loads spread within each band.
- **Fixed assignments** (already-made reviews, quick-reject reviews, AC-chosen reserves) are pinned with lower bound 1.
- **Affinity sources, in priority order:**
  1. the `tpms-scores` import;
  2. local openreview-expertise scores (SPECTER2/MFR);
  3. HotCRP preferences, expertise, and topic scores (`get/allrevpref`).
  Sources are normalized to one integer scale, with weights in env.
- **Scale:** ~600 reviewers + ~7.2k paper/tier nodes. Edges are pruned to the top `PCS_SOLVER_TOPK` (default 60) candidates per paper, plus all pinned edges, giving ~150k edges. Use typed-array adjacency (`Int32Array`); the target is under 30 s for a full 2,400-paper solve.

**What flow can't express, handled by repair passes** (each reports what it changed):
- **Reciprocal cycles.** These are pairwise, not flow constraints. Detect 2- and short k-cycles in the assignment's author→reviewer graph; forbid the lowest-affinity edge of each cycle; re-solve warm. Repeat until clean, or until the cap is hit, then report the rest.
- **Second partitions** (e.g. at most one reviewer per institution per paper, crossing tiers): the same forbid-and-re-solve loop. FairIR (openreview-matcher, run locally) remains the fallback if those constraints become central.

**Outputs:**
- a HotCRP bulk-assign CSV (`paper,action,email,round`), always applied by a chair through HotCRP with a dry run first;
- a solve report: objective value, per-paper unmet requirements, load histogram by tier, repairs made, and the affinity coverage (papers whose best candidates are weak).

**Correctness:** the port is **differentially tested against HotCRP's PHP implementation**. For random instances with no tier gadget, our min-cost-flow cost must equal `MinCostMaxFlow` run inside the harness container. Tier and repair behavior gets its own property tests:
- every paper meets its composition, or it's reported;
- no reviewer exceeds their band;
- no conflicted edge is ever used.

**Implemented (M10a): the solver core, `server/src/modules/solver/mcmf.ts`** (ported from hotcrp@60f693f8, with HotCRP's notice).
- **API:** `const g = new MinCostMaxFlow()`; node 0 is `g.source`, node 1 is `g.sink`; `g.addNode()` / `g.addNodes(k)` return indices; `g.addEdge(src, dst, cap, cost = 0, minCap = 0)` returns an edge index (parallel edges allowed, which is how convex load costs are built). `g.solve()` returns `{ feasible, maxFlow, cost, flows: Int32Array /* per edge */, precisionLimited, unmet, stats }`. Infeasible lower bounds come back as `feasible: false` plus `unmet: [{ node, need: "inflow" | "outflow", amount }]`; they never throw. Malformed input (self-loops, edges into the source or out of the sink, non-integers, minCap > cap) throws `RangeError`.
- **Re-solve (repair loop):** `g.forbid(e)` (capacity and lower bound 0) or `g.setCapacity(e, cap, minCap)`, then `g.solve()` again. Every solve is a full solve from scratch, with no warm start. That is fast enough: about 1 s per solve at full scale. Same network, same flows (deterministic, no shuffling).
- **Numbers:** capacities and flows are Int32, and costs are integers with |cost| ≤ 2³¹−1, stored as Float64. `solve()` rejects Σ cap·|cost| > 2⁵³ so the total is exact. Prices are floats, as in PHP. `precisionLimited` (an epsilon-optimal stop) cannot occur for |cost| ≤ 10⁶ at this scale.
- **Algorithm:** HotCRP's relabel-to-front push-relabel, then cost-scaling push-relabel (α = 12, lookahead, bucket repricing, arc fixing), in PHP's vertex and edge order. Worst case O(V³) for the max flow plus O(V²E log(VC)) for the cost scaling.
- **Differences from PHP.** The differential test found two defects in HotCRP's code; neither affects HotCRP's own autoassigner networks.
  1. Its global-relabel BFS relabels the source, so on general graphs the "max" flow can fall short. We keep the source at |V| and add the standard second BFS from the source.
  2. When the starting flow leaves a lower-bound deficit at a vertex (e.g. hard `p.senior → p` minimums), PHP returns a non-conserving flow or never terminates. We first run a feasibility phase (the textbook circulation reduction, using the same push-relabel code) and start from its flow.
  `{ hotcrpCompat: true }` restores PHP's max-flow phase, for the differential test only.
- **Tested equivalence:** `server/test/integration/mcmf-differential.test.ts` runs 400 seeded instances through HotCRP's PHP class in the harness (`seed/php/mcmf-driver.php`, batched on stdin). The mix is two-layer, general, and tier-gadget networks; 184 of them have lower bounds. Results:
  - 301 agree exactly on max flow, min cost, and feasibility (244 feasible, 57 infeasible).
  - 12 hit PHP's short max flow, and 87 hit PHP's deficit defect. In each of these, our result matches the reference solver.
  - In compat mode, PHP's flows are reproduced edge for edge (242/242).
  A unit property test checks 600 instances against an Edmonds-Karp + cycle-canceling reference. The perf test (`test/unit/solver/mcmf-perf.test.ts`) runs the spec network at 2,400 × 600, top-60: 7.8k vertices, 160k edges. It takes 1.9 s soft and 1.0 s hard on a 4-core machine, against a 30 s budget.

**Implemented (M10b): the assignment network, `server/src/modules/solver/` (`solve.ts`, `affinity.ts`, `load.ts`), `pcs solve-assignments`, `GET /api/assignment`, `GET`/`POST /api/assignment/solve`, *Modules → Assignment* and *Modules → Solver*.**

*Inputs.* M10's `loadValidatorInput` supplies live papers with authors, people with tiers and affiliations, current slot-filling assignments with their review status, and the latest `invites` and `do-not-invite` imports. `scoresAsOf` supplies the merged `tpms-scores` + `affinity-local` matrix. Two read-only HotCRP downloads are made on demand and never stored: PC conflicts (`get/pcconf`, `t=all`) and, unless `PCS_SOLVER_W_HOTCRP=0`, review preferences. Assignments in the quick-reject round don't fill slots (`PCS_QR_EXCLUDE_FROM_SLOTS`, as in M10). They are never candidates and never appear in the CSV.

*HotCRP preferences.* The request is **`GET /api/searchaction?action=get/allrevpref&q=all&t=all`** (`HotcrpClient.allRevPrefs`, `AllRevPrefSchema`, contract test `test/contract/allrevpref.test.ts`). It returns HotCRP's "PC review preferences" CSV and needs a manager token; a scoped token also needs `preference:read`. The header is `paper,title,given_name,family_name,email,conflict,preference[,expertise][,topic_score]`. HotCRP adds the `expertise` column only if some preference carries an expertise, and `topic_score` only if some PC member declared a topic interest. There is one row per (paper, PC member) pair that has a nonzero preference, an expertise, a nonzero topic score, or a conflict. Other pairs have no row. `conflict` is `conflict` or empty, and author conflicts appear there too. `expertise` is `X`, `Y`, or `Z`.

*Affinity.* For each pair, the first source that scores it wins: TPMS, then local, then HotCRP. The integer affinity is `round(PCS_SOLVER_AFFINITY_SCALE × weight × score)`, using the source's weight (`PCS_SOLVER_W_TPMS`, `_W_LOCAL`, `_W_HOTCRP`; defaults 1, 1, 0.5). A HotCRP row maps to a 0–1 score as follows (`hotcrpScore`):
- start at 0.5;
- add ±0.3 for the preference, at full strength when it reaches ±`PCS_SOLVER_PREF_SCALE` (default 20);
- add ±0.1 for expertise X or Z;
- add ±0.1 for the topic score, at full strength when it reaches ±10;
- clamp the result to 0–1.

An unscored pair has affinity 0.

*Network* (built once per solve, over M10a's `MinCostMaxFlow`):

```
source ──(c_r)──► R_r ──(c_r unit edges: cost (i−1)·LOAD_COST, − LOAD_MIN_BONUS while i ≤ band min)──► L_r ──(cap 1, −affinity)──► p.senior | p.third
R_r ──(c_r, cost 0)──► sink                                   (bypass)
p.senior ──(MIN_SENIOR, −SLOT_BONUS)──► p,  ──(MAX_SENIOR − MIN_SENIOR, 0)──► p
p.third  ──(1, −SLOT_BONUS)──► p
p ──(sum of the above)──► sink
```

- `c_r` is the reviewer's band maximum, raised to their pinned count if their pins exceed it. The convex unit costs follow HotCRP's autoassigner (`paper_assignment_cost × i`).
- **The bypass makes the max-flow phase moot.** The maximum flow is always Σ c_r, so cost alone decides what gets assigned. Without the bypass, MCMF's "maximum flow first" would force every optional slot (a 4th senior under `PCS_POLICY_MAX_SENIOR`) to be filled.
- **Optional seniors.** An optional senior slot is filled only when the reviewer's affinity outweighs their load cost. `PCS_POLICY_MAX_SENIOR` defaults to `PCS_POLICY_MIN_SENIOR`, which means no optional slots.
- **Hard mode.** With `PCS_SOLVER_HARD` (or `--hard`), the two required edges get lower bounds instead of bonuses. An unstaffable paper then makes the solve infeasible. The report lists the paper slots MCMF's `unmet` points at, and there is no CSV.
- **The third slot is required under both policies.** The validator flags a missing third slot under `atleast1` too, so the slot gets the bonus (or the lower bound) either way, and its capacity is 1. `atleast1` differs only in that the validator accepts extra pinned third-slot reviews.
- **Reviewer band minimum.** The minimum is always soft (`PCS_SOLVER_LOAD_MIN_BONUS`, default 10,000, below `PCS_SOLVER_SLOT_BONUS`, default 100,000). Underloads show up in the load histogram.

*Eligibility.* There is an `L_r → p.t` edge only if all of these hold:
- r is an assignable PC member: on the PC, not a chair or AC, and in a tier with a `PCS_LOAD_*` band whose maximum is above 0. A custom tier without a band gets a note.
- r is not an author of p.
- r has no conflict with p in HotCRP (`get/pcconf`, or the conflict column of `allrevpref`).
- r doesn't share a normalized affiliation with an author of p, when `PCS_CONFLICT_AFFILIATION` is on.
- r is not on the do-not-invite list.
- If r is in a `reserve-*` tier, r is approved for p in the invites import: `ac_decision=approve` and `response≠decline`.

Junior, reserve-active, and any other non-senior tier feed `p.third`.

*Pruning.* For each paper and slot class (senior, third), the solver keeps the `PCS_SOLVER_TOPK` best eligible candidates by affinity, plus every current unstarted assignment that is still eligible, plus every pinned edge. Ties, including all unscored candidates, are broken by a hash of (pid, reviewer), so they don't all go to the alphabetically first reviewer. At 2,400 × 600 with top-60 per class, that is 288k candidates and 306k edges.

*Pins* (lower bound 1):
- **Started reviews.** Their status is outside the validator's `CLEARABLE_STATUSES`, so they can't be cleared safely. An unstarted current assignment is a candidate, not a pin. The solver may drop it, and the CSV then clears it. This is how the planted cycles and overloads of the `assignment` scenario get fixed.
- **AC-activated reserves.** The invites import has `approve`, not `decline`, and `activated_at` set.
- **Current assignments of chairs and ACs** that the chair placed as reviewers.

A started review that is itself ineligible is kept and reported as a pin issue. An activation that is ineligible is not pinned and is reported: a do-not-invite entry, a conflict, or a candidate not yet on the PC.

*Repair passes.* After the first full solve, each round finds issues, forbids edges, and re-solves:
- **Reciprocal cycles.** M10's `findCycles` runs on the solved author → reviewer graph (`PCS_CYCLE_MAX_K`). Each cycle edge is a person edge a → b. For each cycle, the solver picks the edge whose current assignments have the lowest total affinity and include no pin. b loses those assignments, and every other candidate edge from b onto a paper by a is forbidden too, so the pair can't close the cycle again on another paper. Forbidding only the single assignment let the solver move b to a's next paper and needed many more rounds.
- **One reviewer per institution per paper** (`PCS_SOLVER_ONE_PER_INSTITUTION`, default on: cheap). Across tiers, the solver keeps the pinned or best-scoring reviewer of each normalized affiliation. The others go, and every other candidate from that affiliation on that paper is forbidden. An empty affiliation never matches.
- **Re-solves are warm.** Only the papers that lost an assignment are solved again. Every other paper's assignment stays fixed, and its reviewers' load carries over, so bands and convex costs stay exact. A warm round takes milliseconds; a full solve at scale takes about 4 s. In hard mode, if the warm subproblem is infeasible, the solver tries a full solve. If that is infeasible too, it undoes the round and reports the issues as unresolved.
- **Stopping.** Rounds repeat until both checks are clean or `PCS_SOLVER_REPAIR_MAX` rounds (default 10) have run. Whatever is left goes in `unresolved`, as do issues only pins could break.
- **Polish.** One final full solve runs with every forbidden edge removed. Its result replaces the warm-repaired one if it is cheaper and has no new cycle or clash. On random 40-paper instances, this happened in 7 of 60.

Each repair is reported as `{ round, kind, removed: [{pid, email, affinity}], forbidden, reason }`.

*Outputs* (`SolveReport`, `modules/solver/types.ts`):
- `objective`: the network cost of the final assignment, which is load costs − affinity − earned bonuses.
- `affinityObjective`: the same without bonuses.
- `unmet`: one entry per paper and slot, with `have`, `need`, the eligible count before pruning, and a reason. The reason is either "only N eligible candidates after conflicts, do-not-invite, and reserve approval" or "N eligible candidates, but their load bands (`PCS_LOAD_…_MAX`) are used by other papers", noting forbidden edges when repairs touched the paper.
- `load`: per tier, the band, the number of reviewers at each load (a histogram, never a ranking), and the under and over counts.
- `repairs`, `unresolved`, and `pinIssues`.
- `coverage`: papers whose best eligible senior or third-slot candidate scores below `PCS_SOLVER_WEAK_AFFINITY` (0–1, unweighted; default 0.3), with the count of assignments without a score.
- `assignments`, `cleared`, `csv`, and `lines`.
- `crossCheck`: see the cross-check paragraph below.
- `notes` and `timing`.

*Bulk-assign CSV.* The columns are `paper,action,email,round`, ordered by paper. For each paper the lines are:
1. `clearreview` for current unstarted assignments the solve dropped;
2. the seniors, then the third slot, by affinity.

A kept assignment keeps its current type (`primary`, `secondary`, or `pcreview`) and has an empty round. HotCRP's assignment parser keeps the existing round when the column is empty, so these lines are no-ops. A new senior is `primary`, a new third slot is `secondary`, and the round is `PCS_SOLVER_ROUND`, or empty for HotCRP's default. HotCRP takes `email` as the user column. The tool never applies the CSV; the integration test dry-runs it.

*Cross-check.* M10's `validate()` runs on the solved assignment, with source `"solver"`, judged like `"hotcrp"`. Each finding gets an `explainedBy`:
- composition findings, by the matching `unmet` entry;
- `LOAD_OVER`, by pins over the band;
- `LOAD_UNDER`, by the soft band minimum;
- `RECIPROCAL_CYCLE`, by an `unresolved` entry;
- conflict, reserve, and input findings, by a pinned pair.

Anything else is counted as `unexplained`. The tests require zero.

*Interfaces.*
- **CLI.** `pcs solve-assignments [--hard] [--out file.csv] [--report file.json]` prints the report and writes the CSV and the JSON report (0600). It exits 1 if the hard solve is infeasible or HotCRP can't be read.
- **`POST /api/assignment/solve`** (`{ hard?: boolean }`) runs the solver and caches the report in the server. It refuses foreign `Origin`s (403), runs one solve at a time (409), and answers 503 without a HotCRP client.
- **`GET /api/assignment/solve`** returns the cached report, or `report: null` before the first solve.
- **`GET /api/assignment[?source=tpms]`** routes M10's validator. It answers 404 with the import hint if there is no TPMS import.
- **Web views.** *Modules → Assignment* shows findings by check plus the fix-up CSV. *Modules → Solver* has the run buttons and shows the summary, unmet requirements, load table, repairs, coverage, cross-check, and CSV.

*Tests.*
- **Properties** (`test/unit/solver/solve.test.ts`, 40 random soft instances plus 15 hard ones from `test/support/solver-instances.ts`):
  - every paper meets its composition or is reported with a reason;
  - no band is exceeded except by pins;
  - no conflicted, author, same-affiliation, blocked, do-not-invite, or unapproved-reserve edge appears;
  - started reviews are kept;
  - every remaining cycle or institution clash is listed as unresolved;
  - the CSV keeps or clears every current assignment;
  - the cross-check has nothing unexplained.
  
  Hand-built cases cover the tier gadget, hard infeasibility, pins, repairs, the repair cap, institutions, source priority and weights, coverage, and the CSV round.
- **Done criterion** (`seed/test/integration/solver.test.ts`). It seeds the `assignment` scenario, imports its fixtures plus the synthetic `fixtures/tpms-scores.csv` (every PC reviewer × every paper; the current panel scores 0.90), and solves with live conflicts and preferences. It checks:
  - every paper meets its composition or is reported with a reason;
  - no band is exceeded;
  - there is no author, same-affiliation, do-not-invite (greta.holm on #6 is a reported pin issue), or unapproved-reserve edge;
  - the planted 2- and 3-cycles are broken;
  - the cross-check is clean;
  - the CSV passes `POST /assign?dry_run=1` and leaves HotCRP unchanged.
- **Perf** (`test/unit/solver/solve-perf.test.ts`). The instance has 2,400 papers and 600 reviewers (400 senior, 120 junior, 80 reserve-active), dense scores, PC authors, 200 affiliations, conflicts, pins, and activations. The run includes repairs and the cross-check: 8.4k vertices, 306k edges, about 90 repairs, and about 10 s in total (full solves of about 4 s, warm rounds of about 50 ms), against a 30 s budget.

### 10.6 Upstream HotCRP contributions (proposed as PRs, not a fork)
- An admin endpoint for the **action log**, and one for the **mail log**. Together they would make email reminders and assignment changes visible, closing the "nudges are invisible" gap in §1.
- `POST /reviews`: honor `override` for JSON bodies, not just text uploads.
- Search: accept `round:any` (pass `allow_generic` in `Review_SearchTerm::parse_round`), which `/searchcompletion` already suggests; and let `/api/search` take `tsoft`, so an explicit `t` can be widened by `in:` as on the search page.

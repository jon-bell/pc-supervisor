# Local store (`server/src/store/`)

An encrypted SQLite file (SQLCipher via `better-sqlite3-multiple-ciphers`) that holds
one HotCRP instance's snapshot history. `server/src/sync/` writes it; everything else
reads it through `openStore()`.

- **Path:** `PCS_DB_PATH`, default `~/.local/share/pc-supervisor/<host>.db`. The parent
  directory is created `0700` and the file `0600`. WAL mode, so `-wal`/`-shm` files sit
  next to it (same mode). `pcs wipe --yes` deletes all of them.
- **Key:** `PCS_DB_KEY`. A wrong key throws `StoreError` with `kind: "bad_key"` and a
  message that names neither key. Only `NODE_ENV=test` may run unencrypted.
- **Schema:** `migrations.ts`, forward-only and numbered by `PRAGMA user_version`. A DB
  from a newer build is refused (`kind: "newer_schema"`). Never edit a shipped migration;
  append one.

## Tables

All times are integer epoch seconds. `*_seen_at` comes from the app clock (`PCS_NOW`);
`modified_at` is HotCRP's. A `*_approx = 1` flag marks a best guess: items that already
existed at the first successful sync take HotCRP's `modified_at` (or the sync time) as
`first_seen_at`. The sync never deletes rows. Disappearances set `deleted_seen_at` or
`removed_seen_at`, and a reappearance clears it. Emails are lowercased.

| Table | One row per | Notes |
|---|---|---|
| `person` | email | PC roster (`is_pc`, `roles` JSON: `pc`, `chair`), plus any reviewer/commenter seen. `tags` is the queried user tags this person holds (tier tags and a `tag:` AC tag only); `tier` is the first `PCS_TIER_TAGS` tier whose tag they hold, else `senior`. `removed_seen_at`: left the PC. |
| `paper` | pid | `/search` t=all: title, status, decision (`null` = Unspecified), `decision_seen_at` (+`_approx`: when the sync first saw the current decision; migration 3), tags JSON. `lead`/`shepherd` emails from `get/lead`/`get/shepherd`. `manager` is resolved from `/search`'s display name against the roster, and left `null` with a sync warning if the name is ambiguous. |
| `assignment` | (pid, email, role) | role ∈ `meta primary secondary pc external` (from `get/pcassignments`) and `lead shepherd manager`. `removed_seen_at` marks an unassignment. |
| `review` | rid | Latest state: `rtype`, `status`, `vtag` (opaque; compare with `!==`), `modified_at` (null when HotCRP hides it), `scores` JSON (non-text fields by UID), `word_count` (local, over text fields), `ratings` JSON, `first_seen_at`, `first_complete_seen_at` (status `complete`/`approved`). |
| `review_version` | (rid, vtag) | `source` = `snapshot` (first seen by a sync; `seen_at` = sync time) or `history` (`pcs backfill`; `seen_at` = that version's `modified_at`, approximate, maybe null). `sync_run_id` = the run that wrote it. |
| `review_text` | (rid, vtag, field) | Text of each non-empty text field for each vtag. |
| `review_field` | field UID | The review form from `get/jsonrqc`: name, type, `is_text`, order, score labels. |
| `comment` | cid | Latest state plus `mentions` JSON, `word_count`, `text_hash`, `first_seen_at`, `deleted_seen_at`. `is_response` = author response. |
| `comment_text` | observed text version | A new row when `modified_at` or the text changes. |
| `comment_mention` | (cid, email) | Mentions, for SQL joins (indexed on email). |
| `sync_run` | run | `kind` `sync`/`backfill`, `now_used` (clock), `ok`, `counts` JSON, `errors` JSON (messages only, no content). |
| `history_backfill` | rid | Backfill progress (resumable). |
| `import_run` | `pcs import` | Imported local CSVs (spec §10.3, M9): `kind`, `file_sha256`, `file_name`, `imported_at` (clock), `row_count`. Rows go in `import_invite`, `import_tpms_assignment`, `import_tpms_registration`, `import_refcheck`, and `import_do_not_invite`, keyed by `run_id`, and are never updated. API: `server/src/imports/store.ts` (`runAsOf`, `rowsAsOf`, `diffRuns`). |
| `text_fts` | text row | Contentless FTS5 over `review_text` (rowid = id·2) and `comment_text` (id·2+1), maintained by triggers. |

Indexes: `pid` and `email` on review, comment, and assignment; email on `comment_mention`.

## Read API (`store.ts`)

```ts
import { openStore } from "@pcs/server/store/store";
const store = openStore(cfg);              // cfg.db.{path,key}; { readonly: true } for readers
store.papers({ pids?, includeGone? })      // PaperRow[]
store.people({ includeGone? })             // PersonRow[] with tier and tags
store.assignments({ pids?, roles?, includeGone? })
store.reviews({ pids?, includeGone? })     // ReviewRow[]: latest scores, complete, first-seen times
store.reviewsWithHistory({ pids? })        // + versions[] oldest first; version.at = modifiedAt ?? seenAt
store.reviewText(rid)                      // { [fieldUid]: text } for the current vtag
store.comments({ pids?, includeGone? })    // CommentRow[]: mentions (emails), wordCount, firstSeenAt(+Approx)
store.commentHistory(cid) / store.commentText(cid)
store.areaChairs(cfg.acRole, { pids? })    // [{pid, email}] per PCS_AC_ROLE (see below)
store.reviewFields()
store.lastSync() / store.lastSync("backfill") / store.lastSuccessfulSync()
store.searchText("baselines")              // FTS5 hits: {kind, pid, rid|cid, snippet}
store.db                                   // the better-sqlite3 handle, for SQL views (M4/M5)
store.close()
```

By default, list functions hide deleted and removed rows; pass `includeGone: true` to
get them. Pass `pids` to page by paper. `memoryStore()` gives an unencrypted in-memory
store for unit tests.

**Area chairs** (`PCS_AC_ROLE`):
- `meta`: reviewers holding a live rtype-5 review.
- `lead`, `manager`: the paper's lead or manager.
- `tag:<t>`: assigned reviewers on the paper who hold user tag `<t>`.

**Tiers:** a chair token can't read user tags from `/pc`. The sync asks
`/reviews?rq=re:%23<tag>` for each tier tag, which returns the reviews written by holders
of that tag. It asks only on a covering set of papers (`coverPids`: every PC reviewer from
`get/pcassignments` and every reviewer seen before has a review on one of them; ~240 of
2,400 papers at scale), and then on one paper each for any reviewer the cover missed. As a result, a tagged PC member with **no review rows** on any paper isn't
detected and counts as `senior`. The tag must also appear in `/pc`'s `tags` list (HotCRP
warns on unknown tags), or nobody gets that tier.

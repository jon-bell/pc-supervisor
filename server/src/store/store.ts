// Typed read API over the local store, for the server (M5) and the rules
// adapter (M4). See README.md in this directory. All queries are prepared
// once; list queries take an optional pid filter so callers can page by paper.

import type { AcRole, Config } from "../config.js";
import { parseRatings, ratingsEnabledFor, type RatingCounts } from "../ratings.js";
import { MEMORY, openDb, type Db } from "./db.js";

export type Score = number | string | null;

export interface PaperRow {
  pid: number;
  title: string | null;
  status: string | null;
  /** null = no decision ("Unspecified" in HotCRP). */
  decision: string | null;
  /** When the sync first saw the current decision (null if undecided). */
  decisionSeenAt: number | null;
  decisionSeenApprox: boolean;
  tags: string[];
  lead: string | null;
  shepherd: string | null;
  manager: string | null;
  firstSeenAt: number;
  deletedSeenAt: number | null;
}

export interface PersonRow {
  email: string;
  name: string | null;
  affiliation: string | null;
  isPc: boolean;
  roles: string[];
  /** The tier/AC user tags this person holds (only tags the sync asks about). */
  tags: string[];
  /** A PCS_TIER_TAGS tier name, or "senior". */
  tier: string;
  firstSeenAt: number;
  removedSeenAt: number | null;
}

export type AssignmentRole = "meta" | "primary" | "secondary" | "pc" | "external" | "lead" | "shepherd" | "manager";

export interface AssignmentRow {
  pid: number;
  email: string;
  role: AssignmentRole;
  round: string | null;
  firstSeenAt: number;
  firstSeenApprox: boolean;
  removedSeenAt: number | null;
}

export interface ReviewVersionRow {
  vtag: number;
  /** Sync time for snapshots; the version's modified_at for history rows (may be null). */
  seenAt: number | null;
  seenApprox: boolean;
  source: "snapshot" | "history";
  status: string;
  modifiedAt: number | null;
  scores: Record<string, Score>;
  wordCount: number | null;
  /** Best time estimate for this version: modifiedAt ?? seenAt. */
  at: number | null;
}

export interface ReviewRow {
  rid: number;
  pid: number;
  email: string;
  rtype: number | null;
  status: string;
  complete: boolean;
  round: string | null;
  ordinal: string | null;
  vtag: number | null;
  modifiedAt: number | null;
  firstSeenAt: number;
  firstSeenApprox: boolean;
  firstCompleteSeenAt: number | null;
  firstCompleteApprox: boolean;
  scores: Record<string, Score>;
  wordCount: number;
  /** Raters per flag (spec §1, ratings.ts). */
  ratings: RatingCounts;
  deletedSeenAt: number | null;
}

/** One observed change of a review's ratings (migration 5). */
export interface RatingChangeRow {
  rid: number;
  /** Sync clock time; ratings carry no HotCRP timestamp. */
  seenAt: number;
  /** null: the ratings at first sight of the review. */
  before: RatingCounts | null;
  after: RatingCounts;
}

/** HotCRP's review-rating settings as last synced (null: never synced). */
export interface RatingSettingsRow {
  /** `pc` | `all` | `no`. */
  setting: string | null;
  /** `limited` | `yes` | `no`. */
  visibility: string | null;
  /** False only when the instance has ratings off (`no`): rating signals are then hidden, not zero. */
  enabled: boolean;
}

export interface ReviewWithHistory extends ReviewRow {
  /** Oldest first (by `at`, unknown times first). */
  versions: ReviewVersionRow[];
}

export interface CommentRow {
  cid: number;
  pid: number;
  email: string | null;
  topic: string | null;
  visibility: string;
  isResponse: boolean;
  responseRound: string | null;
  draft: boolean;
  byAuthor: boolean;
  byShepherd: boolean;
  tags: string[];
  wordCount: number;
  /** Emails of @mentioned roster members. */
  mentions: string[];
  modifiedAt: number | null;
  firstSeenAt: number;
  firstSeenApprox: boolean;
  deletedSeenAt: number | null;
}

export interface CommentVersionRow {
  modifiedAt: number | null;
  seenAt: number;
  text: string;
}

export interface ReviewFieldRow {
  uid: string;
  name: string;
  type: string;
  isText: boolean;
  order: number | null;
  values: string[] | null;
  removedSeenAt: number | null;
}

export interface SyncRunRow {
  id: number;
  kind: "sync" | "backfill";
  startedAt: number;
  finishedAt: number | null;
  nowUsed: number;
  ok: boolean | null;
  counts: Record<string, number>;
  errors: string[];
}

export interface TextHit {
  kind: "review" | "comment";
  pid: number;
  rid?: number;
  vtag?: number;
  fieldUid?: string;
  cid?: number;
  snippet: string;
}

export interface ListOptions {
  /** Only these papers. */
  pids?: readonly number[];
  /** Include rows whose deleted/removed time is set. Default false. */
  includeGone?: boolean;
}

export interface Store {
  readonly db: Db;
  papers(o?: ListOptions): PaperRow[];
  people(o?: { includeGone?: boolean }): PersonRow[];
  assignments(o?: ListOptions & { roles?: readonly AssignmentRole[] }): AssignmentRow[];
  reviews(o?: ListOptions): ReviewRow[];
  /** Reviews plus their review_version history. */
  reviewsWithHistory(o?: ListOptions): ReviewWithHistory[];
  /** The latest stored text of each field of a review. */
  reviewText(rid: number): Record<string, string>;
  comments(o?: ListOptions): CommentRow[];
  /** Text versions of a comment, oldest first. */
  commentHistory(cid: number): CommentVersionRow[];
  /** Latest text of a comment. */
  commentText(cid: number): string | undefined;
  /** {pid, email} pairs of area chairs per the AC role (PCS_AC_ROLE). */
  areaChairs(role: AcRole, o?: { pids?: readonly number[] }): { pid: number; email: string }[];
  reviewFields(): ReviewFieldRow[];
  lastSync(kind?: "sync" | "backfill"): SyncRunRow | undefined;
  lastSuccessfulSync(): SyncRunRow | undefined;
  /** Observed rating changes, oldest first (optionally for some reviews). */
  ratingChanges(o?: { rids?: readonly number[] }): RatingChangeRow[];
  /** The synced review-rating settings. */
  ratingSettings(): RatingSettingsRow;
  /** FTS5 search over review and comment text (latest and older versions). */
  searchText(query: string, limit?: number): TextHit[];
  close(): void;
}

const bool = (v: unknown) => v === 1;
const parse = <T>(s: unknown, dflt: T): T => (typeof s === "string" ? (JSON.parse(s) as T) : dflt);

function pidFilter(o: { pids?: readonly number[] } | undefined, col = "pid"): { sql: string; args: unknown[] } {
  if (!o?.pids) return { sql: "", args: [] };
  if (o.pids.length === 0) return { sql: ` and 0`, args: [] };
  return { sql: ` and ${col} in (select value from json_each(?))`, args: [JSON.stringify(o.pids)] };
}

/** ~140 characters of `text` around the first query word found in it. */
function snippetFor(text: string, query: string): string {
  const words = query
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 1 && !/^(AND|OR|NOT|NEAR)$/.test(w))
    .map((w) => w.toLowerCase());
  const lower = text.toLowerCase();
  let at = -1;
  for (const w of words) {
    const i = lower.indexOf(w);
    if (i !== -1 && (at === -1 || i < at)) at = i;
  }
  const start = Math.max(0, at - 60);
  const s = text.slice(start, start + 140).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${s}${start + 140 < text.length ? "…" : ""}`;
}

type Raw = Record<string, unknown>;

function paperRow(r: Raw): PaperRow {
  return {
    pid: r.pid as number,
    title: r.title as string | null,
    status: r.status as string | null,
    decision: r.decision as string | null,
    decisionSeenAt: (r.decision_seen_at ?? null) as number | null,
    decisionSeenApprox: bool(r.decision_seen_approx),
    tags: parse(r.tags, []),
    lead: r.lead as string | null,
    shepherd: r.shepherd as string | null,
    manager: r.manager as string | null,
    firstSeenAt: r.first_seen_at as number,
    deletedSeenAt: r.deleted_seen_at as number | null,
  };
}

function reviewRow(r: Raw): ReviewRow {
  const status = r.status as string;
  return {
    rid: r.rid as number,
    pid: r.pid as number,
    email: r.email as string,
    rtype: r.rtype as number | null,
    status,
    complete: status === "complete" || status === "approved",
    round: r.round as string | null,
    ordinal: r.ordinal as string | null,
    vtag: r.vtag as number | null,
    modifiedAt: r.modified_at as number | null,
    firstSeenAt: r.first_seen_at as number,
    firstSeenApprox: bool(r.first_seen_approx),
    firstCompleteSeenAt: r.first_complete_seen_at as number | null,
    firstCompleteApprox: bool(r.first_complete_approx),
    scores: parse(r.scores, {}),
    wordCount: r.word_count as number,
    ratings: parseRatings(r.ratings),
    deletedSeenAt: r.deleted_seen_at as number | null,
  };
}

function versionRow(r: Raw): ReviewVersionRow {
  const seenAt = r.seen_at as number | null;
  const modifiedAt = r.modified_at as number | null;
  return {
    vtag: r.vtag as number,
    seenAt,
    seenApprox: bool(r.seen_approx),
    source: r.source as "snapshot" | "history",
    status: r.status as string,
    modifiedAt,
    scores: parse(r.scores, {}),
    wordCount: r.word_count as number | null,
    at: modifiedAt ?? seenAt,
  };
}

function commentRow(r: Raw): CommentRow {
  return {
    cid: r.cid as number,
    pid: r.pid as number,
    email: r.email as string | null,
    topic: r.topic as string | null,
    visibility: r.visibility as string,
    isResponse: bool(r.is_response),
    responseRound: r.response_round as string | null,
    draft: bool(r.draft),
    byAuthor: bool(r.by_author),
    byShepherd: bool(r.by_shepherd),
    tags: parse(r.tags, []),
    wordCount: r.word_count as number,
    mentions: parse(r.mentions, []),
    modifiedAt: r.modified_at as number | null,
    firstSeenAt: r.first_seen_at as number,
    firstSeenApprox: bool(r.first_seen_approx),
    deletedSeenAt: r.deleted_seen_at as number | null,
  };
}

function syncRunRow(r: Raw | undefined): SyncRunRow | undefined {
  if (!r) return undefined;
  return {
    id: r.id as number,
    kind: r.kind as "sync" | "backfill",
    startedAt: r.started_at as number,
    finishedAt: r.finished_at as number | null,
    nowUsed: r.now_used as number,
    ok: r.ok === null ? null : bool(r.ok),
    counts: parse(r.counts, {}),
    errors: parse(r.errors, []),
  };
}

/** Wrap an open Db in the read API. */
export function storeFromDb(db: Db): Store {
  const all = (sql: string, ...args: unknown[]) => db.prepare(sql).all(...args) as Raw[];
  const VERSION_ORDER = "order by coalesce(modified_at, seen_at) is not null, coalesce(modified_at, seen_at), id";

  const store: Store = {
    db,
    papers(o) {
      const f = pidFilter(o);
      const gone = o?.includeGone ? "" : " and deleted_seen_at is null";
      return all(`select * from paper where 1${gone}${f.sql} order by pid`, ...f.args).map(paperRow);
    },
    people(o) {
      const gone = o?.includeGone ? "" : " where removed_seen_at is null";
      return all(`select * from person${gone} order by email`).map((r) => ({
        email: r.email as string,
        name: r.name as string | null,
        affiliation: r.affiliation as string | null,
        isPc: bool(r.is_pc),
        roles: parse(r.roles, []),
        tags: parse(r.tags, []),
        tier: r.tier as string,
        firstSeenAt: r.first_seen_at as number,
        removedSeenAt: r.removed_seen_at as number | null,
      }));
    },
    assignments(o) {
      const f = pidFilter(o);
      const gone = o?.includeGone ? "" : " and removed_seen_at is null";
      const roles = o?.roles ? ` and role in (select value from json_each(?))` : "";
      const args: unknown[] = [...f.args, ...(o?.roles ? [JSON.stringify(o.roles)] : [])];
      return all(`select * from assignment where 1${gone}${f.sql}${roles} order by pid, role, email`, ...args).map((r) => ({
        pid: r.pid as number,
        email: r.email as string,
        role: r.role as AssignmentRole,
        round: r.round as string | null,
        firstSeenAt: r.first_seen_at as number,
        firstSeenApprox: bool(r.first_seen_approx),
        removedSeenAt: r.removed_seen_at as number | null,
      }));
    },
    reviews(o) {
      const f = pidFilter(o);
      const gone = o?.includeGone ? "" : " and deleted_seen_at is null";
      return all(`select * from review where 1${gone}${f.sql} order by pid, rid`, ...f.args).map(reviewRow);
    },
    reviewsWithHistory(o) {
      const reviews = store.reviews(o);
      const f = pidFilter(o, "r.pid");
      const byRid = new Map<number, ReviewVersionRow[]>();
      for (const v of all(
        `select v.* from review_version v join review r on r.rid = v.rid where 1${f.sql}
         ${VERSION_ORDER.replace(/\b(modified_at|seen_at|id)\b/g, "v.$1")}`,
        ...f.args,
      )) {
        const list = byRid.get(v.rid as number) ?? [];
        list.push(versionRow(v));
        byRid.set(v.rid as number, list);
      }
      return reviews.map((r) => ({ ...r, versions: byRid.get(r.rid) ?? [] }));
    },
    reviewText(rid) {
      const r = db.prepare("select vtag from review where rid = ?").get(rid) as { vtag: number | null } | undefined;
      if (!r || r.vtag === null) return {};
      const out: Record<string, string> = {};
      for (const t of all("select field_uid, text from review_text where rid = ? and vtag = ?", rid, r.vtag)) {
        out[t.field_uid as string] = t.text as string;
      }
      return out;
    },
    comments(o) {
      const f = pidFilter(o);
      const gone = o?.includeGone ? "" : " and deleted_seen_at is null";
      return all(`select * from comment where 1${gone}${f.sql} order by pid, cid`, ...f.args).map(commentRow);
    },
    commentHistory(cid) {
      return all("select modified_at, seen_at, text from comment_text where cid = ? order by id", cid).map((r) => ({
        modifiedAt: r.modified_at as number | null,
        seenAt: r.seen_at as number,
        text: r.text as string,
      }));
    },
    commentText(cid) {
      const r = db.prepare("select text from comment_text where cid = ? order by id desc limit 1").get(cid) as
        | { text: string }
        | undefined;
      return r?.text;
    },
    areaChairs(role, o) {
      const f = pidFilter(o, "x.pid");
      let sql: string;
      const args: unknown[] = [];
      switch (role.kind) {
        case "meta":
          sql = "select pid, email from review x where rtype = 5 and deleted_seen_at is null";
          break;
        case "lead":
        case "manager":
          sql = "select pid, email from assignment x where role = ? and removed_seen_at is null";
          args.push(role.kind);
          break;
        case "tag":
          // Assigned reviewers on the paper who hold the user tag.
          sql = `select distinct x.pid, x.email from review x join person p on p.email = x.email
                 where x.deleted_seen_at is null and exists (select 1 from json_each(p.tags) where lower(value) = lower(?))`;
          args.push(role.tag);
          break;
      }
      return all(`${sql}${f.sql} order by x.pid, x.email`, ...args, ...f.args).map((r) => ({
        pid: r.pid as number,
        email: r.email as string,
      }));
    },
    reviewFields() {
      return all("select * from review_field order by ord, uid").map((r) => ({
        uid: r.uid as string,
        name: r.name as string,
        type: r.type as string,
        isText: bool(r.is_text),
        order: r.ord as number | null,
        values: r.values_json === null ? null : parse<string[]>(r.values_json, []),
        removedSeenAt: r.removed_seen_at as number | null,
      }));
    },
    lastSync(kind = "sync") {
      return syncRunRow(db.prepare("select * from sync_run where kind = ? order by id desc limit 1").get(kind) as Raw | undefined);
    },
    lastSuccessfulSync() {
      return syncRunRow(
        db.prepare("select * from sync_run where kind = 'sync' and ok = 1 order by id desc limit 1").get() as Raw | undefined,
      );
    },
    searchText(query, limit = 50) {
      const hits: TextHit[] = [];
      // Contentless index: it returns rowids only; text comes from the source tables.
      const rows = all("select rowid from text_fts where text_fts match ? order by rank limit ?", query, limit);
      const rt = db.prepare(
        "select t.rid, t.vtag, t.field_uid, t.text, r.pid from review_text t join review r on r.rid = t.rid where t.id = ?",
      );
      const ct = db.prepare("select t.cid, t.text, c.pid from comment_text t join comment c on c.cid = t.cid where t.id = ?");
      for (const r of rows) {
        const rowid = r.rowid as number;
        if (rowid % 2 === 0) {
          const x = rt.get(rowid / 2) as Raw | undefined;
          if (x) {
            hits.push({
              kind: "review",
              pid: x.pid as number,
              rid: x.rid as number,
              vtag: x.vtag as number,
              fieldUid: x.field_uid as string,
              snippet: snippetFor(x.text as string, query),
            });
          }
        } else {
          const x = ct.get((rowid - 1) / 2) as Raw | undefined;
          if (x) hits.push({ kind: "comment", pid: x.pid as number, cid: x.cid as number, snippet: snippetFor(x.text as string, query) });
        }
      }
      return hits;
    },
    ratingChanges(o) {
      const f = o?.rids ? { sql: " where rid in (select value from json_each(?))", args: [JSON.stringify(o.rids)] } : { sql: "", args: [] };
      return all(`select rid, seen_at, before, after from rating_change${f.sql} order by seen_at, id`, ...f.args).map((r) => ({
        rid: r.rid as number,
        seenAt: r.seen_at as number,
        before: r.before === null ? null : parseRatings(r.before),
        after: parseRatings(r.after),
      }));
    },
    ratingSettings() {
      const m = new Map(
        (all("select key, value from meta where key in ('review_rating', 'review_rating_visibility')") as { key: string; value: string }[]).map((r) => [
          r.key,
          r.value,
        ]),
      );
      const setting = m.get("review_rating") ?? null;
      return { setting, visibility: m.get("review_rating_visibility") ?? null, enabled: ratingsEnabledFor(setting) };
    },
    close() {
      db.close();
    },
  };
  return store;
}

/** Open the store from config (PCS_DB_PATH, PCS_DB_KEY), migrating if needed. */
export function openStore(cfg: Pick<Config, "db">, opts: { readonly?: boolean } = {}): Store {
  return storeFromDb(openDb(cfg.db.path, { key: cfg.db.key, readonly: opts.readonly }));
}

/** An unencrypted in-memory store (unit tests). */
export function memoryStore(): Store {
  return storeFromDb(openDb(MEMORY, { key: undefined }));
}

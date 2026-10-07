// Store -> rules adapter (PLAN M5): builds the rules engine's SnapshotView
// (rules/model.ts) from the local store (store/README.md).
//
// Six statements, one per view array (papers, people, ACs, reviews, review
// versions, comments). Each is a single indexed scan or join, whatever the
// number of papers, so there is no per-paper or per-review query (no N+1).
// Scores are pulled out of the JSON column in SQL (json_extract), and no
// review or comment text is read: the view carries only counts and flags.
//
// Mapping (store -> view):
// - Times: store epoch seconds -> view epoch ms.
// - Papers: live rows only (deleted_seen_at is null). decisionSeenAt is
//   paper.decision_seen_at (migration 3).
// - People: every live person row (PC members and non-PC commenters, e.g.
//   authors who posted a response), with their tier.
// - ACs: Store.areaChairs(PCS_AC_ROLE), the same query the store exposes.
// - Reviews: live rows. merit/expertise = scores[PCS_FIELD_MERIT] /
//   scores[PCS_FIELD_EXPERTISE], numeric or null. ratedShort/ratedVague from
//   the ratings JSON. versions = review_version rows, oldest first by
//   coalesce(modified_at, seen_at): HotCRP's own edit time when known, else
//   when the sync first saw it. A history row with neither time sorts first
//   and gets seenAt 0 ("long ago"), so it never counts as discussion-time
//   movement.
// - Comments: live rows. time = min(first_seen_at, earliest modified_at in
//   comment_text), i.e. the earliest time we have any evidence the comment
//   existed (an edit overwrites HotCRP's modified_at; comment_text keeps the
//   first one we saw). approximate = first_seen_approx. Mentions come from the
//   comment's mentions JSON (the same set as comment_mention).
// - excludeRounds (PLAN M11): reviewer reviews (not metareviews) in these
//   review rounds are left out, so quick-reject reviews don't fill the review
//   slots (PCS_QR_EXCLUDE_FROM_SLOTS). Round names compare case-insensitively.

import type { AcRole } from "../config.js";
import type {
  AcView,
  CommentView,
  Millis,
  PaperView,
  PersonView,
  ReviewStatus,
  ReviewVersionView,
  ReviewView,
  SnapshotView,
} from "../rules/model.js";
import type { Store } from "../store/store.js";

export interface SnapshotOptions {
  /** PCS_FIELD_MERIT / PCS_FIELD_EXPERTISE. */
  fields: { merit: string; expertise: string };
  acRole: AcRole;
  /** Only these papers (the drawer); default all. */
  pids?: readonly number[];
  /** Review rounds whose non-meta reviews are left out (config.ts excludedRounds()). Default none. */
  excludeRounds?: readonly string[];
}

type Raw = Record<string, unknown>;

const ms = (s: unknown): Millis | null => (typeof s === "number" ? s * 1000 : null);

/** A score as a number (HotCRP may send "3"); null if unset or non-numeric. */
export function scoreNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v);
  return null;
}

const STATUSES: ReadonlySet<string> = new Set(["empty", "acknowledged", "draft", "delivered", "approved", "complete"]);
function status(s: unknown): ReviewStatus {
  return typeof s === "string" && STATUSES.has(s) ? (s as ReviewStatus) : "empty";
}

const jsonList = (s: unknown): string[] => {
  if (typeof s !== "string") return [];
  const v = JSON.parse(s) as unknown;
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
};

/** JSON path for a field UID (config.ts restricts UIDs to [A-Za-z][A-Za-z0-9_]*). */
const path = (uid: string) => `$.${uid}`;

function pidClause(pids: readonly number[] | undefined, col: string): { sql: string; args: unknown[] } {
  if (!pids) return { sql: "", args: [] };
  return { sql: ` and ${col} in (select value from json_each(?))`, args: [JSON.stringify(pids)] };
}

/** SQL excluding non-meta reviews in the given rounds (empty: no clause). */
export function roundClause(rounds: readonly string[] | undefined, alias: string): { sql: string; args: unknown[] } {
  if (!rounds || rounds.length === 0) return { sql: "", args: [] };
  return {
    sql: ` and (${alias}.rtype = 5 or ${alias}.round is null or lower(${alias}.round) not in (select lower(value) from json_each(?)))`,
    args: [JSON.stringify(rounds)],
  };
}

/** Build the rules engine's view of the store. */
export function buildSnapshot(store: Store, o: SnapshotOptions): SnapshotView {
  const db = store.db;
  const all = (sql: string, args: unknown[]) => db.prepare(sql).all(...args) as Raw[];

  const pp = pidClause(o.pids, "pid");
  const papers: PaperView[] = all(
    `select pid, title, decision, decision_seen_at, tags from paper where deleted_seen_at is null${pp.sql} order by pid`,
    pp.args,
  ).map((r) => ({
    pid: r.pid as number,
    title: (r.title as string | null) ?? "",
    decision: (r.decision as string | null) ?? null,
    decisionSeenAt: r.decision === null ? null : ms(r.decision_seen_at),
    tags: jsonList(r.tags),
  }));

  const people: PersonView[] = all(
    "select email, name, tier, roles from person where removed_seen_at is null order by email",
    [],
  ).map((r) => ({
    email: r.email as string,
    name: (r.name as string | null) ?? (r.email as string),
    tier: r.tier as string,
    roles: jsonList(r.roles),
  }));

  const acs: AcView[] = store.areaChairs(o.acRole, o.pids ? { pids: o.pids } : undefined);

  const rp = pidClause(o.pids, "r.pid");
  const versions = new Map<number, ReviewVersionView[]>();
  for (const v of all(
    `select v.rid, coalesce(v.modified_at, v.seen_at) as at, v.status,
            json_extract(v.scores, ?) as merit, json_extract(v.scores, ?) as expertise
       from review_version v join review r on r.rid = v.rid
      where r.deleted_seen_at is null${rp.sql}
      order by v.rid, at is not null, at, v.id`,
    [path(o.fields.merit), path(o.fields.expertise), ...rp.args],
  )) {
    const rid = v.rid as number;
    let list = versions.get(rid);
    if (!list) versions.set(rid, (list = []));
    list.push({
      seenAt: ms(v.at) ?? 0,
      merit: scoreNumber(v.merit),
      expertise: scoreNumber(v.expertise),
      status: status(v.status),
    });
  }

  const xr = roundClause(o.excludeRounds, "r");
  const reviews: ReviewView[] = all(
    `select r.rid, r.pid, r.email, r.rtype, r.status, r.ordinal, r.modified_at, r.first_seen_at,
            r.first_complete_seen_at, r.word_count, r.ratings,
            json_extract(r.scores, ?) as merit, json_extract(r.scores, ?) as expertise
       from review r where r.deleted_seen_at is null${rp.sql}${xr.sql} order by r.pid, r.rid`,
    [path(o.fields.merit), path(o.fields.expertise), ...rp.args, ...xr.args],
  ).map((r) => {
    const ratings = jsonList(r.ratings).map((x) => x.toLowerCase());
    return {
      rid: r.rid as number,
      pid: r.pid as number,
      email: r.email as string,
      rtype: (r.rtype as number | null) ?? 0,
      status: status(r.status),
      ordinal: (r.ordinal as string | null) || null,
      merit: scoreNumber(r.merit),
      expertise: scoreNumber(r.expertise),
      wordCount: r.word_count as number,
      ratedShort: ratings.includes("short"),
      ratedVague: ratings.includes("vague"),
      modifiedAt: ms(r.modified_at),
      firstSeenAt: ms(r.first_seen_at)!,
      firstCompleteSeenAt: ms(r.first_complete_seen_at),
      versions: versions.get(r.rid as number) ?? [],
    };
  });

  const cp = pidClause(o.pids, "c.pid");
  const comments: CommentView[] = all(
    `select c.cid, c.pid, c.email, c.is_response, c.draft, c.visibility, c.word_count, c.mentions,
            c.first_seen_approx,
            min(c.first_seen_at, coalesce((select min(t.modified_at) from comment_text t where t.cid = c.cid), c.first_seen_at)) as time
       from comment c
      where c.deleted_seen_at is null${cp.sql}
      order by c.pid, c.cid`,
    cp.args,
  ).map((r) => ({
    cid: r.cid as number,
    pid: r.pid as number,
    email: (r.email as string | null) ?? "",
    isResponse: r.is_response === 1,
    draft: r.draft === 1,
    visibility: r.visibility as string,
    wordCount: r.word_count as number,
    mentions: jsonList(r.mentions),
    time: ms(r.time)!,
    approximate: r.first_seen_approx === 1,
  }));

  return { papers, people, acs, reviews, comments };
}

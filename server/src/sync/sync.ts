// Full sync (spec §4): a handful of bulk calls, diffed against the local
// snapshot in ONE transaction per run. Nothing is ever dropped: items that
// disappear get deleted_seen_at / removed_seen_at.
//
// Order of work:
//   1. Small reads, held in memory: /pc, /search (t=all, fields), get/lead,
//      get/shepherd, get/pcassignments, the review form. Then the user-tag
//      queries (tiers, tag-based ACs): /reviews?rq=re:#<tag>, keeping only
//      reviewer emails, over a *covering* set of papers (coverPids: every
//      known reviewer has a review on one of them), not every paper.
//   2. BEGIN. Upsert fields, people, papers, assignments.
//   3. /reviews then /comments in pid-range chunks (PCS_SYNC_CHUNK), fetched
//      ahead with PCS_SYNC_CONCURRENCY in flight and applied one chunk at a
//      time, so at most that many chunks of text are in memory.
//      Reviewers the cover missed (new since the last sync, and not on the PC)
//      get the tag queries on one of their own papers afterwards.
//   4. Mark absent reviews/comments deleted. Write sync_run counts. COMMIT.
//
// Review ratings (spec §1, ratings.ts) come with /reviews as a flag multiset
// and are stored as counts per flag. They change with no vtag change and no
// timestamp, so each sync compares them with the stored counts and logs every
// difference in rating_change (before -> after, seen_at = now). Unchanged
// ratings write nothing, so a re-sync is idempotent. The rating settings
// (GET /settings) are kept in `meta` (review_rating, review_rating_visibility).
// On any error: ROLLBACK, and the sync_run row records the error.
//
// Times: `now` comes from the injected Clock (PCS_NOW). Items new after the
// first successful sync get first_seen_at = now; items present at the first
// sync get HotCRP's modified_at (or now) with *_approx = 1.
//
// Paper scope (PCS_PAPER_SEARCH): the client ANDs the search into every `q`
// (hotcrp/scope.ts), so /search, the searchaction downloads, /reviews,
// /comments and /papers only return in-scope papers. A paper that leaves the
// scope is absent like a deleted one: it and its reviews, comments and
// assignments get deleted_seen_at / removed_seen_at, so every view and module
// (which read live rows only) drops it, and nothing is lost if it returns.
// When a scoped sync sees a paper that was not live before (entered the
// scope, or came back), its reviews, comments and assignments are timed as
// at a first sync (HotCRP's modified_at, *_approx = 1): they may be old. The
// scope used is kept in meta `paper_search`.

import { systemClock, type Clock } from "../clock.js";
import type { AcRole, TierTags } from "../config.js";
import { pidChunks, pidListChunks, type PidChunk } from "../hotcrp/chunk.js";
import {
  reviewField,
  reviewScore,
  SCORE_FIELD_TYPES,
  TEXT_FIELD_TYPES,
  type Comment,
  type Review,
  type RqcField,
} from "../hotcrp/schemas.js";
import { countRatings, parseRatings, ratingsJson } from "../ratings.js";
import { redact } from "../redact.js";
import type { Db } from "../store/db.js";
import { mentionRoster, parseMentions, textHash, wordCount, type MentionRoster } from "./text.js";
import type { SyncSource } from "./source.js";
import { applyPaperDetails, storedOptionFields, submissionStatements, syncSubmissionFields } from "./submissions.js";

/** Review statuses that count as a finished review. */
export const COMPLETE_STATUSES: ReadonlySet<string> = new Set(["complete", "approved"]);

const ASSIGNMENT_ROLE: Record<string, string> = {
  metareview: "meta",
  primaryreview: "primary",
  secondaryreview: "secondary",
  pcreview: "pc",
  externalreview: "external",
};

export interface SyncOptions {
  clock: Clock;
  /** Papers per /reviews and /comments request (PCS_SYNC_CHUNK). */
  chunkSize: number;
  /** Chunks fetched ahead (PCS_SYNC_CONCURRENCY). */
  concurrency: number;
  tierTags: TierTags;
  acRole: AcRole;
  /** Progress lines (counts and endpoint names only; never content). */
  log?: (line: string) => void;
}

export type SyncCounts = Record<string, number>;

export interface SyncResult {
  runId: number;
  ok: boolean;
  counts: SyncCounts;
  /** Non-fatal warnings (and the fatal error, when ok is false). */
  errors: string[];
  durationMs: number;
}

const sec = (d: Date) => Math.floor(d.getTime() / 1000);
const json = (v: unknown) => JSON.stringify(v);

function asList(v: string | string[] | undefined): string[] {
  if (v === undefined) return [];
  const xs = Array.isArray(v) ? v : v.split(/\s+/);
  return xs.filter((x) => x !== "" && x !== "none").sort();
}

/** "#a #b#2" (search `tags` field) -> ["a", "b#2"]. */
export function parseTagField(v: string | undefined): string[] {
  if (!v) return [];
  return v
    .split(/\s+/)
    .map((t) => t.replace(/^#/, ""))
    .filter((t) => t !== "")
    .sort();
}

/** Tags whose holders matter: tier tags plus a tag-based AC role. */
export function queriedTags(tierTags: TierTags, acRole: AcRole): string[] {
  const tags = new Set(Object.values(tierTags));
  if (acRole.kind === "tag") tags.add(acRole.tag);
  return [...tags];
}

/** First configured tier whose tag the person holds; else "senior". */
export function tierFor(tags: readonly string[], tierTags: TierTags): string {
  for (const [tier, tag] of Object.entries(tierTags)) {
    if (tags.some((t) => t.toLowerCase() === tag.toLowerCase())) return tier;
  }
  return "senior";
}

/**
 * A small set of papers on which every reviewer in `pairs` has at least one
 * review (greedy set cover, deterministic). User tags belong to people, so
 * `re:#tag` over these papers finds the same holders as over every paper, for
 * a fraction of the download (PLAN M7: ~10x fewer bytes at 2,400 papers).
 */
export function coverPids(pairs: Iterable<{ pid: number; email: string }>): number[] {
  const byPid = new Map<number, Set<string>>();
  for (const { pid, email } of pairs) {
    if (!email) continue;
    let set = byPid.get(pid);
    if (!set) byPid.set(pid, (set = new Set()));
    set.add(email);
  }
  // Lazy greedy: take the paper adding the most uncovered reviewers; ties by pid.
  const covered = new Set<string>();
  const gain = (emails: Set<string>) => {
    let n = 0;
    for (const e of emails) if (!covered.has(e)) n++;
    return n;
  };
  let queue = [...byPid].map(([pid, emails]) => ({ pid, emails, n: emails.size }));
  const out: number[] = [];
  while (queue.length > 0) {
    queue.sort((a, b) => b.n - a.n || a.pid - b.pid);
    const top = queue[0]!;
    const n = gain(top.emails);
    if (n === 0) break; // the best stale bound is 0: nothing left to cover
    if (n < top.n) {
      top.n = n; // stale bound: re-rank
      continue;
    }
    out.push(top.pid);
    for (const e of top.emails) covered.add(e);
    queue = queue.slice(1).filter((x) => (x.n = gain(x.emails)) > 0);
  }
  return out.sort((a, b) => a - b);
}

/** Fetch chunks ahead (at most `depth` in flight), yield results in order. */
async function* ahead<T>(chunks: readonly PidChunk[], fetch: (c: PidChunk) => Promise<T>, depth: number) {
  const queue: Promise<T>[] = [];
  let i = 0;
  const push = () => {
    const p = fetch(chunks[i++]!);
    p.catch(() => undefined); // handled when awaited; avoid unhandled-rejection noise
    queue.push(p);
  };
  while (i < chunks.length && queue.length < Math.max(1, depth)) push();
  while (queue.length > 0) {
    const r = await queue.shift()!;
    if (i < chunks.length) push();
    yield r;
  }
}

interface ReviewRow {
  rid: number;
  pid: number;
  email: string;
  rtype: number | null;
  status: string;
  round: string | null;
  ordinal: string | null;
  vtag: number | null;
  modified_at: number | null;
  first_complete_seen_at: number | null;
  scores: string;
  word_count: number;
  ratings: string;
  deleted_seen_at: number | null;
}

interface CommentRow {
  cid: number;
  pid: number;
  email: string | null;
  topic: string | null;
  visibility: string;
  is_response: number;
  response_round: string | null;
  draft: number;
  by_author: number;
  by_shepherd: number;
  tags: string;
  word_count: number;
  mentions: string;
  text_hash: string;
  modified_at: number | null;
  deleted_seen_at: number | null;
}

class Counter {
  readonly c: SyncCounts = {};
  add(k: string, n = 1) {
    if (n !== 0) this.c[k] = (this.c[k] ?? 0) + n;
  }
}

/** Run one full sync. Never throws for HotCRP/DB errors: they land in the result and sync_run. */
export async function runSync(db: Db, source: SyncSource, opts: SyncOptions): Promise<SyncResult> {
  const started = performance.now();
  const now = sec(opts.clock.now());
  const log = opts.log ?? (() => undefined);
  const runId = Number(
    db
      .prepare("insert into sync_run (kind, started_at, now_used) values ('sync', ?, ?)")
      .run(sec(systemClock.now()), now).lastInsertRowid,
  );
  const counts = new Counter();
  const warnings: string[] = [];
  let inTx = false;
  try {
    // ---- 1. small reads ---------------------------------------------------
    const [pc, search, assignRows, leads, shepherds, form] = await Promise.all([
      source.pc(),
      source.papers(),
      source.pcAssignments(),
      source.paperRoles("lead"),
      source.paperRoles("shepherd"),
      source.reviewForm(),
    ]);
    const sf = source.submissionFields ? (await source.submissionFields()).settings.sf : undefined;
    const ratingSettings = source.ratingSettings ? (await source.ratingSettings()).settings : undefined;
    const pids = search.ids;
    const chunks = pidChunks(pids, opts.chunkSize);
    log(`fetched roster (${pc.pc.length}), papers (${pids.length}), assignments (${assignRows.length})`);

    // User tags: who holds each tier / AC tag. HotCRP warns (and the client
    // throws) for a tag nobody holds, so only ask about tags /pc lists. Ask on
    // a covering set of papers: every PC reviewer (get/pcassignments) and
    // every reviewer seen by earlier syncs has a review on one of them.
    const knownTags = new Set((pc.tags ?? []).map((t) => t.toLowerCase()));
    const tags = queriedTags(opts.tierTags, opts.acRole).filter((t) => knownTags.has(t.toLowerCase()));
    const holders = new Map<string, string[]>(); // email -> tags
    const pidSet = new Set(pids);
    const reviewers: { pid: number; email: string }[] = [];
    for (const r of assignRows) {
      if (ASSIGNMENT_ROLE[r.action] && r.email && pidSet.has(r.paper)) reviewers.push({ pid: r.paper, email: r.email.toLowerCase() });
    }
    for (const r of db.prepare("select pid, email from review where deleted_seen_at is null and email != ''").iterate() as Iterable<{
      pid: number;
      email: string;
    }>) {
      if (pidSet.has(r.pid)) reviewers.push(r);
    }
    const cover = tags.length > 0 ? coverPids(reviewers) : [];
    const askTags = async (onPids: readonly number[], keep: (email: string) => boolean) => {
      const found = new Map<string, string[]>();
      for (const tag of tags) {
        for await (const rs of ahead(pidListChunks(onPids, opts.chunkSize), (c) => source.reviews(c.q, `re:#${tag}`), opts.concurrency)) {
          for (const r of rs) {
            const e = (r.reviewer_email ?? "").toLowerCase();
            if (!e || !keep(e)) continue;
            const list = found.get(e) ?? [];
            if (!list.includes(tag)) list.push(tag);
            found.set(e, list);
          }
        }
        counts.add("tag_queries");
      }
      return found;
    };
    if (cover.length > 0) {
      for (const [e, t] of await askTags(cover, () => true)) holders.set(e, t);
      log(`tag holders: ${holders.size} (${tags.length} tag(s) asked on ${cover.length} covering papers)`);
    }
    const coverSet = new Set(cover);

    // ---- 2. structure -----------------------------------------------------
    db.exec("begin immediate");
    inTx = true;
    const firstSync =
      db.prepare("select 1 from sync_run where kind = 'sync' and ok = 1 limit 1").get() === undefined;
    const approx = firstSync ? 1 : 0;
    // Papers live before this sync; with a scope, others may bring old items.
    const paperSearch = (source.paperSearch ?? "").trim();
    const scoped = paperSearch !== "";
    const liveBefore = new Set(
      (db.prepare("select pid from paper where deleted_seen_at is null").all() as { pid: number }[]).map((r) => r.pid),
    );
    const asFirstSync = (pid: number) => firstSync || (scoped && !liveBefore.has(pid));
    db.prepare("insert into meta (key, value) values ('paper_search', ?) on conflict(key) do update set value = excluded.value").run(paperSearch);

    if (ratingSettings) {
      const setMeta = db.prepare("insert into meta (key, value) values (?, ?) on conflict(key) do update set value = excluded.value");
      setMeta.run("review_rating", ratingSettings.review_rating);
      setMeta.run("review_rating_visibility", ratingSettings.review_rating_visibility);
    }

    const fields = Object.values(form.reviewform);
    syncFields(db, fields, now, counts);
    const textUids = fields.filter((f) => TEXT_FIELD_TYPES.has(f.type)).map((f) => f.uid);
    const scoreUids = fields.filter((f) => SCORE_FIELD_TYPES.has(f.type)).map((f) => f.uid);

    const nameToEmails = syncPeople(db, pc.pc, holders, opts.tierTags, now, counts);
    const managerByPid = syncPapers(db, search.papers ?? [], leads, shepherds, nameToEmails, now, approx, counts, warnings);
    syncAssignments(db, assignRows, leads, shepherds, managerByPid, now, (pid) => (asFirstSync(pid) ? 1 : 0), counts);

    // ---- 3. reviews and comments -------------------------------------------
    db.exec("create temp table if not exists seen_rid (rid integer primary key)");
    db.exec("create temp table if not exists seen_cid (cid integer primary key)");
    db.exec("delete from temp.seen_rid; delete from temp.seen_cid");

    const rv = reviewStatements(db);
    const onCover = new Set<string>(); // reviewers with a review on a covering paper
    const elsewhere = new Map<string, number>(); // the others: email -> one of their pids
    for await (const rs of ahead(chunks, (c) => source.reviews(c.q), opts.concurrency)) {
      applyReviews(rv, rs, { now, firstSync: asFirstSync, runId, textUids, scoreUids }, counts);
      counts.add("reviews_fetched", rs.length);
      if (tags.length === 0) continue;
      for (const r of rs) {
        const e = (r.reviewer_email ?? "").toLowerCase();
        if (!e) continue;
        if (coverSet.has(r.pid)) onCover.add(e);
        else if (!elsewhere.has(e)) elsewhere.set(e, r.pid);
      }
    }
    log(`reviews: ${counts.c.reviews_fetched ?? 0} fetched`);

    // Reviewers the cover missed (new non-PC reviewers, or a review moved):
    // ask about them on one of their own papers, and fix their tags and tier.
    const missed = [...elsewhere].filter(([e]) => !onCover.has(e));
    if (missed.length > 0) {
      const who = new Set(missed.map(([e]) => e));
      const found = await askTags([...new Set(missed.map(([, pid]) => pid))], (e) => who.has(e));
      const updTier = db.prepare("update person set tags = ?, tier = ? where email = ? and (tags != ? or tier != ?)");
      for (const e of who) {
        const t = json((found.get(e) ?? []).slice().sort());
        const tier = tierFor(found.get(e) ?? [], opts.tierTags);
        counts.add("people_changed", updTier.run(t, tier, e, t, tier).changes);
      }
      log(`tag holders: ${found.size} more among ${who.size} reviewer(s) off the covering papers`);
    }

    const roster = mentionRoster(
      db.prepare("select email, name from person").all() as { email: string; name: string | null }[],
    );
    const cm = commentStatements(db);
    for await (const cs of ahead(chunks, (c) => source.comments(c.q), opts.concurrency)) {
      applyComments(db, cm, cs, { now, firstSync: asFirstSync, runId, roster }, counts);
      counts.add("comments_fetched", cs.length);
    }
    log(`comments: ${counts.c.comments_fetched ?? 0} fetched`);

    // Submissions (PLAN M10): option fields, then authors and option values
    // from /papers in the same pid chunks. Abstracts are dropped unread.
    if (sf && source.paperDetails) {
      const optionFields = storedOptionFields(sf);
      syncSubmissionFields(db, optionFields, now, counts);
      const sst = submissionStatements(db);
      const optionNames = optionFields.map((f) => f.name);
      const fetchDetails = source.paperDetails.bind(source);
      for await (const ps of ahead(chunks, (c) => fetchDetails(c.q), opts.concurrency)) {
        applyPaperDetails(sst, ps, { now, optionNames }, counts);
        counts.add("paper_details_fetched", ps.length);
      }
      if ((counts.c.papers_authors_hidden ?? 0) > 0) {
        warnings.push(`authors not visible on ${counts.c.papers_authors_hidden} paper(s); is PCS_FORCE_SHOW off?`);
      }
      log(`papers: ${counts.c.paper_details_fetched ?? 0} author/option records fetched`);
    }

    // ---- 4. absences ------------------------------------------------------
    counts.add(
      "reviews_deleted",
      db
        .prepare("update review set deleted_seen_at = ? where deleted_seen_at is null and rid not in (select rid from temp.seen_rid)")
        .run(now).changes,
    );
    counts.add(
      "comments_deleted",
      db
        .prepare("update comment set deleted_seen_at = ? where deleted_seen_at is null and cid not in (select cid from temp.seen_cid)")
        .run(now).changes,
    );

    const durationMs = Math.round(performance.now() - started);
    db.prepare("update sync_run set finished_at = ?, ok = 1, counts = ?, errors = ? where id = ?").run(
      sec(systemClock.now()),
      json(counts.c),
      json(warnings),
      runId,
    );
    db.exec("commit");
    inTx = false;
    return { runId, ok: true, counts: counts.c, errors: warnings, durationMs };
  } catch (e) {
    if (inTx) db.exec("rollback");
    const msg = redact(e instanceof Error ? e.message : String(e));
    const errors = [...warnings, msg];
    db.prepare("update sync_run set finished_at = ?, ok = 0, counts = '{}', errors = ? where id = ?").run(
      sec(systemClock.now()),
      json(errors),
      runId,
    );
    return { runId, ok: false, counts: {}, errors, durationMs: Math.round(performance.now() - started) };
  }
}

// ---------------------------------------------------------------------------

function syncFields(db: Db, fields: RqcField[], now: number, counts: Counter) {
  const get = db.prepare("select name, type, is_text, ord, values_json, scheme, removed_seen_at from review_field where uid = ?");
  const ins = db.prepare(
    "insert into review_field (uid, name, type, is_text, ord, values_json, scheme, first_seen_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const upd = db.prepare(
    "update review_field set name = ?, type = ?, is_text = ?, ord = ?, values_json = ?, scheme = ?, removed_seen_at = null where uid = ?",
  );
  const seen = new Set<string>();
  for (const f of fields) {
    seen.add(f.uid);
    const isText = TEXT_FIELD_TYPES.has(f.type) ? 1 : 0;
    const values = f.values ? json(f.values) : null;
    const scheme = f.scheme ?? null;
    const old = get.get(f.uid) as
      | { name: string; type: string; is_text: number; ord: number | null; values_json: string | null; scheme: string | null; removed_seen_at: number | null }
      | undefined;
    if (!old) {
      ins.run(f.uid, f.name, f.type, isText, f.order ?? null, values, scheme, now);
      counts.add("fields_new");
    } else if (
      old.name !== f.name ||
      old.type !== f.type ||
      old.is_text !== isText ||
      old.ord !== (f.order ?? null) ||
      old.values_json !== values ||
      old.scheme !== scheme ||
      old.removed_seen_at !== null
    ) {
      upd.run(f.name, f.type, isText, f.order ?? null, values, scheme, f.uid);
      counts.add("fields_changed");
    }
  }
  const all = db.prepare("select uid from review_field where removed_seen_at is null").all() as { uid: string }[];
  const rm = db.prepare("update review_field set removed_seen_at = ? where uid = ?");
  for (const { uid } of all) {
    if (!seen.has(uid)) {
      rm.run(now, uid);
      counts.add("fields_removed");
    }
  }
}

/** Upsert the PC roster. Returns display name -> emails (to resolve `manager`). */
function syncPeople(
  db: Db,
  members: { name: string; email: string; affiliation?: string | undefined; roles?: string | undefined }[],
  holders: ReadonlyMap<string, string[]>,
  tierTags: TierTags,
  now: number,
  counts: Counter,
): Map<string, string[]> {
  const get = db.prepare("select name, affiliation, is_pc, roles, tags, tier, removed_seen_at from person where email = ?");
  const ins = db.prepare(
    "insert into person (email, name, affiliation, is_pc, roles, tags, tier, first_seen_at) values (?, ?, ?, 1, ?, ?, ?, ?)",
  );
  const upd = db.prepare(
    "update person set name = ?, affiliation = ?, is_pc = 1, roles = ?, tags = ?, tier = ?, removed_seen_at = null where email = ?",
  );
  const byName = new Map<string, string[]>();
  const seen = new Set<string>();
  for (const m of members) {
    const email = m.email.trim().toLowerCase();
    if (email === "" || seen.has(email)) continue;
    seen.add(email);
    const name = m.name && m.name.toLowerCase() !== email ? m.name : null;
    if (name) byName.set(name, [...(byName.get(name) ?? []), email]);
    const roles = json(["pc", ...asList(m.roles)]);
    const tags = (holders.get(email) ?? []).slice().sort();
    const tier = tierFor(tags, tierTags);
    const old = get.get(email) as
      | { name: string | null; affiliation: string | null; is_pc: number; roles: string; tags: string; tier: string; removed_seen_at: number | null }
      | undefined;
    const aff = m.affiliation ?? null;
    if (!old) {
      ins.run(email, name, aff, roles, json(tags), tier, now);
      counts.add("people_new");
    } else if (
      old.name !== name ||
      old.affiliation !== aff ||
      old.is_pc !== 1 ||
      old.roles !== roles ||
      old.tags !== json(tags) ||
      old.tier !== tier ||
      old.removed_seen_at !== null
    ) {
      upd.run(name, aff, roles, json(tags), tier, email);
      counts.add("people_changed");
    }
  }
  // People who left the PC (keep the row).
  const pcNow = db.prepare("select email from person where is_pc = 1 and removed_seen_at is null").all() as { email: string }[];
  const rm = db.prepare("update person set removed_seen_at = ? where email = ?");
  for (const { email } of pcNow) {
    if (!seen.has(email)) {
      rm.run(now, email);
      counts.add("people_removed");
    }
  }
  // Tagged non-PC reviewers (rare) still get their tier.
  const insOther = db.prepare("insert or ignore into person (email, is_pc, first_seen_at) values (?, 0, ?)");
  const updTier = db.prepare("update person set tags = ?, tier = ? where email = ? and (tags != ? or tier != ?)");
  for (const [email, tags] of holders) {
    if (seen.has(email)) continue;
    counts.add("people_new", insOther.run(email, now).changes);
    const t = json(tags.slice().sort());
    const tier = tierFor(tags, tierTags);
    counts.add("people_changed", updTier.run(t, tier, email, t, tier).changes);
  }
  // Non-PC people who no longer hold any queried tag.
  const tagged = db.prepare("select email from person where is_pc = 0 and tags != '[]'").all() as { email: string }[];
  for (const { email } of tagged) {
    if (!holders.has(email)) counts.add("people_changed", updTier.run("[]", "senior", email, "[]", "senior").changes);
  }
  return byName;
}

function syncPapers(
  db: Db,
  papers: { pid: number; [k: string]: unknown }[],
  leads: { pid: number; email: string }[],
  shepherds: { pid: number; email: string }[],
  nameToEmails: ReadonlyMap<string, string[]>,
  now: number,
  approx: number,
  counts: Counter,
  warnings: string[],
): Map<number, string> {
  const leadBy = new Map(leads.map((r) => [r.pid, r.email.toLowerCase()]));
  const shepBy = new Map(shepherds.map((r) => [r.pid, r.email.toLowerCase()]));
  const managerBy = new Map<number, string>();
  const get = db.prepare(
    "select title, status, decision, tags, lead, shepherd, manager, deleted_seen_at from paper where pid = ?",
  );
  const ins = db.prepare(
    `insert into paper (pid, title, status, decision, tags, lead, shepherd, manager, first_seen_at, synced_at,
       decision_seen_at, decision_seen_approx) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // A changed decision restarts its first-seen clock; a cleared one clears it.
  const decSeen = db.prepare("update paper set decision_seen_at = ?, decision_seen_approx = 0 where pid = ?");
  const upd = db.prepare(
    "update paper set title = ?, status = ?, decision = ?, tags = ?, lead = ?, shepherd = ?, manager = ?, deleted_seen_at = null where pid = ?",
  );
  const unresolved: number[] = [];
  for (const p of papers) {
    const s = (k: string) => (typeof p[k] === "string" ? (p[k] as string) : null);
    const title = s("title");
    const status = s("status");
    const dec = s("decision");
    const decision = dec === null || dec === "" || dec === "Unspecified" ? null : dec;
    const tags = json(parseTagField(s("tags") ?? undefined));
    const lead = leadBy.get(p.pid) ?? null;
    const shepherd = shepBy.get(p.pid) ?? null;
    let manager: string | null = null;
    const mname = s("administrator");
    if (mname) {
      const emails = nameToEmails.get(mname) ?? (mname.includes("@") ? [mname.toLowerCase()] : []);
      if (emails.length === 1) manager = emails[0]!;
      else unresolved.push(p.pid);
    }
    if (manager) managerBy.set(p.pid, manager);
    const old = get.get(p.pid) as
      | { title: string | null; status: string | null; decision: string | null; tags: string; lead: string | null; shepherd: string | null; manager: string | null; deleted_seen_at: number | null }
      | undefined;
    if (!old) {
      // A decision already there at the first sync has no known time: approximate.
      const decAt = decision === null ? null : now;
      ins.run(p.pid, title, status, decision, tags, lead, shepherd, manager, now, now, decAt, decAt !== null ? approx : 0);
      counts.add("papers_new");
    } else if (
      old.title !== title ||
      old.status !== status ||
      old.decision !== decision ||
      old.tags !== tags ||
      old.lead !== lead ||
      old.shepherd !== shepherd ||
      old.manager !== manager ||
      old.deleted_seen_at !== null
    ) {
      upd.run(title, status, decision, tags, lead, shepherd, manager, p.pid);
      if (old.decision !== decision) decSeen.run(decision === null ? null : now, p.pid);
      counts.add("papers_changed");
    }
  }
  if (unresolved.length > 0) {
    warnings.push(
      `manager name matched zero or several PC members on ${unresolved.length} paper(s) (e.g. #${unresolved[0]}); left unset`,
    );
  }
  db.prepare("update paper set synced_at = ?").run(now);
  const seen = new Set(papers.map((p) => p.pid));
  const live = db.prepare("select pid from paper where deleted_seen_at is null").all() as { pid: number }[];
  const del = db.prepare("update paper set deleted_seen_at = ? where pid = ?");
  for (const { pid } of live) {
    if (!seen.has(pid)) {
      del.run(now, pid);
      counts.add("papers_deleted");
    }
  }
  return managerBy;
}

function syncAssignments(
  db: Db,
  rows: { paper: number; action: string; email?: string | undefined; round?: string | undefined }[],
  leads: { pid: number; email: string }[],
  shepherds: { pid: number; email: string }[],
  managers: ReadonlyMap<number, string>,
  now: number,
  approx: (pid: number) => number,
  counts: Counter,
) {
  const want = new Map<string, { pid: number; email: string; role: string; round: string | null }>();
  const put = (pid: number, email: string, role: string, round: string | null) => {
    const e = email.toLowerCase();
    want.set(`${pid}\t${e}\t${role}`, { pid, email: e, role, round });
  };
  for (const r of rows) {
    const role = ASSIGNMENT_ROLE[r.action];
    if (role && r.email) put(r.paper, r.email, role, r.round || null);
  }
  for (const r of leads) put(r.pid, r.email, "lead", null);
  for (const r of shepherds) put(r.pid, r.email, "shepherd", null);
  for (const [pid, email] of managers) put(pid, email, "manager", null);

  const have = new Map<string, { round: string | null; removed_seen_at: number | null }>();
  for (const r of db.prepare("select pid, email, role, round, removed_seen_at from assignment").iterate() as Iterable<{
    pid: number;
    email: string;
    role: string;
    round: string | null;
    removed_seen_at: number | null;
  }>) {
    have.set(`${r.pid}\t${r.email}\t${r.role}`, { round: r.round, removed_seen_at: r.removed_seen_at });
  }
  const ins = db.prepare(
    "insert into assignment (pid, email, role, round, first_seen_at, first_seen_approx) values (?, ?, ?, ?, ?, ?)",
  );
  const upd = db.prepare("update assignment set round = ?, removed_seen_at = null where pid = ? and email = ? and role = ?");
  const rm = db.prepare("update assignment set removed_seen_at = ? where pid = ? and email = ? and role = ?");
  for (const [k, a] of want) {
    const old = have.get(k);
    if (!old) {
      ins.run(a.pid, a.email, a.role, a.round, now, approx(a.pid));
      counts.add("assignments_new");
    } else if (old.removed_seen_at !== null || old.round !== a.round) {
      upd.run(a.round, a.pid, a.email, a.role);
      counts.add(old.removed_seen_at !== null ? "assignments_restored" : "assignments_changed");
    }
  }
  for (const [k, old] of have) {
    if (old.removed_seen_at === null && !want.has(k)) {
      const [pid, email, role] = k.split("\t") as [string, string, string];
      rm.run(now, Number(pid), email, role);
      counts.add("assignments_removed");
    }
  }
}

// ---------------------------------------------------------------------------
// Reviews

const REVIEW_COLS =
  "rid, pid, email, rtype, status, round, ordinal, vtag, modified_at, first_complete_seen_at, scores, word_count, ratings, deleted_seen_at";

function reviewStatements(db: Db) {
  return {
    load: db.prepare(`select ${REVIEW_COLS} from review where pid between ? and ?`),
    byRid: db.prepare(`select ${REVIEW_COLS} from review where rid = ?`),
    ins: db.prepare(
      `insert into review (rid, pid, email, rtype, status, round, ordinal, vtag, modified_at,
        first_seen_at, first_seen_approx, first_complete_seen_at, first_complete_approx, scores, word_count, ratings)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    upd: db.prepare(
      `update review set pid = ?, email = ?, rtype = ?, status = ?, round = ?, ordinal = ?, vtag = ?, modified_at = ?,
        scores = ?, word_count = ?, ratings = ?, deleted_seen_at = null where rid = ?`,
    ),
    complete: db.prepare(
      "update review set first_complete_seen_at = ?, first_complete_approx = 0 where rid = ? and first_complete_seen_at is null",
    ),
    version: db.prepare(
      `insert or ignore into review_version (rid, vtag, seen_at, seen_approx, source, status, modified_at, scores, word_count, sync_run_id)
       values (?, ?, ?, 0, 'snapshot', ?, ?, ?, ?, ?)`,
    ),
    text: db.prepare("insert or ignore into review_text (rid, vtag, field_uid, text) values (?, ?, ?, ?)"),
    seen: db.prepare("insert or ignore into temp.seen_rid (rid) values (?)"),
    ratingChange: db.prepare("insert into rating_change (rid, seen_at, before, after, sync_run_id) values (?, ?, ?, ?, ?)"),
    person: db.prepare("insert or ignore into person (email, is_pc, first_seen_at) values (?, 0, ?)"),
  };
}

interface ReviewCtx {
  now: number;
  /** Time new items on this paper as at a first sync (see the header). */
  firstSync: (pid: number) => boolean;
  runId: number;
  textUids: readonly string[];
  scoreUids: readonly string[];
}

/** The parts of a /reviews object we store. */
export function reviewParts(r: Review, textUids: readonly string[], scoreUids: readonly string[]) {
  const scores: Record<string, number | string | null> = {};
  for (const uid of scoreUids) {
    const v = reviewScore(r, uid);
    if (v !== undefined) scores[uid] = v;
  }
  const texts: [string, string][] = [];
  let words = 0;
  for (const uid of textUids) {
    const v = reviewField(r, uid);
    if (typeof v === "string" && v !== "") {
      texts.push([uid, v]);
      words += wordCount(v);
    }
  }
  return { scores: json(scores), texts, words, ratings: ratingsJson(countRatings(r.ratings)) };
}

function applyReviews(st: ReturnType<typeof reviewStatements>, rs: Review[], ctx: ReviewCtx, counts: Counter) {
  if (rs.length === 0) return;
  let lo = Infinity;
  let hi = -Infinity;
  for (const r of rs) {
    lo = Math.min(lo, r.pid);
    hi = Math.max(hi, r.pid);
  }
  const old = new Map<number, ReviewRow>();
  for (const row of st.load.iterate(lo, hi) as Iterable<ReviewRow>) old.set(row.rid, row);

  for (const r of rs) {
    st.seen.run(r.rid);
    const email = (r.reviewer_email ?? "").toLowerCase();
    if (email) st.person.run(email, ctx.now);
    const { scores, texts, words, ratings } = reviewParts(r, ctx.textUids, ctx.scoreUids);
    const vtag = r.version ?? null;
    const complete = COMPLETE_STATUSES.has(r.status);
    const mod = r.modified_at ?? null;
    // A review outside the chunk's pid range only if it moved papers; look it up directly.
    const prev = old.get(r.rid) ?? (st.byRid.get(r.rid) as ReviewRow | undefined);

    const addVersion = () => {
      if (vtag === null) return;
      if (st.version.run(r.rid, vtag, ctx.now, r.status, mod, scores, words, ctx.runId).changes > 0) {
        counts.add("review_versions_new");
      }
      for (const [uid, text] of texts) counts.add("review_texts_new", st.text.run(r.rid, vtag, uid, text).changes);
    };

    if (!prev) {
      const first = ctx.firstSync(r.pid);
      const firstSeen = first ? (mod ?? ctx.now) : ctx.now;
      const approx = first ? 1 : 0;
      st.ins.run(
        r.rid,
        r.pid,
        email,
        r.rtype ?? null,
        r.status,
        r.round ?? null,
        r.ordinal ?? null,
        vtag,
        mod,
        firstSeen,
        approx,
        complete ? firstSeen : null,
        complete ? approx : 0,
        scores,
        words,
        ratings,
      );
      counts.add("reviews_new");
      addVersion();
      if (ratings !== "{}") {
        st.ratingChange.run(r.rid, ctx.now, null, ratings, ctx.runId);
        counts.add("rating_changes");
      }
      continue;
    }

    // Compare canonical forms, so a row migrated from the flag-list form
    // (migration 6) doesn't count as a change.
    const prevRatings = ratingsJson(parseRatings(prev.ratings));
    if (prevRatings !== ratings) {
      st.ratingChange.run(r.rid, ctx.now, prevRatings, ratings, ctx.runId);
      counts.add("rating_changes");
    }

    if (vtag !== null && vtag !== prev.vtag) addVersion();
    if (complete && prev.first_complete_seen_at === null) st.complete.run(ctx.now, r.rid);
    if (
      prev.pid !== r.pid ||
      prev.email !== email ||
      prev.rtype !== (r.rtype ?? null) ||
      prev.status !== r.status ||
      prev.round !== (r.round ?? null) ||
      prev.ordinal !== (r.ordinal ?? null) ||
      prev.vtag !== vtag ||
      prev.modified_at !== mod ||
      prev.scores !== scores ||
      prev.word_count !== words ||
      prev.ratings !== ratings ||
      prev.deleted_seen_at !== null
    ) {
      st.upd.run(r.pid, email, r.rtype ?? null, r.status, r.round ?? null, r.ordinal ?? null, vtag, mod, scores, words, ratings, r.rid);
      counts.add(prev.deleted_seen_at !== null ? "reviews_restored" : "reviews_changed");
    }
  }
}

// ---------------------------------------------------------------------------
// Comments

function commentStatements(db: Db) {
  return {
    load: db.prepare(
      `select cid, pid, email, topic, visibility, is_response, response_round, draft, by_author, by_shepherd, tags,
        word_count, mentions, text_hash, modified_at, deleted_seen_at from comment where pid between ? and ?`,
    ),
    byCid: db.prepare(
      `select cid, pid, email, topic, visibility, is_response, response_round, draft, by_author, by_shepherd, tags,
        word_count, mentions, text_hash, modified_at, deleted_seen_at from comment where cid = ?`,
    ),
    ins: db.prepare(
      `insert into comment (cid, pid, email, topic, visibility, is_response, response_round, draft, by_author, by_shepherd,
        tags, word_count, mentions, text_hash, modified_at, first_seen_at, first_seen_approx)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    upd: db.prepare(
      `update comment set pid = ?, email = ?, topic = ?, visibility = ?, is_response = ?, response_round = ?, draft = ?,
        by_author = ?, by_shepherd = ?, tags = ?, word_count = ?, mentions = ?, text_hash = ?, modified_at = ?,
        deleted_seen_at = null where cid = ?`,
    ),
    text: db.prepare("insert into comment_text (cid, modified_at, seen_at, text, sync_run_id) values (?, ?, ?, ?, ?)"),
    clearMentions: db.prepare("delete from comment_mention where cid = ?"),
    mention: db.prepare("insert or ignore into comment_mention (cid, email) values (?, ?)"),
    seen: db.prepare("insert or ignore into temp.seen_cid (cid) values (?)"),
    person: db.prepare("insert or ignore into person (email, is_pc, first_seen_at) values (?, 0, ?)"),
  };
}

interface CommentCtx {
  now: number;
  /** Time new items on this paper as at a first sync (see the header). */
  firstSync: (pid: number) => boolean;
  runId: number;
  roster: MentionRoster;
}

function applyComments(db: Db, st: ReturnType<typeof commentStatements>, cs: Comment[], ctx: CommentCtx, counts: Counter) {
  if (cs.length === 0) return;
  let lo = Infinity;
  let hi = -Infinity;
  for (const c of cs) {
    lo = Math.min(lo, c.pid);
    hi = Math.max(hi, c.pid);
  }
  const old = new Map<number, CommentRow>();
  for (const row of st.load.iterate(lo, hi) as Iterable<CommentRow>) old.set(row.cid, row);

  for (const c of cs) {
    st.seen.run(c.cid);
    const email = c.author_email ? c.author_email.toLowerCase() : null;
    if (email) st.person.run(email, ctx.now);
    const text = c.text ?? "";
    const hash = textHash(text);
    const mod = c.modified_at ?? null;
    const isResponse = c.response !== undefined ? 1 : 0;
    const v = {
      topic: c.topic ?? null,
      visibility: c.visibility,
      is_response: isResponse,
      response_round: c.response ?? null,
      draft: c.draft ? 1 : 0,
      by_author: c.by_author ? 1 : 0,
      by_shepherd: c.by_shepherd ? 1 : 0,
      tags: json((c.tags ?? []).slice().sort()),
    };
    const prev = old.get(c.cid) ?? (st.byCid.get(c.cid) as CommentRow | undefined);
    const writeMentions = (emails: string[]) => {
      st.clearMentions.run(c.cid);
      for (const e of emails) st.mention.run(c.cid, e);
      counts.add("mentions", emails.length);
    };

    if (!prev) {
      const mentions = parseMentions(text, ctx.roster);
      st.ins.run(
        c.cid, c.pid, email, v.topic, v.visibility, v.is_response, v.response_round, v.draft, v.by_author, v.by_shepherd,
        v.tags, wordCount(text), json(mentions), hash, mod,
        ctx.firstSync(c.pid) ? (mod ?? ctx.now) : ctx.now, ctx.firstSync(c.pid) ? 1 : 0,
      );
      st.text.run(c.cid, mod, ctx.now, text, ctx.runId);
      writeMentions(mentions);
      counts.add("comments_new");
      counts.add("comment_texts_new");
      continue;
    }

    const textChanged = prev.text_hash !== hash;
    let mentions = prev.mentions;
    let words = prev.word_count;
    if (textChanged) {
      const m = parseMentions(text, ctx.roster);
      mentions = json(m);
      words = wordCount(text);
      writeMentions(m);
    }
    if (textChanged || prev.modified_at !== mod) {
      st.text.run(c.cid, mod, ctx.now, text, ctx.runId);
      counts.add("comment_texts_new");
    }
    if (
      textChanged ||
      prev.modified_at !== mod ||
      prev.pid !== c.pid ||
      prev.email !== email ||
      prev.topic !== v.topic ||
      prev.visibility !== v.visibility ||
      prev.is_response !== v.is_response ||
      prev.response_round !== v.response_round ||
      prev.draft !== v.draft ||
      prev.by_author !== v.by_author ||
      prev.by_shepherd !== v.by_shepherd ||
      prev.tags !== v.tags ||
      prev.deleted_seen_at !== null
    ) {
      st.upd.run(
        c.pid, email, v.topic, v.visibility, v.is_response, v.response_round, v.draft, v.by_author, v.by_shepherd,
        v.tags, words, mentions, hash, mod, c.cid,
      );
      counts.add(prev.deleted_seen_at !== null ? "comments_restored" : "comments_changed");
    }
  }
}

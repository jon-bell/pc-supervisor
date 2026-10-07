// One-time /reviewhistory backfill (spec §4): for every live review not yet
// backfilled, fetch its expanded history at PCS_HISTORY_RPS and record each
// older version as review_version(source='history'). Resumable: progress is
// committed per review in history_backfill, and done reviews are skipped.
//
// History versions carry the version's own modified_at when HotCRP expands
// them (expand=1). If HotCRP returns `review_delta` objects instead, deltas
// are applied to the next-newer full version; text fields given only as
// `<UID>:p` patches are treated as unknown (no review_text row, word_count
// null) rather than guessed.

import { systemClock, type Clock } from "../clock.js";
import { HotcrpError } from "../hotcrp/errors.js";
import { reviewField, type ReviewHistory } from "../hotcrp/schemas.js";
import { redact } from "../redact.js";
import type { Db } from "../store/db.js";
import type { SyncSource } from "./source.js";
import { COMPLETE_STATUSES } from "./sync.js";
import { wordCount } from "./text.js";

/** A token bucket: `rate` tokens/second, holding at most `burst`. */
export class TokenBucket {
  #tokens: number;
  #last: number;
  constructor(
    readonly rate: number,
    readonly burst: number = 1,
    private readonly monotonicMs: () => number = () => performance.now(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    if (!(rate > 0)) throw new RangeError("TokenBucket: rate must be > 0");
    this.#tokens = burst;
    this.#last = monotonicMs();
  }

  async take(): Promise<void> {
    for (;;) {
      const t = this.monotonicMs();
      this.#tokens = Math.min(this.burst, this.#tokens + ((t - this.#last) / 1000) * this.rate);
      this.#last = t;
      if (this.#tokens >= 1) {
        this.#tokens -= 1;
        return;
      }
      await this.sleep(Math.ceil(((1 - this.#tokens) / this.rate) * 1000));
    }
  }
}

export interface BackfillOptions {
  clock: Clock;
  /** Requests per second (PCS_HISTORY_RPS). */
  rps: number;
  /** Stop after this many reviews (default: all). */
  limit?: number;
  /** Checked between reviews; abort to stop cleanly (SIGINT). */
  signal?: AbortSignal;
  log?: (line: string) => void;
  /** Injection for tests. */
  bucket?: TokenBucket;
}

export interface BackfillResult {
  runId: number;
  ok: boolean;
  done: number;
  remaining: number;
  versionsNew: number;
  errors: string[];
}

const sec = (d: Date) => Math.floor(d.getTime() / 1000);

interface FieldInfo {
  textUids: string[];
  scoreUids: string[];
}

interface VersionState {
  vtag: number;
  status: string;
  modified_at: number | null;
  scores: Record<string, number | string | null>;
  texts: Map<string, string | null>;
  unknownText: Set<string>;
}

/** Turn a history response (newest first) into full version states. Exported for tests. */
export function historyVersions(h: ReviewHistory, f: FieldInfo): VersionState[] {
  const out: VersionState[] = [];
  let newer: VersionState | undefined;
  for (const v of h.versions) {
    let s: VersionState;
    if (v.object === "review") {
      s = { vtag: v.version ?? NaN, status: v.status, modified_at: v.modified_at ?? null, scores: {}, texts: new Map(), unknownText: new Set() };
      for (const uid of f.scoreUids) {
        const x = reviewField(v, uid);
        if (x !== undefined) s.scores[uid] = x;
      }
      for (const uid of f.textUids) {
        const x = reviewField(v, uid);
        s.texts.set(uid, typeof x === "string" ? x : null);
      }
    } else {
      // A delta holds only fields that differ from the next-newer version.
      const base: VersionState = newer ?? { vtag: NaN, status: v.status, modified_at: null, scores: {}, texts: new Map(), unknownText: new Set() };
      s = {
        vtag: v.version,
        status: v.status,
        modified_at: null,
        scores: { ...base.scores },
        texts: new Map(base.texts),
        unknownText: new Set(base.unknownText),
      };
      const rec = v as Record<string, unknown>;
      for (const uid of f.scoreUids) {
        const x = reviewField(v, uid);
        if (x !== undefined) s.scores[uid] = x;
      }
      for (const uid of f.textUids) {
        if (uid in rec) {
          const x = reviewField(v, uid);
          s.texts.set(uid, typeof x === "string" ? x : null);
          s.unknownText.delete(uid);
        } else if (`${uid}:p` in rec) {
          s.texts.delete(uid);
          s.unknownText.add(uid);
        }
      }
    }
    if (Number.isFinite(s.vtag)) out.push(s);
    newer = s;
  }
  return out;
}

export async function runBackfill(db: Db, source: SyncSource, opts: BackfillOptions): Promise<BackfillResult> {
  const now = sec(opts.clock.now());
  const log = opts.log ?? (() => undefined);
  const bucket = opts.bucket ?? new TokenBucket(opts.rps, 1);
  const runId = Number(
    db.prepare("insert into sync_run (kind, started_at, now_used) values ('backfill', ?, ?)").run(sec(systemClock.now()), now)
      .lastInsertRowid,
  );
  const fields = db.prepare("select uid, is_text from review_field where removed_seen_at is null").all() as {
    uid: string;
    is_text: number;
  }[];
  const f: FieldInfo = {
    textUids: fields.filter((x) => x.is_text === 1).map((x) => x.uid),
    scoreUids: fields.filter((x) => x.is_text !== 1).map((x) => x.uid),
  };
  const todoSql = `from review r where r.deleted_seen_at is null and not exists (select 1 from history_backfill h where h.rid = r.rid)`;
  const todo = db.prepare(`select r.rid, r.pid ${todoSql} order by r.rid limit ?`).all(opts.limit ?? -1) as {
    rid: number;
    pid: number;
  }[];

  const insVersion = db.prepare(
    `insert or ignore into review_version (rid, vtag, seen_at, seen_approx, source, status, modified_at, scores, word_count, sync_run_id)
     values (?, ?, ?, 1, 'history', ?, ?, ?, ?, ?)`,
  );
  const insText = db.prepare("insert or ignore into review_text (rid, vtag, field_uid, text) values (?, ?, ?, ?)");
  const refineComplete = db.prepare(
    "update review set first_complete_seen_at = ? where rid = ? and first_complete_approx = 1 and first_complete_seen_at > ?",
  );
  const markDone = db.prepare("insert into history_backfill (rid, done_at, versions, sync_run_id) values (?, ?, ?, ?)");

  const errors: string[] = [];
  let done = 0;
  let versionsNew = 0;
  let fatal = false;
  for (const { rid, pid } of todo) {
    if (opts.signal?.aborted) break;
    await bucket.take();
    let h: ReviewHistory;
    try {
      h = await source.reviewHistory(pid, rid);
    } catch (e) {
      const msg = redact(e instanceof Error ? e.message : String(e));
      errors.push(`review ${rid}: ${msg}`);
      // A per-review 4xx (gone, no permission) is skipped and retried next run;
      // anything else (network, rate limit, schema drift) stops the backfill.
      if (e instanceof HotcrpError && e.kind === "http" && e.status !== undefined && e.status >= 400 && e.status < 500) continue;
      fatal = true;
      break;
    }
    const states = historyVersions(h, f);
    db.transaction(() => {
      let earliestComplete: number | undefined;
      for (const s of states) {
        const unknown = s.unknownText.size > 0;
        let words = 0;
        for (const t of s.texts.values()) words += wordCount(t);
        const r = insVersion.run(rid, s.vtag, s.modified_at, s.status, s.modified_at, JSON.stringify(s.scores), unknown ? null : words, runId);
        versionsNew += r.changes;
        for (const [uid, t] of s.texts) if (t) insText.run(rid, s.vtag, uid, t);
        if (COMPLETE_STATUSES.has(s.status) && s.modified_at !== null) {
          earliestComplete = Math.min(earliestComplete ?? Infinity, s.modified_at);
        }
      }
      if (earliestComplete !== undefined) refineComplete.run(earliestComplete, rid, earliestComplete);
      markDone.run(rid, now, states.length, runId);
    })();
    done++;
    if (done % 100 === 0) log(`backfill: ${done}/${todo.length} reviews`);
  }

  const remaining = (db.prepare(`select count(*) as n ${todoSql}`).get() as { n: number }).n;
  const ok = !fatal;
  db.prepare("update sync_run set finished_at = ?, ok = ?, counts = ?, errors = ? where id = ?").run(
    sec(systemClock.now()),
    ok ? 1 : 0,
    JSON.stringify({ reviews_backfilled: done, review_versions_new: versionsNew, remaining }),
    JSON.stringify(errors),
    runId,
  );
  return { runId, ok, done, remaining, versionsNew, errors };
}

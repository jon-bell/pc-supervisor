// Flag history (spec §5c "Flag history"): when each (paper, rule) flag was
// raised and cleared, and why. Tables: flag_event, flag_state, meta keys
// flag_history_since / flag_history_last_at (migration 7).
//
// Recording (recordFlags) diffs a whole-store evaluation against flag_state
// and appends one event per change, all in one transaction:
// - after every sync (cause 'data': new data, or time passing, e.g. a paper
//   going quiet), and after every rule revision (cause 'rules', with the
//   revision id);
// - the first recording ever is the baseline (cause 'baseline'): flags that
//   were already open when history began;
// - `since` is the previous recording's instant: the change happened in
//   (since, at], which is what explain.ts searches for a trigger.
// The evaluation passed in must cover the whole store (never a ?search=
// subset), or every paper outside it would read as cleared.
//
// Reconstruction (reconstructFlagHistory, run by `pcs backfill`) replays the
// store's history at daily points from REVIEW_DUE up to the baseline, with
// the rule settings in force at each point, and writes those events with
// reconstructed = 1 (replacing any earlier reconstruction). Limits: see
// snapshot-at.ts and spec §5c; at best a day's resolution.
//
// Readers collapse repeats per (pid, rule) with a window function, ordered by
// (at, reconstructed desc, id): a raise while already open (the baseline's
// raise of a flag the reconstruction already opened) or a clear while closed
// is dropped.

import type { Clock } from "../clock.js";
import type { Config, RuleName } from "../config.js";
import { evaluateAll, type PaperResult } from "../rules/evaluate.js";
import { DAY_MS, phaseTimesFromConfig } from "../rules/phase.js";
import { effectiveRuleContext, ruleContextAt } from "../rule-settings/service.js";
import type { Db } from "../store/db.js";
import type { Store } from "../store/store.js";
import { buildSnapshot, snapshotOptions } from "../views/snapshot.js";
import { snapshotAt } from "./snapshot-at.js";

export type FlagCause = "baseline" | "data" | "rules";

export interface FlagEvent {
  id: number;
  pid: number;
  rule: RuleName;
  kind: "raised" | "cleared";
  /** Epoch ms. */
  at: number;
  /** The previous recording's instant (ms): the change happened in (since, at]. */
  since: number | null;
  cause: FlagCause;
  syncRunId: number | null;
  revisionId: number | null;
  reconstructed: boolean;
  /** The rule's reason string when raised (numbers only, no review text). */
  reason: string | null;
}

const key = (pid: number, rule: string) => `${pid}\t${rule}`;

function getMeta(db: Db, k: string): number | null {
  const r = db.prepare("select value from meta where key = ?").get(k) as { value: string } | undefined;
  return r ? Number(r.value) : null;
}
function setMeta(db: Db, k: string, v: number): void {
  db.prepare("insert into meta (key, value) values (?, ?) on conflict(key) do update set value = excluded.value").run(k, String(v));
}

/** Epoch ms of the first live recording (null = none yet). */
export const historySince = (db: Db): number | null => {
  const s = getMeta(db, "flag_history_since");
  return s === null ? null : s * 1000;
};

export interface RecordOptions {
  /** The evaluation's instant (ctx.now), epoch ms. */
  atMs: number;
  cause: "data" | "rules";
  syncRunId?: number | null;
  revisionId?: number | null;
}

export interface RecordResult {
  raised: number;
  cleared: number;
  baseline: boolean;
}

/** Diff `results` (every paper in the store) against flag_state and append the changes. */
export function recordFlags(db: Db, results: readonly PaperResult[], o: RecordOptions): RecordResult {
  return db.transaction((): RecordResult => {
    const at = Math.floor(o.atMs / 1000);
    const baseline = getMeta(db, "flag_history_since") === null;
    const since = getMeta(db, "flag_history_last_at");
    const cause: FlagCause = baseline ? "baseline" : o.cause;
    const open = new Map<string, { pid: number; rule: string; reason: string | null }>();
    for (const r of db.prepare("select pid, rule, reason from flag_state").all() as { pid: number; rule: string; reason: string | null }[]) {
      open.set(key(r.pid, r.rule), r);
    }
    const ins = db.prepare(
      `insert into flag_event (pid, rule, kind, at, since, cause, sync_run_id, rule_revision_id, reconstructed, reason)
       values (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    );
    const put = db.prepare("insert into flag_state (pid, rule, reason) values (?, ?, ?) on conflict(pid, rule) do update set reason = excluded.reason");
    const del = db.prepare("delete from flag_state where pid = ? and rule = ?");
    const run = o.syncRunId ?? null;
    const rev = o.cause === "rules" ? (o.revisionId ?? null) : null;
    let raised = 0;
    let cleared = 0;
    const seen = new Set<string>();
    for (const p of results) {
      for (const f of p.fired) {
        const k = key(p.pid, f.rule);
        seen.add(k);
        const prev = open.get(k);
        if (!prev) {
          ins.run(p.pid, f.rule, "raised", at, since, cause, run, rev, f.reason);
          put.run(p.pid, f.rule, f.reason);
          raised++;
        } else if (prev.reason !== f.reason) put.run(p.pid, f.rule, f.reason);
      }
    }
    for (const [k, s] of open) {
      if (seen.has(k)) continue;
      ins.run(s.pid, s.rule, "cleared", at, since, cause, run, rev, null);
      del.run(s.pid, s.rule);
      cleared++;
    }
    if (baseline) setMeta(db, "flag_history_since", at);
    setMeta(db, "flag_history_last_at", at);
    return { raised, cleared, baseline };
  })();
}

// ---------------------------------------------------------------------------
// Reading

interface EventRow {
  id: number;
  pid: number;
  rule: string;
  kind: "raised" | "cleared";
  at: number;
  since: number | null;
  cause: FlagCause;
  sync_run_id: number | null;
  rule_revision_id: number | null;
  reconstructed: number;
  reason: string | null;
}

const toEvent = (r: EventRow): FlagEvent => ({
  id: r.id,
  pid: r.pid,
  rule: r.rule as RuleName,
  kind: r.kind,
  at: r.at * 1000,
  since: r.since === null ? null : r.since * 1000,
  cause: r.cause,
  syncRunId: r.sync_run_id,
  revisionId: r.rule_revision_id,
  reconstructed: r.reconstructed === 1,
  reason: r.reason,
});

export interface EventQuery {
  pid?: number;
  /** Only these papers (the ?search= filter). */
  pids?: readonly number[];
  rules?: readonly string[];
  /** Events strictly before this instant (ms), for paging the feed. */
  before?: number;
  limit?: number;
  order?: "asc" | "desc";
}

/** Raises and clears with repeats collapsed (see the header). */
export function flagEvents(db: Db, q: EventQuery = {}): FlagEvent[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (q.pid !== undefined) {
    where.push("pid = ?");
    args.push(q.pid);
  }
  if (q.pids) {
    where.push("pid in (select value from json_each(?))");
    args.push(JSON.stringify(q.pids));
  }
  if (q.rules && q.rules.length) {
    where.push("rule in (select value from json_each(?))");
    args.push(JSON.stringify(q.rules));
  }
  const outer: string[] = ["((prev is null and kind = 'raised') or (prev is not null and prev != kind))"];
  if (q.before !== undefined) {
    outer.push("at < ?");
    args.push(Math.floor(q.before / 1000));
  }
  const dir = q.order === "desc" ? "desc" : "asc";
  const sql = `
    with e as (
      select *, lag(kind) over (partition by pid, rule order by at, reconstructed desc, id) as prev
        from flag_event ${where.length ? `where ${where.join(" and ")}` : ""}
    )
    select id, pid, rule, kind, at, since, cause, sync_run_id, rule_revision_id, reconstructed, reason
      from e where ${outer.join(" and ")}
     order by at ${dir}, reconstructed ${dir === "asc" ? "desc" : "asc"}, id ${dir}
     ${q.limit !== undefined ? "limit ?" : ""}`;
  if (q.limit !== undefined) args.push(q.limit);
  return (db.prepare(sql).all(...args) as EventRow[]).map(toEvent);
}

export interface FlagInterval {
  pid: number;
  rule: RuleName;
  raised: FlagEvent;
  /** null = still open. */
  cleared: FlagEvent | null;
}

/** Raise/clear pairs from collapsed events in ascending order. */
export function intervalsOf(events: readonly FlagEvent[]): FlagInterval[] {
  const out: FlagInterval[] = [];
  const open = new Map<string, FlagInterval>();
  for (const e of events) {
    const k = key(e.pid, e.rule);
    if (e.kind === "raised") {
      if (open.has(k)) continue;
      const iv: FlagInterval = { pid: e.pid, rule: e.rule, raised: e, cleared: null };
      open.set(k, iv);
      out.push(iv);
    } else {
      const iv = open.get(k);
      if (!iv) continue;
      iv.cleared = e;
      open.delete(k);
    }
  }
  return out;
}

export interface FlagSeries {
  /** Daily points (ms), plus a final point at `end`. */
  ts: number[];
  /** Open flags per rule at each point. */
  byRule: Record<string, number[]>;
  /** Papers with at least one open flag at each point. */
  flagged: number[];
}

/** Open-flag counts over time from collapsed ascending events. Cost O(points x intervals). */
export function flagSeries(events: readonly FlagEvent[], rules: readonly string[], start: number, end: number): FlagSeries {
  const ts: number[] = [];
  for (let t = start; t < end; t += DAY_MS) ts.push(t);
  if (end >= start) ts.push(end);
  const ivs = intervalsOf(events);
  const byRule: Record<string, number[]> = Object.fromEntries(rules.map((r) => [r, ts.map(() => 0)]));
  const flagged = ts.map(() => 0);
  const papers = ts.map(() => new Set<number>());
  for (const iv of ivs) {
    const a = iv.raised.at;
    const b = iv.cleared?.at ?? Infinity;
    const row = byRule[iv.rule];
    for (let i = 0; i < ts.length; i++) {
      const t = ts[i]!;
      if (t >= a && t < b) {
        if (row) row[i]!++;
        papers[i]!.add(iv.pid);
      }
    }
  }
  for (let i = 0; i < ts.length; i++) flagged[i] = papers[i]!.size;
  return { ts, byRule, flagged };
}

/** The earliest event instant (ms), or null. */
export function firstEventAt(db: Db): number | null {
  const r = db.prepare("select min(at) as at from flag_event").get() as { at: number | null };
  return r.at === null ? null : r.at * 1000;
}

// ---------------------------------------------------------------------------
// Reconstruction

type ReconstructConfig = Pick<Config, "phases" | "rules" | "meritAcceptMin" | "expertiseOkMin" | "reviewsRequired" | "fields" | "acRole" | "quickReject">;

export interface ReconstructResult {
  /** Daily points evaluated. */
  points: number;
  /** Reconstructed events written. */
  events: number;
  /** The baseline instant (ms) the reconstruction stops at. */
  until: number;
}

/**
 * Rebuild the reconstructed part of the history (before the baseline). If
 * nothing was ever recorded, `baseline` is recorded first (an evaluation at
 * the clock's instant), so history has a live starting point.
 */
export function reconstructFlagHistory(
  store: Store,
  cfg: ReconstructConfig,
  o: { baseline: () => void; stepMs?: number },
): ReconstructResult {
  const db = store.db;
  if (historySince(db) === null) o.baseline();
  const until = historySince(db)!;
  const step = o.stepMs ?? DAY_MS;
  const snapshot = buildSnapshot(store, snapshotOptions(cfg));
  const start = phaseTimesFromConfig(cfg.phases).reviewDue;

  type Ev = { pid: number; rule: string; kind: "raised" | "cleared"; at: number; since: number | null; reason: string | null };
  const out: Ev[] = [];
  let open = new Map<string, { pid: number; rule: string }>();
  let prevT: number | null = null;
  let points = 0;
  for (let t = start; t < until; t += step) {
    points++;
    const ctx = ruleContextAt(store, cfg, t);
    const ev = evaluateAll(snapshotAt(snapshot, t), ctx);
    const now = new Map<string, { pid: number; rule: string }>();
    for (const r of ev.results) {
      for (const f of r.fired) {
        const k = key(r.pid, f.rule);
        now.set(k, { pid: r.pid, rule: f.rule });
        if (!open.has(k)) out.push({ pid: r.pid, rule: f.rule, kind: "raised", at: t, since: prevT, reason: f.reason });
      }
    }
    for (const [k, s] of open) if (!now.has(k)) out.push({ pid: s.pid, rule: s.rule, kind: "cleared", at: t, since: prevT, reason: null });
    open = now;
    prevT = t;
  }
  // Open at the last point but not in the baseline: cleared by the time history began.
  const baselineOpen = new Set(
    (db.prepare("select pid, rule from flag_event where cause = 'baseline' and kind = 'raised' and reconstructed = 0").all() as { pid: number; rule: string }[]).map((r) =>
      key(r.pid, r.rule),
    ),
  );
  for (const [k, s] of open) if (!baselineOpen.has(k)) out.push({ pid: s.pid, rule: s.rule, kind: "cleared", at: until, since: prevT, reason: null });

  db.transaction(() => {
    db.prepare("delete from flag_event where reconstructed = 1").run();
    const ins = db.prepare(
      `insert into flag_event (pid, rule, kind, at, since, cause, sync_run_id, rule_revision_id, reconstructed, reason)
       values (?, ?, ?, ?, ?, 'data', null, null, 1, ?)`,
    );
    for (const e of out) ins.run(e.pid, e.rule, e.kind, Math.floor(e.at / 1000), e.since === null ? null : Math.floor(e.since / 1000), e.reason);
  })();
  return { points, events: out.length, until };
}

/** A whole-store evaluation at the clock's instant, for recording outside the server (CLI). */
export function evaluateStore(store: Store, cfg: ReconstructConfig, clock: Clock): { atMs: number; results: readonly PaperResult[] } {
  const snapshot = buildSnapshot(store, snapshotOptions(cfg));
  const ctx = effectiveRuleContext(store, cfg, clock);
  return { atMs: ctx.now, results: evaluateAll(snapshot, ctx).results };
}

/** Evaluate the whole store now and record the changes (CLI sync, `pcs rules set`). */
export function recordStoreFlags(store: Store, cfg: ReconstructConfig, clock: Clock, o: Omit<RecordOptions, "atMs">): RecordResult {
  const { atMs, results } = evaluateStore(store, cfg, clock);
  return recordFlags(store.db, results, { ...o, atMs });
}

/**
 * `pcs backfill`'s last step. The backfill changed the data (older review
 * versions, so e.g. score movement), so first bring the live state up to
 * date: if the baseline is all the live history there is (the usual first
 * `pcs sync` + `pcs backfill`), it is re-taken from the backfilled data, so
 * flags that only the missing history raised don't show as raised and
 * cleared at once; otherwise a 'data' recording. Then rebuild the
 * reconstructed history before the baseline.
 */
export function backfillFlagHistory(store: Store, cfg: ReconstructConfig, clock: Clock): ReconstructResult {
  const db = store.db;
  if (historySince(db) !== null) {
    const later = db.prepare("select count(*) as n from flag_event where reconstructed = 0 and cause != 'baseline'").get() as { n: number };
    if (later.n === 0) {
      db.transaction(() => {
        db.prepare("delete from flag_event where reconstructed = 0").run();
        db.prepare("delete from flag_state").run();
        db.prepare("delete from meta where key in ('flag_history_since', 'flag_history_last_at')").run();
      })();
    } else recordStoreFlags(store, cfg, clock, { cause: "data" });
  }
  return reconstructFlagHistory(store, cfg, { baseline: () => void recordStoreFlags(store, cfg, clock, { cause: "data" }) });
}

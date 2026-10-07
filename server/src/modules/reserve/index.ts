// Reserve-reviewer compliance (spec §10.4 A, PLAN M11): the module's API.
//
//   const report = reserveReport(store, cfg, { clock });            // no DBLP
//   const report = reserveReport(store, cfg, { clock, cache });     // with hints known so far
//
// Read-only and synchronous over the local store and imports; never calls
// HotCRP. DBLP hints (optional, PCS_DBLP_ENABLED) come from a HintCache the
// caller owns: the server queues lookups in the background and shows what it
// has; the CLI waits for them (dblpCacheFromConfig + cache.loadAll).

import type { Clock } from "../../clock.js";
import { DEFAULT_RESERVE_POLICY, type ReservePolicy } from "../../config.js";
import type { Store } from "../../store/store.js";
import { checkReserve, hintNames } from "./check.js";
import { dblpLookup, HintCache, hintFrom, type AuthorLookup } from "./dblp.js";
import { loadReserveInput } from "./load.js";
import type { ReserveReport } from "./types.js";

export type * from "./types.js";
export { checkReserve, checkConsistency, checkCoverage, checkDesignee, checkExemption, checkTpms, hintNames, mailDrafts } from "./check.js";
export { countVenues, DblpPublSearchSchema, dblpLookup, HintCache, hintFrom, HINT_DISCLAIMER, staticLookup, type AuthorHint, type AuthorLookup, type VenueCounts } from "./dblp.js";
export { loadReserveInput } from "./load.js";
export { normalizeEmail, normalizeName, parseDesignee } from "./normalize.js";

type Cfg = { reserve?: ReservePolicy | undefined };

export const reservePolicy = (cfg: Cfg): ReservePolicy => cfg.reserve ?? DEFAULT_RESERVE_POLICY;

/** A HintCache over the real DBLP lookup, or null when PCS_DBLP_ENABLED is false. */
export function dblpCacheFromConfig(cfg: Cfg, lookup?: AuthorLookup): HintCache | null {
  const p = reservePolicy(cfg);
  if (!p.dblp.enabled) return null;
  return new HintCache(lookup ?? dblpLookup({ url: p.dblp.url, venues: p.dblp.venues }), { rps: p.dblp.rps });
}

export interface ReserveOptions {
  clock: Clock;
  /** DBLP hints; ignored unless PCS_DBLP_ENABLED. */
  cache?: HintCache | null;
  /** Queue lookups for names not in the cache yet (server). Default false. */
  requestMissing?: boolean;
}

/** Names the report would like DBLP hints for. */
export function reserveHintNames(store: Store, cfg: Cfg, clock: Clock): string[] {
  const policy = reservePolicy(cfg);
  return hintNames(loadReserveInput(store, policy, clock.now()), policy);
}

export function reserveReport(store: Store, cfg: Cfg, opts: ReserveOptions): ReserveReport {
  const policy = reservePolicy(cfg);
  const input = loadReserveInput(store, policy, opts.clock.now());
  const cache = policy.dblp.enabled ? (opts.cache ?? null) : null;
  if (!cache) return checkReserve(input, policy);

  const names = hintNames(input, policy);
  if (opts.requestMissing) cache.request(names);
  const label = cache.lookup.label;
  const report = checkReserve(input, policy, (name) => {
    const e = cache.peek(name);
    return e?.state === "found" ? hintFrom(name, label, e.counts, policy.dblp.seniorMin) : undefined;
  });
  let looked = 0;
  let failed = 0;
  for (const n of names) {
    const e = cache.peek(n);
    if (e) looked++;
    if (e?.state === "failed") failed++;
  }
  report.dblp = { enabled: true, source: label, looked, pending: names.length - looked, failed };
  if (failed > 0) report.notes.push(`DBLP lookup failed for ${failed} of ${names.length} names; no hint shown for them`);
  if (names.length - looked > 0) report.notes.push(`DBLP lookups pending for ${names.length - looked} of ${names.length} names (PCS_DBLP_RPS=${policy.dblp.rps}); reload later`);
  return report;
}

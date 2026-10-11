// OPTIONAL DBLP lookup for seniority and exemption evidence (spec §10.4 A,
// PLAN M11). OFF by default (PCS_DBLP_ENABLED=false).
//
// This is the ONE outbound call besides PCS_HOTCRP_URL, and only when the
// chair opts in (AGENTS.md rule 4, spec §7). It sends a single **public author
// name** as the search query to PCS_DBLP_URL; never an email, title, abstract,
// review, or any other submission content. Results are **hints for a human,
// never verdicts**: a name can match a different person, or miss papers.
//
// The module only depends on the AuthorLookup interface. `dblpLookup()` is the
// real implementation over fetch; tests inject a fake fetch or a
// `staticLookup()`, and no test calls the network (the unit setup stubs the
// global fetch to throw).

import { z } from "zod";
import { normalizeName } from "./normalize.js";

/** What a lookup found for one name. */
export interface VenueCounts {
  /** Papers per configured venue (only venues with at least one paper). */
  venues: Record<string, number>;
  /** DBLP hits whose author list contains the name (any venue). */
  matchedPapers: number;
}

export interface AuthorLookup {
  /** For reasons and the UI, e.g. "DBLP (https://dblp.org)". */
  readonly label: string;
  /** Counts for a public author name; undefined when nothing matched. Rejects on network/format errors. */
  lookup(name: string): Promise<VenueCounts | undefined>;
}

/** A hint attached to a designee or an exempted paper's author. Never a verdict. */
export interface AuthorHint {
  name: string;
  source: string;
  venues: Record<string, number>;
  /** Papers at the configured venues. */
  atVenues: number;
  matchedPapers: number;
  /** atVenues >= PCS_DBLP_SENIOR_MIN. Still only a hint. */
  possiblySenior: boolean;
  /** The sentence the UI and CLI show; always says it's a hint. */
  text: string;
}

export const HINT_DISCLAIMER = "a hint for a human, not a verdict: the name may match a different person";

export function hintFrom(name: string, source: string, c: VenueCounts, seniorMin: number): AuthorHint {
  const atVenues = Object.values(c.venues).reduce((a, b) => a + b, 0);
  const parts = Object.entries(c.venues)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([v, n]) => `${v} ${n}`);
  const possiblySenior = atVenues >= seniorMin;
  return {
    name,
    source,
    venues: c.venues,
    atVenues,
    matchedPapers: c.matchedPapers,
    possiblySenior,
    text:
      `${source}: ${atVenues} paper${atVenues === 1 ? "" : "s"} at the configured venues` +
      (parts.length ? ` (${parts.join(", ")})` : "") +
      ` for the name "${name}"; ${possiblySenior ? `possibly senior (PCS_DBLP_SENIOR_MIN=${seniorMin})` : `below PCS_DBLP_SENIOR_MIN=${seniorMin}`}` +
      ` (${HINT_DISCLAIMER})`,
  };
}

// ---------------------------------------------------------------------------
// The real lookup: GET <url>/search/publ/api?q=<name>&format=json&h=<max>

const Venue = z.union([z.string(), z.array(z.string())]);
const AuthorEntry = z.union([z.string(), z.looseObject({ text: z.string() })]);
const Hit = z.looseObject({
  info: z.looseObject({
    authors: z.looseObject({ author: z.union([AuthorEntry, z.array(AuthorEntry)]) }).optional(),
    venue: Venue.optional(),
  }),
});
export const DblpPublSearchSchema = z.looseObject({
  result: z.looseObject({
    hits: z.looseObject({ hit: z.union([Hit, z.array(Hit)]).optional() }),
  }),
});

type FetchLike = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export interface DblpOptions {
  /** PCS_DBLP_URL (https). */
  url: string;
  /** PCS_DBLP_VENUES: DBLP venue strings, compared case-insensitively. */
  venues: readonly string[];
  /** Injected in tests; default the global fetch. */
  fetch?: FetchLike;
  /** Max hits per query (DBLP caps at 1000). */
  maxHits?: number;
  timeoutMs?: number;
}

/** Count venue papers for a name from a parsed DBLP publication search. */
export function countVenues(body: z.infer<typeof DblpPublSearchSchema>, name: string, venues: readonly string[]): VenueCounts | undefined {
  const want = normalizeName(name);
  const byLower = new Map(venues.map((v) => [v.toLowerCase(), v]));
  const raw = body.result.hits.hit;
  const hits = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  const out: Record<string, number> = {};
  let matched = 0;
  for (const h of hits) {
    const a = h.info.authors?.author;
    const authors = a === undefined ? [] : Array.isArray(a) ? a : [a];
    if (!authors.some((x) => normalizeName(typeof x === "string" ? x : x.text) === want)) continue;
    matched++;
    const v = h.info.venue;
    for (const venue of v === undefined ? [] : Array.isArray(v) ? v : [v]) {
      const k = byLower.get(venue.trim().toLowerCase());
      if (k) out[k] = (out[k] ?? 0) + 1;
    }
  }
  return matched === 0 ? undefined : { venues: out, matchedPapers: matched };
}

export function dblpLookup(o: DblpOptions): AuthorLookup {
  const f: FetchLike = o.fetch ?? ((url, init) => fetch(url, init));
  const max = o.maxHits ?? 1000;
  return {
    label: `DBLP (${o.url})`,
    async lookup(name) {
      // Only the public name leaves the machine.
      const url = `${o.url}/search/publ/api?q=${encodeURIComponent(name)}&format=json&h=${max}`;
      const r = await f(url, { signal: AbortSignal.timeout(o.timeoutMs ?? 15_000), headers: { accept: "application/json" } });
      if (!r.ok) throw new Error(`DBLP answered HTTP ${r.status}`);
      const parsed = DblpPublSearchSchema.safeParse(await r.json());
      if (!parsed.success) throw new Error("DBLP response did not match the expected shape");
      return countVenues(parsed.data, name, o.venues);
    },
  };
}

/** A fixed table (tests, or a pre-computed cache). Keys are matched by normalized name. */
export function staticLookup(label: string, table: Readonly<Record<string, VenueCounts>>): AuthorLookup {
  const m = new Map(Object.entries(table).map(([k, v]) => [normalizeName(k), v]));
  return { label, lookup: async (name) => m.get(normalizeName(name)) };
}

// ---------------------------------------------------------------------------
// A process-lifetime cache with a rate-limited background queue, so the
// server can answer at once with what it knows and fill in the rest.

export type CacheEntry = { state: "found"; counts: VenueCounts } | { state: "none" } | { state: "failed" };

export class HintCache {
  readonly #entries = new Map<string, CacheEntry>();
  readonly #queue: string[] = [];
  readonly #queued = new Set<string>();
  #running: Promise<void> | null = null;

  constructor(
    readonly lookup: AuthorLookup,
    private readonly opts: { rps: number; sleep?: (ms: number) => Promise<void> },
  ) {}

  /** What is known for a name (undefined: not looked up yet). */
  peek(name: string): CacheEntry | undefined {
    return this.#entries.get(normalizeName(name));
  }

  get pending(): number {
    return this.#queue.length;
  }

  /** Queue the names not looked up yet; returns at once. */
  request(names: Iterable<string>): void {
    for (const n of names) {
      const k = normalizeName(n);
      if (k === "" || this.#entries.has(k) || this.#queued.has(k)) continue;
      this.#queued.add(k);
      this.#queue.push(n);
    }
    this.#running ??= this.#drain().finally(() => {
      this.#running = null;
    });
  }

  /** Queue the names and wait until the queue is empty. */
  async loadAll(names: Iterable<string>, onProgress?: (done: number, total: number) => void): Promise<void> {
    this.request(names);
    const total = this.#queue.length;
    while (this.#running) {
      onProgress?.(total - this.#queue.length, total);
      await this.#running;
      if (this.#queue.length > 0) this.request([]);
    }
  }

  async #drain(): Promise<void> {
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms)));
    const gap = 1000 / this.opts.rps;
    let first = true;
    while (this.#queue.length > 0) {
      if (!first) await sleep(gap);
      first = false;
      const name = this.#queue.shift()!;
      const k = normalizeName(name);
      try {
        const c = await this.lookup.lookup(name);
        this.#entries.set(k, c ? { state: "found", counts: c } : { state: "none" });
      } catch {
        this.#entries.set(k, { state: "failed" });
      }
      this.#queued.delete(k);
    }
  }
}

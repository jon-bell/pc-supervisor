// The in-app paper filter: a HotCRP search the chair types (?search=…) in a
// "Search in" collection (?t=…, HotCRP's own `t`), resolved to a pid set by
// one read-only GET /search to PCS_HOTCRP_URL. The client ANDs
// PCS_PAPER_SEARCH in (hotcrp/scope.ts), so a filter never reaches outside
// the pinned scope. Views then evaluate only those papers
// (AnalysisSource.get({ pids })), so per-AC and per-reviewer aggregates are
// over the filtered papers too.
//
// - The search goes to HotCRP as typed (trimmed): nothing is rewritten, and
//   nothing HotCRP accepts is refused here (scope.ts searchProblem).
// - No ?t= = HotCRP's default collection for the chair: /search is sent
//   without `t`, exactly like HotCRP's quicksearch box, so `in:` keywords
//   widen it as they do there. An explicit ?t= must be a canonical
//   collection name (hotcrp/collections.ts).
// - The filter is on when ?search= is non-empty or ?t= is given.
// - Results are cached per (search, t) for CACHE_MS of wall time (the filter
//   box and every view of one page ask for the same search), at most
//   CACHE_SIZE searches.
// - HotCRP's warnings (unknown keyword, no such user, ...) don't stop the
//   filter: HotCRP still answers, and shows them above its results. They
//   come back with the pids (FilterResult.warnings) for the filter box.
// - Errors are FilterErrors with a status and a message safe to show: the
//   search's own problem (HotCRP's warning text, tags stripped, the token and
//   base URL redacted), or that HotCRP could not be reached. Never a body,
//   a URL, or the token.
// - HotCRP's answer is current; the store is as of the last sync. A pid
//   HotCRP matches that the store doesn't have just matches nothing.

import type { FastifyReply, FastifyRequest } from "fastify";
import { systemClock, type Clock } from "../clock.js";
import { isSearchCollection, type SearchCollectionName } from "../hotcrp/collections.js";
import { describeMessages, HotcrpError } from "../hotcrp/errors.js";
import type { HotcrpClient } from "../hotcrp/client.js";
import { searchProblem } from "../hotcrp/scope.js";
import { redact } from "../redact.js";
import type { AnalysisView } from "./analysis.js";
import type { RouteDeps } from "./app.js";

export const CACHE_MS = 60_000;
export const CACHE_SIZE = 32;
/** The query-string parameter that carries the filter, on every filtered route. */
export const FILTER_PARAM = "search";
/** The query-string parameter that carries the "Search in" collection ("" / absent = HotCRP's default). */
export const COLLECTION_PARAM = "t";

export class FilterError extends Error {
  constructor(
    readonly status: 400 | 502 | 503,
    message: string,
  ) {
    super(message);
    this.name = "FilterError";
  }
}

export type PaperSearcher = Pick<HotcrpClient, "search">;

/** A filter as a request gives it. t "" = HotCRP's default collection. */
export interface FilterSpec {
  search: string;
  t: string;
}

export interface FilterResult {
  /** Matching pids (within PCS_PAPER_SEARCH), sorted. */
  pids: readonly number[];
  /** The collection HotCRP searched (its echo of `t`), e.g. "s". */
  collection: string;
  /**
   * HotCRP's warnings about the search (e.g. an unknown keyword), cleaned
   * like errors. HotCRP shows these above its results and still answers;
   * so does the filter.
   */
  warnings: readonly string[];
}

export class PaperFilter {
  readonly #cache = new Map<string, { at: number; result: FilterResult }>();

  constructor(
    private readonly searcher: PaperSearcher | undefined,
    private readonly secrets: readonly string[] = [],
    private readonly wall: Clock = systemClock,
  ) {}

  /** The papers HotCRP matches for `term` in collection `t` (within PCS_PAPER_SEARCH), sorted. */
  async resolve(term: string, t = ""): Promise<readonly number[]> {
    return (await this.lookup(term, t)).pids;
  }

  /** resolve(), plus which collection HotCRP searched. */
  async lookup(term: string, t = ""): Promise<FilterResult> {
    const q = term.trim();
    const problem = searchProblem(q);
    if (problem) throw new FilterError(400, `That search ${problem}.`);
    const scope = checkCollection(t);
    if (!this.searcher) throw new FilterError(503, "HotCRP search is not available in this server.");
    const key = `${scope}\u0000${q}`;
    const now = this.wall.now().getTime();
    const hit = this.#cache.get(key);
    if (hit && now - hit.at < CACHE_MS) return hit.result;
    let res: Awaited<ReturnType<PaperSearcher["search"]>>;
    try {
      res = await this.searcher.search({ q, t: scope, keepWarnings: true });
    } catch (e) {
      throw this.#error(e);
    }
    const result: FilterResult = {
      pids: [...new Set(res.ids)].sort((a, b) => a - b),
      collection: new URLSearchParams(res.search_params).get("t") ?? (scope === "default" ? "" : scope),
      warnings: (res.message_list ?? []).filter((m) => m.status >= 1).map((m) => this.#clean(describeMessages([m]))).filter((m) => m !== ""),
    };
    this.#cache.delete(key);
    this.#cache.set(key, { at: now, result });
    while (this.#cache.size > CACHE_SIZE) this.#cache.delete(this.#cache.keys().next().value!);
    return result;
  }

  /** The collection HotCRP searches when no `t` is given (cached like a search; "" if unknown). */
  async defaultCollection(): Promise<string> {
    try {
      return (await this.lookup("NONE")).collection;
    } catch {
      return "";
    }
  }

  clear(): void {
    this.#cache.clear();
  }

  #error(e: unknown): FilterError {
    if (e instanceof HotcrpError) {
      if (e.kind === "api") {
        const said = this.#clean(describeMessages(e.messages));
        return new FilterError(400, said ? `HotCRP could not use that search: ${said}` : "HotCRP could not use that search.");
      }
      return new FilterError(502, `Could not run the search on HotCRP (${e.kind}${e.status ? ` ${e.status}` : ""}). Try again, or clear the filter.`);
    }
    throw e; // a bug, not a search problem: the app's error handler answers 500
  }

  #clean(s: string): string {
    const plain = s.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
    const out = redact(plain, this.secrets);
    return out.length > 300 ? `${out.slice(0, 299)}…` : out;
  }
}

function checkCollection(t: string): SearchCollectionName | "default" {
  const s = t.trim();
  if (s === "") return "default";
  if (isSearchCollection(s)) return s;
  throw new FilterError(400, `"Search in" must be one of HotCRP's collections (s, all, accepted, …), not ${JSON.stringify(s.slice(0, 40))}.`);
}

const param = (req: FastifyRequest, k: string): string => {
  const v = (req.query as Record<string, unknown> | undefined)?.[k];
  return typeof v === "string" ? v.trim() : "";
};

/** The ?search= term of a request ("" when absent). */
export function filterTerm(req: FastifyRequest): string {
  return param(req, FILTER_PARAM);
}

/** ?search= and ?t= of a request. */
export function filterOf(req: FastifyRequest): FilterSpec {
  return { search: param(req, FILTER_PARAM), t: param(req, COLLECTION_PARAM) };
}

/** Whether a spec filters at all (a search, or an explicit collection). */
export const isFiltering = (f: FilterSpec): boolean => f.search !== "" || f.t !== "";

/**
 * The analysis a paper-centric route should read: the whole store, or only
 * the papers ?search= (in ?t=) matches. On a filter error it sends the error
 * and returns null (the route then returns `reply`).
 */
export async function filteredView(req: FastifyRequest, reply: FastifyReply, deps: RouteDeps): Promise<AnalysisView | null> {
  const f = filterOf(req);
  if (!isFiltering(f)) return deps.analysis.get();
  try {
    return deps.analysis.get({ pids: await deps.paperFilter.resolve(f.search, f.t) });
  } catch (e) {
    if (e instanceof FilterError) {
      void reply.code(e.status).send({ error: e.message });
      return null;
    }
    throw e;
  }
}

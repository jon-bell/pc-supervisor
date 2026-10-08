// The in-app paper filter: a HotCRP search the chair types (?search=…),
// resolved to a pid set by one read-only GET /search to PCS_HOTCRP_URL. The
// client ANDs PCS_PAPER_SEARCH in (hotcrp/scope.ts), so a filter never
// reaches outside the pinned scope. Views then evaluate only those papers
// (AnalysisSource.get({ pids })), so per-AC and per-reviewer aggregates are
// over the filtered papers too.
//
// - Results are cached per search for CACHE_MS of wall time (the filter box
//   and every view of one page ask for the same search), at most CACHE_SIZE
//   searches.
// - Errors are FilterErrors with a status and a message safe to show: the
//   search's own problem (HotCRP's warning text, tags stripped, the token and
//   base URL redacted), or that HotCRP could not be reached. Never a body,
//   a URL, or the token.
// - HotCRP's answer is current; the store is as of the last sync. A pid
//   HotCRP matches that the store doesn't have just matches nothing.

import type { FastifyReply, FastifyRequest } from "fastify";
import { systemClock, type Clock } from "../clock.js";
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

export class PaperFilter {
  readonly #cache = new Map<string, { at: number; pids: readonly number[] }>();

  constructor(
    private readonly searcher: PaperSearcher | undefined,
    private readonly secrets: readonly string[] = [],
    private readonly wall: Clock = systemClock,
  ) {}

  /** The papers HotCRP matches for `term` (within PCS_PAPER_SEARCH), sorted. */
  async resolve(term: string): Promise<readonly number[]> {
    const q = term.trim();
    const problem = searchProblem(q);
    if (problem) throw new FilterError(400, `That search ${problem}.`);
    if (!this.searcher) throw new FilterError(503, "HotCRP search is not available in this server.");
    const now = this.wall.now().getTime();
    const hit = this.#cache.get(q);
    if (hit && now - hit.at < CACHE_MS) return hit.pids;
    let ids: number[];
    try {
      ids = (await this.searcher.search({ q, t: "all" })).ids;
    } catch (e) {
      throw this.#error(e);
    }
    const pids = [...new Set(ids)].sort((a, b) => a - b);
    this.#cache.delete(q);
    this.#cache.set(q, { at: now, pids });
    while (this.#cache.size > CACHE_SIZE) this.#cache.delete(this.#cache.keys().next().value!);
    return pids;
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

/** The ?search= term of a request ("" when absent). */
export function filterTerm(req: FastifyRequest): string {
  const v = (req.query as Record<string, unknown> | undefined)?.[FILTER_PARAM];
  return typeof v === "string" ? v.trim() : "";
}

/**
 * The analysis a paper-centric route should read: the whole store, or only
 * the papers ?search= matches. On a filter error it sends the error and
 * returns null (the route then returns `reply`).
 */
export async function filteredView(req: FastifyRequest, reply: FastifyReply, deps: RouteDeps): Promise<AnalysisView | null> {
  const term = filterTerm(req);
  if (term === "") return deps.analysis.get();
  try {
    return deps.analysis.get({ pids: await deps.paperFilter.resolve(term) });
  } catch (e) {
    if (e instanceof FilterError) {
      void reply.code(e.status).send({ error: e.message });
      return null;
    }
    throw e;
  }
}

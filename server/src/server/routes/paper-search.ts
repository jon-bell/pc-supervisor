// GET /api/paper-search?search=<HotCRP search>&t=<collection>: what the
// in-app filter box shows under itself. Resolves the search the way every
// filtered route does (paper-filter.ts: HotCRP /search ANDed with
// PCS_PAPER_SEARCH, cached), and says how many of the matches are in the
// local store. No search and no collection matches every paper (pids: null).

import type { FastifyInstance } from "fastify";
import type { PaperSearchResponse } from "../api-types.js";
import type { RouteDeps } from "../app.js";
import { FilterError, filterOf, isFiltering, type FilterResult } from "../paper-filter.js";

export function registerPaperSearch(app: FastifyInstance, deps: RouteDeps): void {
  app.get("/api/paper-search", async (req, reply): Promise<PaperSearchResponse | typeof reply> => {
    const f = filterOf(req);
    const scope = deps.cfg.hotcrp.paperSearch;
    if (!isFiltering(f)) return { search: f.search, t: f.t, collection: null, scope, pids: null, inStore: null, warnings: [] };
    let r: FilterResult;
    try {
      r = await deps.paperFilter.lookup(f.search, f.t);
    } catch (e) {
      if (e instanceof FilterError) return reply.code(e.status).send({ error: e.message });
      throw e;
    }
    const live = deps.analysis.get().analysis.evaluation.facts;
    return { search: f.search, t: f.t, collection: r.collection, scope, pids: [...r.pids], inStore: r.pids.filter((p) => live.has(p)).length, warnings: [...r.warnings] };
  });
}

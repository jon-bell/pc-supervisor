// GET /api/paper-search?search=<HotCRP search>: what the in-app filter box
// shows under itself. Resolves the search the way every filtered route does
// (paper-filter.ts: HotCRP /search ANDed with PCS_PAPER_SEARCH, cached), and
// says how many of the matches are in the local store. An empty search
// matches every paper (pids: null).

import type { FastifyInstance } from "fastify";
import type { PaperSearchResponse } from "../api-types.js";
import type { RouteDeps } from "../app.js";
import { FilterError, filterTerm } from "../paper-filter.js";

export function registerPaperSearch(app: FastifyInstance, deps: RouteDeps): void {
  app.get("/api/paper-search", async (req, reply): Promise<PaperSearchResponse | typeof reply> => {
    const search = filterTerm(req);
    const scope = deps.cfg.hotcrp.paperSearch;
    if (search === "") return { search, scope, pids: null, inStore: null };
    let pids: readonly number[];
    try {
      pids = await deps.paperFilter.resolve(search);
    } catch (e) {
      if (e instanceof FilterError) return reply.code(e.status).send({ error: e.message });
      throw e;
    }
    const live = deps.analysis.get().analysis.evaluation.facts;
    return { search, scope, pids: [...pids], inStore: pids.filter((p) => live.has(p)).length };
  });
}

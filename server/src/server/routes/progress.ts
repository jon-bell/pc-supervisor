// GET /api/tier-progress (spec §10.4 D) and GET /api/early-reject (§10.4 E),
// PLAN M12. Both read the cached analysis (rules/index.ts) plus a couple of
// indexed store queries; neither returns review or comment text.

import type { FastifyInstance } from "fastify";
import { earlyRejectFrom, type EarlyRejectReport } from "../../modules/early-reject/index.js";
import { tierProgressFrom, type TierProgressReport } from "../../modules/tier-progress/index.js";
import type { RouteDeps } from "../app.js";

export function registerTierProgress(app: FastifyInstance, deps: RouteDeps): void {
  app.get("/api/tier-progress", async (): Promise<TierProgressReport> => tierProgressFrom(deps.analysis.get(), deps.store, deps.cfg));
}

export function registerEarlyReject(app: FastifyInstance, deps: RouteDeps): void {
  app.get("/api/early-reject", async (): Promise<EarlyRejectReport> => {
    const view = deps.analysis.get();
    return earlyRejectFrom(view.analysis.evaluation.index, deps.store, deps.cfg, view.ctx.now);
  });
}

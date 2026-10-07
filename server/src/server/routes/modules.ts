// Phase-2 module routes (spec §10.4, PLAN M11):
// - GET /api/reserve: reserve-reviewer compliance (module A);
// - GET /api/quickreject: the quick-reject / desk-reject queue (module B).
// Each answers with the module's report plus its activation status (phase
// window). Both are computed from the local store and imports per request
// (indexed scans; no HotCRP call). With PCS_DBLP_ENABLED, /api/reserve shows
// the DBLP hints looked up so far and queues the rest in the background at
// PCS_DBLP_RPS: the only non-HotCRP outbound call, opt-in (spec §7).

import type { FastifyInstance } from "fastify";
import { quickRejectReport } from "../../modules/quickreject/index.js";
import { dblpCacheFromConfig, reserveReport, type AuthorLookup } from "../../modules/reserve/index.js";
import { moduleStatus } from "../../modules/status.js";
import { phaseTimesFromConfig, type ModuleId } from "../../rules/phase.js";
import type { ModuleResponseBase, QuickRejectResponse, ReserveResponse } from "../api-types.js";
import type { RegisterRoutes, RouteDeps } from "../app.js";

function base(deps: RouteDeps, id: ModuleId): ModuleResponseBase {
  const now = deps.clock.now().getTime();
  return { now, tz: deps.cfg.tz, module: moduleStatus(id, phaseTimesFromConfig(deps.cfg.phases), now) };
}

/** Route factory; tests pass a fake DBLP lookup. */
export function makeRegisterModules(o: { dblpLookup?: AuthorLookup } = {}): RegisterRoutes {
  return (app: FastifyInstance, deps: RouteDeps) => {
    const cache = dblpCacheFromConfig(deps.cfg, o.dblpLookup);

    app.get("/api/reserve", async (): Promise<ReserveResponse> => {
      const report = reserveReport(deps.store, deps.cfg, { clock: deps.clock, cache, requestMissing: true });
      return { ...base(deps, "reserve-compliance"), ...report };
    });

    app.get("/api/quickreject", async (): Promise<QuickRejectResponse> => {
      const report = quickRejectReport(deps.store, deps.cfg, { clock: deps.clock });
      return { ...base(deps, "quick-reject"), ...report };
    });
  };
}

export const registerModules = makeRegisterModules();

// GET /api/meta: phase, now, HotCRP base URL for deep links, rule names and
// weights, tiers. GET /api/sync/status and POST /api/sync ("sync now").

import type { FastifyInstance } from "fastify";
import { RATING_FLAGS } from "../../ratings.js";
import { phaseAt } from "../../rules/phase.js";
import { redact } from "../../redact.js";
import type { SyncRunRow } from "../../store/store.js";
import type { MetaResponse, SyncRunInfo, SyncStatus } from "../api-types.js";
import type { RouteDeps } from "../app.js";

export function registerMeta(app: FastifyInstance, deps: RouteDeps): void {
  app.get("/api/meta", async (): Promise<MetaResponse> => {
    const { ctx } = deps.analysis.get();
    const { cfg } = deps;
    return {
      now: ctx.now,
      pinned: deps.clock.pinned,
      phase: phaseAt(ctx.phases, ctx.now),
      tz: cfg.tz,
      hotcrpUrl: cfg.hotcrp.url,
      phases: ctx.phases,
      rules: deps.ruleNames.map((name) => ({ name, weight: ctx.weights[name] })),
      tiers: ["senior", ...Object.keys(cfg.tierTags)],
      tiersConfigured: Object.keys(cfg.tierTags).length > 0,
      fields: cfg.fields,
      ratings: { ...deps.store.ratingSettings(), flags: [...RATING_FLAGS] },
      paperSearch: cfg.hotcrp.paperSearch,
    };
  });
}

function runInfo(r: SyncRunRow | undefined, token: string): SyncRunInfo | null {
  if (!r) return null;
  return {
    id: r.id,
    kind: r.kind,
    startedAt: r.startedAt * 1000,
    finishedAt: r.finishedAt === null ? null : r.finishedAt * 1000,
    nowUsed: r.nowUsed * 1000,
    ok: r.ok,
    counts: r.counts,
    errors: r.errors.map((e) => redact(e, [token])),
  };
}

export function registerSync(app: FastifyInstance, deps: RouteDeps): void {
  const status = (): SyncStatus => {
    const token = deps.cfg.hotcrp.token;
    return {
      running: deps.sync?.running ?? false,
      lastError: deps.sync?.lastError ? redact(deps.sync.lastError, [token]) : null,
      last: runInfo(deps.store.lastSync(), token),
      lastSuccessful: runInfo(deps.store.lastSuccessfulSync(), token),
      lastBackfill: runInfo(deps.store.lastSync("backfill"), token),
      intervalMin: deps.cfg.sync.intervalMin,
    };
  };

  app.get("/api/sync/status", async () => status());

  app.post("/api/sync", async (_req, reply) => {
    if (!deps.sync) return reply.code(503).send({ error: "sync is not available in this server" });
    if (!deps.sync.start()) return reply.code(409).send({ error: "a sync is already running", ...status() });
    return reply.code(202).send(status());
  });
}

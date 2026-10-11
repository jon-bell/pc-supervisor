// Rule settings (spec §5c "Rule settings", §6b API):
//   GET  /api/rules             effective settings, env defaults, metadata, counts
//   PUT  /api/rules             {changes, note?}: validate, save a revision,
//                               record flag history (cause 'rules')
//   POST /api/rules/preview     {changes}: dry run over the cached evaluation;
//                               nothing is saved
//   GET  /api/rules/revisions   every revision, newest first, with its diff
//   POST /api/rules/revert      {to, note?}: restore revision `to` (0 = env defaults)
// No HotCRP call: the analysis cache keys on the revision id. The writes
// refuse a cross-origin Origin header like the tag routes (actions.ts).

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { recordFlags } from "../../history/flags.js";
import { previewRules, ruleCounts } from "../../rules/preview.js";
import { applyChanges, flatSettings, PHASE_LABEL, RULE_META, SETTING_META } from "../../rules/settings.js";
import { effectiveSettings, revertRules, ruleContextWith, RuleSettingsError, updateRules, type ChangeResult } from "../../rule-settings/service.js";
import { listRevisions, type RuleRevision } from "../../rule-settings/store.js";
import type { RevisionInfo, RevisionsResponse, RulesChangeResponse, RulesPreviewResponse, RulesResponse } from "../rules-types.js";
import type { RouteDeps } from "../app.js";
import { allowedOrigins } from "./actions.js";

export function revisionInfo(r: RuleRevision): RevisionInfo {
  return { id: r.id, at: r.at, actor: r.actor, kind: r.kind, revertedTo: r.revertedTo, note: r.note, diff: r.diff, overrideCount: Object.keys(r.overrides).length };
}

export function rulesState(deps: RouteDeps): RulesResponse {
  const view = deps.analysis.get();
  const eff = effectiveSettings(deps.store, deps.cfg);
  const values = flatSettings(eff.settings);
  const defaults = flatSettings(eff.defaults);
  const counts = ruleCounts(view.analysis.evaluation.results);
  return {
    now: view.ctx.now,
    revision: eff.revision ? revisionInfo(eff.revision) : null,
    rules: RULE_META.map((m) => ({
      ...m,
      phaseLabel: PHASE_LABEL[m.phase],
      enabled: eff.settings.enabled[m.name],
      weight: eff.settings.weights[m.name],
      papers: counts.byRule[m.name],
    })),
    settings: SETTING_META.map((m) => ({ ...m, value: values[m.key], default: defaults[m.key], overridden: eff.overrides[m.key] !== undefined })),
    papers: view.analysis.evaluation.results.length,
    counts,
  };
}

export function registerRules(app: FastifyInstance, deps: RouteDeps): void {
  const origins = allowedOrigins(deps.cfg.port, deps.cfg.dev ?? false);
  const guard = (req: FastifyRequest, reply: FastifyReply): boolean => {
    const origin = req.headers.origin;
    if (origin !== undefined && !origins.has(origin.toLowerCase())) {
      void reply.code(403).send({ error: "cross-origin requests may not change rule settings" });
      return false;
    }
    return true;
  };
  const fail = (e: unknown, reply: FastifyReply) => {
    if (e instanceof RuleSettingsError) return reply.code(e.status).send({ error: e.message, code: e.code, errors: e.errors });
    throw e;
  };
  const actor = async () => (deps.actor ? await deps.actor() : "local");

  /** After a revision: record what it flagged and unflagged (the cache already keys on the new revision). */
  const committed = (r: ChangeResult): RulesChangeResponse => {
    const view = deps.analysis.get();
    const h = recordFlags(deps.store.db, view.analysis.evaluation.results, { atMs: view.ctx.now, cause: "rules", revisionId: r.revision.id });
    return { revision: revisionInfo(r.revision), history: { raised: h.raised, cleared: h.cleared }, rules: rulesState(deps) };
  };

  app.get("/api/rules", async (): Promise<RulesResponse> => rulesState(deps));

  app.get("/api/rules/revisions", async (): Promise<RevisionsResponse> => ({ revisions: listRevisions(deps.store.db).map(revisionInfo) }));

  app.put("/api/rules", async (req, reply) => {
    if (!guard(req, reply)) return reply;
    const b = (req.body ?? {}) as { changes?: unknown; note?: unknown };
    try {
      const r = updateRules(deps.store, deps.cfg, b.changes, { actor: await actor(), atMs: deps.clock.now().getTime(), note: b.note });
      return committed(r);
    } catch (e) {
      return fail(e, reply);
    }
  });

  app.post("/api/rules/revert", async (req, reply) => {
    if (!guard(req, reply)) return reply;
    const b = (req.body ?? {}) as { to?: unknown; note?: unknown };
    try {
      const r = revertRules(deps.store, deps.cfg, b.to, { actor: await actor(), atMs: deps.clock.now().getTime(), note: b.note });
      return committed(r);
    } catch (e) {
      return fail(e, reply);
    }
  });

  app.post("/api/rules/preview", async (req, reply) => {
    if (!guard(req, reply)) return reply;
    const b = (req.body ?? {}) as { changes?: unknown };
    if (!b.changes || typeof b.changes !== "object" || Array.isArray(b.changes)) {
      return reply.code(400).send({ error: "changes must be an object of setting -> value (null = env default)", code: "invalid" });
    }
    const eff = effectiveSettings(deps.store, deps.cfg);
    const { overrides, errors } = applyChanges(eff.overrides, b.changes as Record<string, unknown>);
    if (errors.length) return reply.code(400).send({ error: errors.map((e) => `${e.key}: ${e.error}`).join("; "), code: "invalid", errors });
    const view = deps.analysis.get();
    const proposed = ruleContextWith(deps.cfg, overrides, view.ctx.now);
    const body: RulesPreviewResponse = previewRules(view.analysis.evaluation, proposed);
    return body;
  });
}

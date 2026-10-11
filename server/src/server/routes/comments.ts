// Comment types (spec §5e):
//   GET /api/classifier              which classifier is active, counts, the last run
//   PUT /api/comments/:cid/label     {kind | null}: the chair relabels a comment (null = back to the classifier)
//   GET /api/comment-labels          the relabel audit trail, newest first (?cid=, ?limit=)
// A relabel is local (no HotCRP call): it appends a comment_label_revision
// row, bumps the label generation (the analysis cache re-reads labels), and
// with the model active retrains the head and re-predicts in the background.
// When a comment rule ignores comment types, the relabel can change flags, so
// flag history records it (cause 'data'). The write refuses a cross-origin
// Origin header like the rule-settings routes.

import type { FastifyInstance } from "fastify";
import { recordFlags } from "../../history/flags.js";
import { COMMENT_RULES } from "../../config.js";
import { isCommentKind } from "../../classifier/kinds.js";
import { effectiveLabels, labelRevisions, relabel, RelabelError, type EffectiveLabel, type LabelRevision } from "../../classifier/store.js";
import type { CommentClassifier } from "../../classifier/service.js";
import type { CommentLabelResponse, CommentLabelRevision, CommentType, CommentTypesMeta } from "../api-types.js";
import type { RouteDeps } from "../app.js";
import { allowedOrigins } from "./actions.js";

export function commentType(l: EffectiveLabel | undefined, minConfidence: number): CommentType | null {
  if (!l) return null;
  return { kind: l.kind, source: l.source, confidence: l.confidence, low: l.source !== "chair" && l.confidence < minConfidence, classifier: l.classifier };
}

export function revisionInfo(r: LabelRevision): CommentLabelRevision {
  return { id: r.id, at: r.at, actor: r.actor, cid: r.cid, pid: r.pid, kind: r.kind, previous: r.previous, previousSource: r.previousSource };
}

export async function commentTypesMeta(c: CommentClassifier | undefined, deps: Pick<RouteDeps, "cfg">): Promise<CommentTypesMeta> {
  const s = deps.cfg.commentClassifier;
  if (!c) return { configured: s?.mode ?? "heuristic", active: s?.mode === "off" ? "off" : "heuristic", fallback: null, minConfidence: s?.minConfidence ?? 0.6, running: false };
  const active = await c.active();
  const st = await c.status();
  return { configured: c.settings.mode, active, fallback: st.fallback, minConfidence: c.settings.minConfidence, running: c.running };
}

export function registerComments(app: FastifyInstance, deps: RouteDeps): void {
  const origins = allowedOrigins(deps.cfg.port, deps.cfg.dev ?? false);
  const minConfidence = () => deps.classifier?.settings.minConfidence ?? deps.cfg.commentClassifier?.minConfidence ?? 0.6;

  app.get("/api/classifier", async (_req, reply) => {
    if (!deps.classifier) return reply.code(503).send({ error: "the comment classifier is not available in this server" });
    return deps.classifier.status();
  });

  app.get<{ Querystring: { cid?: string; limit?: string } }>("/api/comment-labels", async (req, reply) => {
    const cid = req.query.cid;
    const limit = req.query.limit;
    if (cid !== undefined && !/^\d{1,9}$/.test(cid)) return reply.code(400).send({ error: "cid must be a positive integer" });
    if (limit !== undefined && !/^\d{1,3}$/.test(limit)) return reply.code(400).send({ error: "limit must be 1-500" });
    const items = labelRevisions(deps.store.db, { cid: cid === undefined ? undefined : Number(cid), limit: Math.min(500, Math.max(1, Number(limit ?? 200))) });
    const titles = new Map(deps.analysis.get().snapshot.papers.map((p) => [p.pid, p.title]));
    return { items: items.map((r) => ({ ...revisionInfo(r), title: titles.get(r.pid) ?? null })) };
  });

  app.put<{ Params: { cid: string } }>("/api/comments/:cid/label", async (req, reply) => {
    const origin = req.headers.origin;
    if (origin !== undefined && !origins.has(origin.toLowerCase())) return reply.code(403).send({ error: "cross-origin requests may not relabel comments" });
    if (!/^\d{1,9}$/.test(req.params.cid)) return reply.code(400).send({ error: "cid must be a positive integer" });
    if ((deps.cfg.commentClassifier?.mode ?? "heuristic") === "off") return reply.code(409).send({ error: "the comment classifier is off (PCS_COMMENT_CLASSIFIER=off)" });
    const body = (req.body ?? {}) as { kind?: unknown };
    if (!("kind" in body) || !(body.kind === null || isCommentKind(body.kind))) {
      return reply.code(400).send({ error: "kind must be ping, reply, discussion, nonsubstantive, or null (back to the classifier)" });
    }
    const cid = Number(req.params.cid);
    let rev: LabelRevision;
    try {
      rev = relabel(deps.store.db, { cid, kind: body.kind, actor: deps.actor ? await deps.actor() : "local", atMs: deps.clock.now().getTime() });
    } catch (e) {
      if (e instanceof RelabelError) return reply.code(e.status).send({ error: e.message });
      throw e;
    }
    // Labels feed the comment rules only when a rule ignores a comment type.
    const view = deps.analysis.get();
    const ig = view.ctx.ignore;
    if (ig && COMMENT_RULES.some((r) => ig[r].nonSubstantive || ig[r].pings)) {
      recordFlags(deps.store.db, view.analysis.evaluation.results, { atMs: view.ctx.now, cause: "data" });
    }
    // The model's head learns from the chair's labels: retrain and re-predict, off the request.
    if (deps.classifier && (await deps.classifier.active()) === "model") {
      deps.classifier.run().catch(() => undefined);
    }
    const out: CommentLabelResponse = { cid, type: commentType(effectiveLabels(deps.store.db, [cid]).get(cid), minConfidence()), revision: revisionInfo(rev) };
    return out;
  });
}

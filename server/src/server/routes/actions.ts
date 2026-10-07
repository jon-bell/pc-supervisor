// v1 actions (PLAN M8, spec §6):
//   GET  /api/actions             the attention tag, whether tagging is available
//   GET  /api/papers/:pid/nudge   a nudge-comment draft (text only; never posted)
//   POST /api/tags/preview        HotCRP dry run of adding/removing the tag; a
//                                 single-use token for the exact diff
//   POST /api/tags/commit         the confirmed write (see actions/tagging.ts),
//                                 then a re-sync so the tags show
// The tag routes refuse any Origin header but this server's own (loopback
// name + PCS_PORT), or the Vite dev server's under PCS_DEV, on top of the
// loopback-Host check; HotCRP errors come back redacted.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { nudgeDraft } from "../../actions/nudge.js";
import { TagFlowError } from "../../actions/tagging.js";
import { HotcrpError } from "../../hotcrp/errors.js";
import { redact } from "../../redact.js";
import type { ActionsInfo, NudgeResponse, TagCommitResponse, TagPaper, TagPreviewResponse } from "../action-types.js";
import { personOf, type RouteDeps } from "../app.js";

/** The Vite dev server's port (web/vite.config.ts server.port). */
export const VITE_DEV_PORT = 5173;

/** Origins allowed to change tags: this server's, plus the Vite dev server's when `dev`. */
export function allowedOrigins(port: number, dev: boolean): ReadonlySet<string> {
  const ports = dev ? [port, VITE_DEV_PORT] : [port];
  return new Set(ports.flatMap((p) => ["127.0.0.1", "localhost", "[::1]"].map((h) => `http://${h}:${p}`)));
}

export function registerActions(app: FastifyInstance, deps: RouteDeps): void {
  const token = deps.cfg.hotcrp.token;
  const origins = allowedOrigins(deps.cfg.port, deps.cfg.dev ?? false);

  app.get("/api/actions", async (): Promise<ActionsInfo> => ({
    attentionTag: deps.cfg.attentionTag,
    taggingAvailable: deps.tagFlow !== undefined,
    previewTtlMs: deps.tagFlow?.ttlMs ?? 0,
  }));

  app.get<{ Params: { pid: string } }>("/api/papers/:pid/nudge", async (req, reply) => {
    if (!/^\d{1,9}$/.test(req.params.pid)) return reply.code(400).send({ error: "pid must be a positive integer" });
    const pid = Number(req.params.pid);
    const view = deps.analysis.get();
    const facts = view.analysis.evaluation.facts.get(pid);
    const result = view.analysis.evaluation.byPid.get(pid);
    if (!facts || !result) return reply.code(404).send({ error: `no paper #${pid} in the local store` });
    const d = nudgeDraft(facts, result, view.people, view.ctx);
    const body: NudgeResponse = { pid, audience: d.audience, mentions: d.mentions.map((m) => personOf(view.people, m.email)), text: d.text };
    return body;
  });

  const guard = (req: FastifyRequest, reply: FastifyReply): boolean => {
    const origin = req.headers.origin;
    if (origin !== undefined && !origins.has(origin.toLowerCase())) {
      void reply.code(403).send({ error: "cross-origin requests may not change tags" });
      return false;
    }
    if (!deps.tagFlow) {
      void reply.code(503).send({ error: "tagging is not available in this server" });
      return false;
    }
    return true;
  };

  const fail = (e: unknown, reply: FastifyReply) => {
    if (e instanceof TagFlowError) return reply.code(e.status).send({ error: e.message, code: e.code });
    if (e instanceof HotcrpError) return reply.code(502).send({ error: redact(e.message, [token]), code: "hotcrp" });
    if (e instanceof RangeError) return reply.code(400).send({ error: redact(e.message, [token]), code: "invalid" });
    throw e;
  };

  const titled = (pids: readonly number[]): TagPaper[] => {
    const facts = deps.analysis.get().analysis.evaluation.facts;
    return pids.map((pid) => ({ pid, title: facts.get(pid)?.bundle.paper.title ?? null }));
  };

  app.post("/api/tags/preview", async (req, reply) => {
    if (!guard(req, reply)) return reply;
    const b = (req.body ?? {}) as { add?: unknown; remove?: unknown };
    try {
      const p = await deps.tagFlow!.preview({ add: b.add, remove: b.remove });
      const body: TagPreviewResponse = { ...p, gain: titled(p.gain), lose: titled(p.lose) };
      return body;
    } catch (e) {
      return fail(e, reply);
    }
  });

  app.post("/api/tags/commit", async (req, reply) => {
    if (!guard(req, reply)) return reply;
    const b = (req.body ?? {}) as { token?: unknown; gain?: unknown; lose?: unknown; confirm?: unknown };
    try {
      const done = await deps.tagFlow!.commit(b);
      deps.analysis.invalidate();
      const body: TagCommitResponse = { tag: deps.tagFlow!.tag, ...done, syncStarted: deps.sync?.start() ?? false };
      return body;
    } catch (e) {
      return fail(e, reply);
    }
  });
}

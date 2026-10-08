// Assignment routes (spec §10.4 C and §10.5, PLAN M10/M10b):
//   GET  /api/assignment[?source=tpms]  M10's validator on the current HotCRP
//                                       assignment (last sync) or the latest
//                                       tpms-assignments import
//   GET  /api/assignment/solve          the last solve report (null if none yet)
//   POST /api/assignment/solve          run the solver ({ hard?: boolean }) and
//                                       cache its report
// The validator reads only the local store. The solver also makes two
// read-only HotCRP downloads (PC conflicts, review preferences) and takes
// seconds at scale, so it runs on POST and the result is cached until the
// next run. POST refuses any Origin but this server's. Nothing is applied to
// HotCRP: the bulk-assign CSV is for the chair to upload. Reports carry pids,
// emails, affiliations, scores, and counts, never review or comment text.

import type { FastifyInstance } from "fastify";
import { HotcrpError } from "../../hotcrp/errors.js";
import { redact } from "../../redact.js";
import { NoTpmsImportError, validateAssignments } from "../../modules/assignment/index.js";
import { solveAssignments } from "../../modules/solver/index.js";
import { moduleStatus } from "../../modules/status.js";
import { phaseTimesFromConfig } from "../../rules/phase.js";
import type { AssignmentResponse, SolveResponse } from "../assignment-types.js";
import type { RouteDeps } from "../app.js";
import { allowedOrigins } from "./actions.js";

export function registerAssignment(app: FastifyInstance, deps: RouteDeps): void {
  const token = deps.cfg.hotcrp.token;
  const origins = allowedOrigins(deps.cfg.port, deps.cfg.dev ?? false);
  const base = () => {
    const now = deps.clock.now().getTime();
    return { now, tz: deps.cfg.tz, module: moduleStatus("assignment-validator", phaseTimesFromConfig(deps.cfg.phases), now) };
  };

  app.get<{ Querystring: { source?: string } }>("/api/assignment", async (req, reply) => {
    const source = req.query.source ?? "hotcrp";
    if (source !== "hotcrp" && source !== "tpms") return reply.code(400).send({ error: "source must be hotcrp or tpms" });
    try {
      const report = validateAssignments(deps.store, deps.cfg, { source, clock: deps.clock });
      const body: AssignmentResponse = { ...base(), report };
      return body;
    } catch (e) {
      if (e instanceof NoTpmsImportError) return reply.code(404).send({ error: e.message });
      throw e;
    }
  });

  let last: { report: SolveResponse["report"]; computedAt: number } | null = null;
  let running: Promise<unknown> | null = null;
  const current = (): SolveResponse => ({ ...base(), report: last?.report ?? null, computedAt: last?.computedAt ?? null, running: running !== null, available: deps.solverHotcrp !== undefined });

  app.get("/api/assignment/solve", async (): Promise<SolveResponse> => current());

  app.post("/api/assignment/solve", async (req, reply) => {
    const origin = req.headers.origin;
    if (origin !== undefined && !origins.has(origin.toLowerCase())) {
      return reply.code(403).send({ error: "cross-origin requests may not run the solver" });
    }
    if (!deps.solverHotcrp) return reply.code(503).send({ error: "the solver needs HotCRP access (conflicts, preferences), which this server doesn't have" });
    if (running) return reply.code(409).send({ error: "a solve is already running" });
    const b = (req.body ?? {}) as { hard?: unknown };
    if (b.hard !== undefined && typeof b.hard !== "boolean") return reply.code(400).send({ error: "hard must be a boolean" });
    const job = solveAssignments(deps.store, deps.cfg, { clock: deps.clock, client: deps.solverHotcrp, ...(b.hard === true ? { hard: true } : {}) });
    running = job;
    let report;
    try {
      report = await job;
    } catch (e) {
      if (e instanceof HotcrpError) return reply.code(502).send({ error: redact(e.message, [token]), code: "hotcrp" });
      throw e;
    } finally {
      running = null;
    }
    last = { report, computedAt: deps.clock.now().getTime() };
    return current();
  });
}

// GET /api/leads: one row per discussion lead (HotCRP `lead`), the AC table's
// analogue (rules/lead-metrics.ts holds the definitions). GET
// /api/leads/:email: that lead's papers (the drill-down). Rows are
// alphabetical by name, not ranked (spec §7). Leads come from the store's
// synced assignments (role "lead"), whatever PCS_AC_ROLE says; papers outside
// the cached analysis are left out.

import type { FastifyInstance } from "fastify";
import { computeLeadMetrics, type LeadMetrics } from "../../rules/lead-metrics.js";
import type { PersonView } from "../../rules/model.js";
import type { LeadDetailResponse, LeadPaper, LeadRow, LeadsResponse } from "../api-types.js";
import { personOf, type RouteDeps } from "../app.js";
import { byName } from "./acs.js";

const EMAIL = /^[^\s@/]{1,128}@[^\s@/]{1,255}$/;

function leadRow(m: LeadMetrics, people: ReadonlyMap<string, PersonView>): LeadRow {
  return {
    person: personOf(people, m.email),
    pids: [...m.pids],
    load: m.load,
    flagged: m.flagged,
    flaggedPids: [...m.flaggedPids],
    reviews: { ...m.reviews },
    comments: { ...m.comments },
    leadComments: { ...m.leadComments },
    commentedPids: [...m.commentedPids],
    notYetPids: [...m.notYetPids],
    stale: m.stale,
    stalePids: [...m.stalePids],
    activity: { start: m.activity.start, daily: [...m.activity.daily] },
  };
}

export function registerLeads(app: FastifyInstance, deps: RouteDeps): void {
  const metrics = () => {
    const view = deps.analysis.get();
    const leads = computeLeadMetrics(view.analysis.evaluation, view.ctx, deps.store.areaChairs({ kind: "lead" }));
    return { view, leads };
  };

  app.get("/api/leads", async (): Promise<LeadsResponse> => {
    const { view, leads } = metrics();
    const rows = leads.map((m) => leadRow(m, view.people)).sort(byName);
    const led = new Set(leads.flatMap((m) => m.pids));
    return {
      now: view.ctx.now,
      maxLoad: rows.reduce((n, r) => Math.max(n, r.load), 0),
      papers: view.analysis.evaluation.facts.size,
      papersWithLead: led.size,
      leads: rows,
    };
  });

  app.get<{ Params: { email: string } }>("/api/leads/:email", async (req, reply) => {
    const email = req.params.email.trim().toLowerCase();
    if (!EMAIL.test(email)) return reply.code(400).send({ error: "expected an email address" });
    const { view, leads } = metrics();
    const m = leads.find((x) => x.email === email);
    if (!m) return reply.code(404).send({ error: "not a discussion lead on any paper in the local store" });
    const ev = view.analysis.evaluation;
    const papers: LeadPaper[] = m.papers.map((p) => {
      const f = ev.facts.get(p.pid)!;
      const result = ev.byPid.get(p.pid);
      return {
        pid: p.pid,
        title: f.bundle.paper.title,
        decision: f.bundle.paper.decision,
        acs: f.bundle.acs.map((e) => personOf(view.people, e)),
        merits: [...f.merits],
        reviews: { ...p.reviews },
        comments: { ...p.comments },
        leadComments: { ...p.leadComments },
        leadLastComment: p.leadLastComment,
        lastActivity: result?.lastActivity ?? null,
        stale: p.stale,
        severity: result?.severity ?? 0,
        reasons: result?.fired.map((x) => ({ rule: x.rule, weight: x.weight, reason: x.reason })) ?? [],
      };
    });
    const body: LeadDetailResponse = { now: view.ctx.now, reviewsRequired: view.ctx.reviewsRequired, lead: leadRow(m, view.people), papers };
    return body;
  });
}

// GET /api/triage: every paper with its fired rules, severity, AC, scores,
// tier mix and last activity, in triage order (spec §5c). Filters (each
// optional, comma-separated values are OR-ed, filters are AND-ed):
//   ?ac=<email>     papers where that person is an area chair
//   ?rule=<NAME>    papers firing that rule
//   ?tier=<tier>    papers with a reviewer of that tier
//   ?search=<q>     papers matching that HotCRP search (paper-filter.ts);
//                   unlike the others it narrows the facets and `total` too
// Facets count over the unfiltered list, so the UI's filter menus stay put.

import type { FastifyInstance } from "fastify";
import type { TriageResponse, TriageRow } from "../api-types.js";
import type { AnalysisView } from "../analysis.js";
import { personOf, type RouteDeps } from "../app.js";
import { filteredView } from "../paper-filter.js";

function list(v: unknown): string[] | null {
  if (typeof v !== "string" || v.trim() === "") return null;
  return v.split(",").map((x) => x.trim()).filter((x) => x !== "");
}

/** All triage rows, unfiltered, in triage order. */
export function triageRows(view: AnalysisView): TriageRow[] {
  const { analysis, people } = view;
  const ev = analysis.evaluation;
  return ev.results.map((r) => {
    const f = ev.facts.get(r.pid)!;
    const tiers: Record<string, number> = {};
    for (const rv of f.reviewerReviews) {
      const t = people.get(rv.email)?.tier ?? "senior";
      tiers[t] = (tiers[t] ?? 0) + 1;
    }
    return {
      pid: r.pid,
      title: f.bundle.paper.title,
      decision: f.bundle.paper.decision,
      acs: f.bundle.acs.map((e) => personOf(people, e)),
      merits: [...f.merits],
      expertise: f.submitted.flatMap((x) => (x.expertise === null ? [] : [x.expertise])),
      scores: f.submitted.map((x) => ({ ordinal: x.ordinal, merit: x.merit, expertise: x.expertise })),
      reviews: { submitted: f.submitted.length, assigned: f.reviewerReviews.length },
      tiers,
      severity: r.severity,
      reasons: r.fired.map((x) => ({ rule: x.rule, weight: x.weight, reason: x.reason })),
      lastActivity: r.lastActivity,
      decisionsDue: r.decisionsDue,
      tags: [...f.bundle.paper.tags],
    };
  });
}

export function registerTriage(app: FastifyInstance, deps: RouteDeps): void {
  app.get("/api/triage", async (req, reply): Promise<TriageResponse | typeof reply> => {
    const view = await filteredView(req, reply, deps);
    if (!view) return reply;
    const q = req.query as Record<string, unknown>;
    const acs = list(q.ac)?.map((x) => x.toLowerCase()) ?? null;
    const rules = list(q.rule);
    const tiers = list(q.tier);
    const all = triageRows(view);

    const acCount = new Map<string, number>();
    const ruleCount = new Map<string, number>();
    const tierCount = new Map<string, number>();
    for (const row of all) {
      for (const a of row.acs) acCount.set(a.email, (acCount.get(a.email) ?? 0) + 1);
      for (const r of row.reasons) ruleCount.set(r.rule, (ruleCount.get(r.rule) ?? 0) + 1);
      for (const t of Object.keys(row.tiers)) tierCount.set(t, (tierCount.get(t) ?? 0) + 1);
    }

    const papers = all.filter(
      (row) =>
        (!acs || row.acs.some((a) => acs.includes(a.email))) &&
        (!rules || row.reasons.some((r) => rules.includes(r.rule))) &&
        (!tiers || tiers.some((t) => (row.tiers[t] ?? 0) > 0)),
    );
    return {
      now: view.ctx.now,
      total: all.length,
      papers,
      facets: {
        acs: [...acCount]
          .map(([email, n]) => ({ ...personOf(view.people, email), papers: n }))
          .sort((a, b) => a.name.localeCompare(b.name) || a.email.localeCompare(b.email)),
        rules: deps.ruleNames.filter((r) => ruleCount.has(r)).map((rule) => ({ rule, papers: ruleCount.get(rule)! })),
        tiers: [...tierCount].map(([tier, n]) => ({ tier, papers: n })).sort((a, b) => a.tier.localeCompare(b.tier)),
      },
    };
  });
}

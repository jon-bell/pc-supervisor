// GET /api/acs: one row per area chair (spec §5b), from the cached analysis
// (rules/ac-metrics.ts holds the definitions). Rows are alphabetical by name:
// the AC table is not a ranking (spec §7); the UI may re-sort by a column.

import type { FastifyInstance } from "fastify";
import type { AcMetrics } from "../../rules/ac-metrics.js";
import type { PersonView } from "../../rules/model.js";
import type { AcRow, AcsResponse } from "../api-types.js";
import { personOf, type RouteDeps } from "../app.js";

export function acRow(m: AcMetrics, people: ReadonlyMap<string, PersonView>): AcRow {
  const byStatus: Record<string, number> = {};
  for (const [k, v] of Object.entries(m.metareview.byStatus)) if (v) byStatus[k] = v;
  return {
    person: personOf(people, m.email),
    pids: [...m.pids].sort((a, b) => a - b),
    load: m.load,
    flagged: m.flagged,
    flaggedPids: [...m.flaggedPids].sort((a, b) => a - b),
    coverage: { ...m.coverage },
    timeToFirstPost: { ...m.timeToFirstPost },
    nudges: { ...m.nudges },
    stale: m.stale,
    stalePids: [...m.stalePids].sort((a, b) => a - b),
    comments: m.comments,
    discussionComments: m.discussionComments,
    metareview: { byStatus, submitted: m.metareview.submitted, of: m.metareview.of, due: m.metareview.due },
    activity: { start: m.activity.start, daily: [...m.activity.daily] },
  };
}

export const byName = (a: { person: { name: string; email: string } }, b: { person: { name: string; email: string } }) =>
  a.person.name.localeCompare(b.person.name) || a.person.email.localeCompare(b.person.email);

export function registerAcs(app: FastifyInstance, deps: RouteDeps): void {
  app.get("/api/acs", async (): Promise<AcsResponse> => {
    const view = deps.analysis.get();
    const acs = view.analysis.acs.map((m) => acRow(m, view.people)).sort(byName);
    return { now: view.ctx.now, maxLoad: acs.reduce((n, a) => Math.max(n, a.load), 0), acs };
  });
}

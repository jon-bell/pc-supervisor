// The golden oracle (seed/scenarios/golden/expected.ts) turned into what the
// UI should show: the triage order is computed from the table (fired rules x
// rule weights from /api/meta), never hard-coded.
import { FIRES_AT_PRIMARY } from "@pcs/seed/scenarios/golden/expected";
import type { MetaResponse } from "@pcs/server/server/api-types";

export { FIRES_AT_PRIMARY };

export interface ExpectedRow {
  pid: number;
  severity: number;
  rules: readonly string[];
}

/** Severity desc; DECISIONS_DUE is global, so ties fall through to pid (spec §5c). */
export function expectedTriage(meta: MetaResponse): ExpectedRow[] {
  const weight = new Map(meta.rules.map((r) => [r.name, r.weight]));
  return Object.entries(FIRES_AT_PRIMARY)
    .map(([pid, rules]) => ({
      pid: Number(pid),
      rules,
      severity: rules.reduce((s, r) => s + (weight.get(r) ?? 0), 0),
    }))
    .sort((a, b) => b.severity - a.severity || a.pid - b.pid);
}

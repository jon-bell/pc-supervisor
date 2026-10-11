// The paper drawer's compact flag timeline (spec §5c "Flag history"): one
// line per flag span, e.g. "Split since Feb 3", "Gone quiet raised Feb 20,
// cleared Feb 24 after AC comment", plus the chair's tag writes. "~" marks a
// date reconstructed by `pcs backfill` (daily resolution).

import { formatDate, ruleLabel } from "../format";
import { usePaperFlags, type FlagSpan } from "../rules-api";

const day = (ms: number, approx: boolean, tz: string) => `${approx ? "~" : ""}${formatDate(ms, tz)}`;

export function spanText(s: FlagSpan, tz: string): string {
  const label = ruleLabel(s.rule);
  const raisedWhy = s.raisedWhy && !s.raisedWhy.startsWith("already") ? ` ${s.raisedWhy}` : "";
  if (s.clearedAt === null) return `${label} since ${day(s.raisedAt, s.raisedReconstructed, tz)}${raisedWhy}`;
  return `${label} raised ${day(s.raisedAt, s.raisedReconstructed, tz)}${raisedWhy}, cleared ${day(s.clearedAt, s.clearedReconstructed, tz)}${s.clearedWhy ? ` ${s.clearedWhy}` : ""}`;
}

export function PaperFlagTimeline({ pid, tz }: { pid: number; tz: string }) {
  const q = usePaperFlags(pid);
  const d = q.data;
  if (!d || (d.spans.length === 0 && d.actions.length === 0)) return null;
  // Open flags first, then the most recent spans.
  const spans = [...d.spans].sort((a, b) => (a.clearedAt === null ? 0 : 1) - (b.clearedAt === null ? 0 : 1) || (b.clearedAt ?? b.raisedAt) - (a.clearedAt ?? a.raisedAt));
  return (
    <section className="pft" data-testid="paper-flag-timeline">
      <h3>Flag history</h3>
      <ul>
        {spans.map((s) => (
          <li key={`${s.rule}-${s.raisedAt}`} className={s.clearedAt === null ? "pft-open" : "pft-closed"} data-testid="flag-span" data-rule={s.rule} data-open={s.clearedAt === null}>
            {spanText(s, tz)}
          </li>
        ))}
        {d.actions.map((a) => (
          <li key={`a-${a.id}`} className="pft-action" data-testid="flag-action">
            {a.kind === "tag" ? "Tagged" : "Untagged"} #{a.tag} {formatDate(a.at, tz)} by {a.actor}
          </li>
        ))}
      </ul>
    </section>
  );
}

// Severity with visual weight (spec §7 "Severity"): the number, bold, and a
// bar whose length is the severity relative to the largest in the list and
// whose colour steps up a five-step sequential ramp, so the worst papers stand
// out when scanning. Zero shows as a muted number and no bar.

/** Ramp step 1..5 for a severity against the list's largest. */
export const sevStep = (sev: number, max: number): number => (sev <= 0 || max <= 0 ? 0 : Math.min(5, Math.max(1, Math.ceil((sev / max) * 5))));

export function SeverityCell({ sev, max, testId = "severity" }: { sev: number; max: number; testId?: string }) {
  const step = sevStep(sev, max);
  const pct = max > 0 ? Math.max(6, Math.round((100 * Math.max(0, sev)) / max)) : 0;
  return (
    <span className={`sevcell sev-s${step}`} title={max > 0 ? `severity ${sev}; the largest in this list is ${max}` : undefined}>
      <span className="sev" data-testid={testId}>
        {sev}
      </span>
      {step > 0 ? (
        <span className="sevbar" aria-hidden="true">
          <i style={{ width: `${pct}%` }} />
        </span>
      ) : null}
    </span>
  );
}

// Chips: small labelled badges. ReasonChip shows a fired rule; its title (hover)
// is the rule's reason string with the actual numbers.

import type { ReactNode } from "react";
import type { Reason } from "../api";
import { ruleLabel } from "../format";

export type ChipTone = "neutral" | "warn" | "alert" | "info";

export function Chip({ tone = "neutral", title, testId, children }: { tone?: ChipTone; title?: string; testId?: string; children: ReactNode }) {
  return (
    <span className={`chip chip-${tone}`} title={title} data-testid={testId}>
      {children}
    </span>
  );
}

const toneFor = (weight: number): ChipTone => (weight >= 3 ? "alert" : weight >= 2 ? "warn" : "info");

export function ReasonChip({ reason }: { reason: Reason }) {
  return (
    <span className={`chip chip-${toneFor(reason.weight)}`} title={reason.reason} data-testid="chip" data-rule={reason.rule}>
      {ruleLabel(reason.rule)}
    </span>
  );
}

export function ReasonChips({ reasons }: { reasons: readonly Reason[] }) {
  return (
    <span className="chips" data-testid="chips">
      {reasons.map((r) => (
        <ReasonChip key={r.rule} reason={r} />
      ))}
    </span>
  );
}

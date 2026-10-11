// Chips: small labelled badges. A ReasonChip shows a fired rule; its title
// (hover) is the rule's reason string with the actual numbers. Its colour and
// its one-to-three bars both encode the rule's weight on a small fixed scale
// (spec §7 "Severity"), so the level never depends on colour alone.

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

/** Weight -> level: 3 = high (weight >= 3), 2 = medium (2), 1 = low (1 or less). */
export const levelOf = (weight: number): 1 | 2 | 3 => (weight >= 3 ? 3 : weight >= 2 ? 2 : 1);
export const LEVEL_NAMES = { 1: "low", 2: "medium", 3: "high" } as const;

/** Three bars, `level` of them filled. */
export function LevelBars({ level }: { level: 1 | 2 | 3 }) {
  return (
    <span className="lvl" aria-hidden="true">
      <i className={level >= 1 ? "on" : undefined} />
      <i className={level >= 2 ? "on" : undefined} />
      <i className={level >= 3 ? "on" : undefined} />
    </span>
  );
}

export function ReasonChip({ reason }: { reason: Reason }) {
  const level = levelOf(reason.weight);
  return (
    <span
      className={`chip chip-reason lvl-${level}`}
      title={reason.reason}
      data-testid="chip"
      data-rule={reason.rule}
      data-level={LEVEL_NAMES[level]}
    >
      <LevelBars level={level} />
      {ruleLabel(reason.rule)}
    </span>
  );
}

/** Heaviest first; ties keep the server's (rule) order. */
export const byWeight = (reasons: readonly Reason[]): Reason[] =>
  reasons
    .map((r, i) => ({ r, i }))
    .sort((a, b) => b.r.weight - a.r.weight || a.i - b.i)
    .map((x) => x.r);

/**
 * The reasons on one line: all of them when they fit in `max` slots, else
 * the heaviest `max - 1` and a "+N" whose tooltip lists the rest (the drawer
 * shows them all). Pass max = Infinity to show every chip (the drawer).
 */
export function ReasonChips({ reasons, max = Infinity }: { reasons: readonly Reason[]; max?: number }) {
  const sorted = byWeight(reasons);
  const shown = sorted.length <= max ? sorted : sorted.slice(0, Math.max(1, max - 1));
  const rest = sorted.slice(shown.length);
  const restText = rest.map((r) => `${ruleLabel(r.rule)} (${LEVEL_NAMES[levelOf(r.weight)]}): ${r.reason}`).join("\n");
  return (
    <span className="chips" data-testid="chips">
      {shown.map((r) => (
        <ReasonChip key={r.rule} reason={r} />
      ))}
      {rest.length ? (
        <span className="chip chip-more" data-testid="chips-more" title={`Also:\n${restText}`}>
          +{rest.length}
          <span className="visually-hidden"> more: {rest.map((r) => ruleLabel(r.rule)).join(", ")}</span>
        </span>
      ) : null}
    </span>
  );
}

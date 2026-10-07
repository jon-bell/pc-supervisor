// Times. Relative times and sync timestamps change between runs, so they carry
// the `volatile` class and data-visual-test="transparent", which Argos hides
// in screenshots (spec §9.1). Absolute times of seeded events are stable and
// stay visible.

import type { ReactNode } from "react";
import { formatTime, relativeDays } from "../format";

export function Volatile({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <span className="volatile" data-visual-test="transparent" data-testid={testId}>
      {children}
    </span>
  );
}

/** "3 days ago", with the absolute time on hover. */
export function RelTime({ ms, now, tz, testId }: { ms: number | null; now: number; tz: string; testId?: string }) {
  if (ms === null) return <span className="muted">unknown</span>;
  return (
    <span className="volatile" data-visual-test="transparent" title={formatTime(ms, tz)} data-testid={testId}>
      {relativeDays(ms, now)}
    </span>
  );
}

/** "Feb 26, 12:00", "~" prefixed when the time is a best guess (existed before the first sync). */
export function AbsTime({ ms, tz, approximate = false }: { ms: number; tz: string; approximate?: boolean }) {
  return (
    <time dateTime={new Date(ms).toISOString()} title={approximate ? "approximate: existed before the first sync" : undefined}>
      {approximate ? "~" : ""}
      {formatTime(ms, tz)}
    </time>
  );
}

// Display helpers. "Now" is always the server's (GET /api/meta), so a pinned
// PCS_NOW renders the same everywhere and the browser clock is never read.
//
// Wording follows spec §7: describe what HotCRP shows ("no comments yet",
// "no in-HotCRP activity"), never judge people.

const DAY = 86_400_000;

/** "Feb 26, 12:00" in the conference time zone. */
export function formatTime(ms: number, tz: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(ms);
}

/** "Feb 26" in the conference time zone. */
export function formatDate(ms: number, tz: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short", day: "numeric" }).format(ms);
}

/** "2.5 days" (one decimal under 10, whole days above). */
export function formatDays(d: number): string {
  const v = d < 10 ? d.toFixed(1) : String(Math.round(d));
  return `${v} ${v === "1.0" ? "day" : "days"}`;
}

/** "75%"; "–" when unknown. */
export const percent = (share: number | null) => (share === null ? "–" : `${Math.round(share * 100)}%`);

/** Labels for the reviewer outlier lists and for tiers. */
export const TIER_LABELS: Readonly<Record<string, string>> = {
  senior: "Senior PC",
  junior: "Junior PC",
  reciprocal: "Reciprocal",
};
export const tierLabel = (t: string) => TIER_LABELS[t] ?? t;

/** "3 days ago", "today", "in 2 days". */
export function relativeDays(ms: number, now: number): string {
  const d = (now - ms) / DAY;
  if (Math.abs(d) < 1) return d >= 0 ? "today" : "later today";
  const n = Math.floor(Math.abs(d));
  const unit = n === 1 ? "day" : "days";
  return d > 0 ? `${n} ${unit} ago` : `in ${n} ${unit}`;
}

/** Short chip labels for rule names (the full reason is the chip's title). */
export const RULE_LABELS: Readonly<Record<string, string>> = {
  MISSING_REVIEWS: "Missing reviews",
  SPLIT: "Split",
  UNRESOLVED_SPLIT: "Unresolved split",
  SILENT_DISCUSSION: "No comments yet",
  GONE_QUIET: "Gone quiet",
  AC_ABSENT: "No AC comment yet",
  CHAMPION_MISSING: "No champion comment",
  LOW_EXPERTISE: "Low expertise",
  THIN_REVIEWS: "Thin reviews",
  RESPONSE_UNADDRESSED: "Response not discussed",
  DEADLINE_NO_CONSENSUS: "Deadline, no consensus",
};

export const ruleLabel = (rule: string) => RULE_LABELS[rule] ?? rule;

export const PHASE_LABELS: Readonly<Record<string, string>> = {
  "before-review-due": "Reviewing",
  "reviewing-late": "Reviews overdue",
  response: "Author response",
  discussion: "Discussion",
  decisions: "Decisions",
  "after-decisions": "After decisions",
};

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** HotCRP deep links (spec §4): the base URL comes from /api/meta. */
export const hotcrp = {
  paper: (base: string, pid: number) => `${base}/paper/${pid}`,
  review: (base: string, pid: number, ordinal: string | null, rid: number) =>
    ordinal ? `${base}/review/${pid}${ordinal}` : `${base}/review?p=${pid}&r=${rid}`,
};

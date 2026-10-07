// Review ratings (spec §1, §5a, §5c). HotCRP lets PC members rate each other's
// reviews with a fixed flag vocabulary (ReviewInfo::$rating_bits). Bulk GET
// /reviews carries a review's ratings as a sorted MULTISET of flags: one entry
// per (rater, flag), so ["short","short","vague"] means two raters said
// "short" and one said "vague". A single flag comes as a bare string, and the
// key is absent when the review is unrated. There is no rater identity and no
// timestamp, even for chairs.
//
// Locally a review's ratings are a count per flag ({short: 2, vague: 1}),
// stored as canonical JSON (keys in vocabulary order, zero counts dropped) so
// two syncs of the same ratings produce the same string.
//
// "Raters" for a flag = that flag's count: a rater can set several flags on
// one review, but each flag at most once.

/** HotCRP's rating flags, in its bit order (1, 2, 4, ... 64). */
export const RATING_FLAGS = ["good", "needswork", "short", "vague", "narrow", "disrespectful", "wrong"] as const;
export type RatingFlag = (typeof RATING_FLAGS)[number];

/** Flag -> number of raters who set it. Absent flags are 0. */
export type RatingCounts = Readonly<Partial<Record<RatingFlag, number>>>;

/** THIN_REVIEWS' rating clause (spec §5c). */
export const THIN_FLAGS: readonly RatingFlag[] = ["short", "vague"];
/** REVIEW_FLAGGED (spec §5c): a review the chair must look at before authors see it. */
export const SEVERE_FLAGS: readonly RatingFlag[] = ["disrespectful", "wrong"];
/**
 * Negative flags for reviewer quality (spec §5a): every flag but `good`, as in
 * HotCRP's RATING_BADMASK. That is the spec's short/vague/needswork/narrow/
 * wrong plus `disrespectful`, which is the strongest coaching signal of all.
 */
export const NEGATIVE_FLAGS: readonly RatingFlag[] = RATING_FLAGS.filter((f) => f !== "good");

const FLAG_SET: ReadonlySet<string> = new Set(RATING_FLAGS);
export const isRatingFlag = (s: string): s is RatingFlag => FLAG_SET.has(s);

/**
 * Counts from HotCRP's encoding: a flag list (multiset), one bare flag, or
 * nothing. `/{p}/reviewrating` also says "none" for no ratings.
 */
export function countRatings(v: string | readonly string[] | undefined | null): RatingCounts {
  const list = v === undefined || v === null ? [] : typeof v === "string" ? [v] : v;
  const out: Partial<Record<RatingFlag, number>> = {};
  for (const f of list) if (isRatingFlag(f)) out[f] = (out[f] ?? 0) + 1;
  return canonical(out);
}

/** Same counts, keys in vocabulary order, zeros dropped. */
export function canonical(c: RatingCounts): RatingCounts {
  const out: Partial<Record<RatingFlag, number>> = {};
  for (const f of RATING_FLAGS) {
    const n = c[f] ?? 0;
    if (n > 0) out[f] = n;
  }
  return out;
}

/** The stored form (review.ratings, rating_change.before/after). */
export function ratingsJson(c: RatingCounts): string {
  return JSON.stringify(canonical(c));
}

/**
 * Parse a stored ratings column. Accepts the counts object and, for safety,
 * a flag list (the pre-migration-5 form). Unknown keys and bad counts are dropped.
 */
export function parseRatings(s: unknown): RatingCounts {
  if (typeof s !== "string" || s === "") return {};
  let v: unknown;
  try {
    v = JSON.parse(s);
  } catch {
    return {};
  }
  if (Array.isArray(v) || typeof v === "string") return countRatings((Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === "string"));
  if (v === null || typeof v !== "object") return {};
  const out: Partial<Record<RatingFlag, number>> = {};
  for (const [k, n] of Object.entries(v as Record<string, unknown>)) {
    if (isRatingFlag(k) && typeof n === "number" && Number.isInteger(n) && n > 0) out[k] = n;
  }
  return canonical(out);
}

/** Total of the given flags (default: all). */
export function ratingTotal(c: RatingCounts, flags: readonly RatingFlag[] = RATING_FLAGS): number {
  let n = 0;
  for (const f of flags) n += c[f] ?? 0;
  return n;
}

/** Sum several reviews' counts. */
export function addRatings(into: Partial<Record<RatingFlag, number>>, c: RatingCounts): void {
  for (const f of RATING_FLAGS) {
    const n = c[f] ?? 0;
    if (n > 0) into[f] = (into[f] ?? 0) + n;
  }
}

/** Only the given flags (zeros dropped). */
export function pickRatings(c: RatingCounts, flags: readonly RatingFlag[]): RatingCounts {
  const out: Partial<Record<RatingFlag, number>> = {};
  for (const f of flags) if ((c[f] ?? 0) > 0) out[f] = c[f]!;
  return canonical(out);
}

/** "2× short, 1× vague" in vocabulary order; "" when none. */
export function formatRatings(c: RatingCounts, flags: readonly RatingFlag[] = RATING_FLAGS): string {
  return RATING_FLAGS.filter((f) => flags.includes(f) && (c[f] ?? 0) > 0)
    .map((f) => `${c[f]}× ${f}`)
    .join(", ");
}

/**
 * HotCRP's `review_rating` setting: `pc` (PC members rate), `all` (external
 * reviewers too), or `no` (ratings off). Unknown or not yet synced counts as
 * on, which is HotCRP's default (`pc`).
 */
export function ratingsEnabledFor(setting: string | null | undefined): boolean {
  return setting !== "no";
}

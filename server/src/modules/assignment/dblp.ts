// Optional co-authorship evidence for conflict sanity (spec §10.4 C). OFF by
// default (PCS_CONFLICT_DBLP=false), and no provider ships in M10: there are
// no network calls here. A later milestone can implement this interface over
// a local DBLP cache (sending only public author names, spec §10.4 A).
// Results are hints for a human, never verdicts.

export interface CoauthorshipSource {
  /** A short label for reasons, e.g. "DBLP cache 2030-01". */
  readonly label: string;
  /**
   * Number of co-authored papers between two people (by email), or
   * undefined when unknown. Synchronous: providers must be pre-loaded.
   */
  coauthored(emailA: string, emailB: string): number | undefined;
}

/** Knows nothing; the default. */
export const NO_COAUTHORSHIP: CoauthorshipSource = {
  label: "none",
  coauthored: () => undefined,
};

/** A fixed table of pairs (tests, or a pre-computed cache). */
export function staticCoauthorship(label: string, pairs: readonly [string, string, number][]): CoauthorshipSource {
  const m = new Map<string, number>();
  const key = (a: string, b: string) => (a < b ? `${a}\t${b}` : `${b}\t${a}`);
  for (const [a, b, n] of pairs) m.set(key(a.toLowerCase(), b.toLowerCase()), n);
  return { label, coauthored: (a, b) => m.get(key(a.toLowerCase(), b.toLowerCase())) };
}

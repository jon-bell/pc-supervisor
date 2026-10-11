// Invented filler text with exact word counts. Deterministic: the same key
// always yields the same text, so the verifier can recompute it. Contains no
// real review content; it reads like vague review boilerplate on purpose.

import { REVIEW_TEXT_FIELDS } from "./format.js";
import { intBetween, pick, rngFor, type Rng } from "./rng.js";

const WORDS = [
  "the", "approach", "evaluation", "benchmark", "results", "method", "paper", "authors",
  "claims", "baseline", "dataset", "analysis", "prototype", "framework", "tool", "study",
  "section", "figure", "table", "threats", "validity", "related", "work", "novel",
  "technique", "experiment", "metric", "precision", "recall", "overhead", "scalability",
  "artifact", "replication", "design", "implementation", "limitation", "assumption",
  "argument", "motivation", "example", "contribution", "discussion", "clarity", "writing",
  "presentation", "detail", "comparison", "setup", "parameter", "sample", "subject",
  "program", "system", "model", "input", "output", "test", "suite", "coverage", "fault",
  "is", "are", "seems", "appears", "could", "would", "should", "might", "remains",
  "unclear", "convincing", "limited", "solid", "interesting", "promising", "weak",
  "strong", "modest", "careful", "thorough", "brief", "missing", "useful", "reasonable",
  "and", "but", "or", "with", "without", "for", "of", "in", "on", "to", "from", "by",
  "this", "that", "these", "some", "more", "less", "overall", "however", "also", "further",
];

/** Exactly `n` words (n >= 0), in sentences of 6-14 words. */
export function fillerWords(rng: Rng, n: number): string {
  if (!Number.isInteger(n) || n < 0) throw new RangeError(`word count must be a non-negative integer, got ${n}`);
  const out: string[] = [];
  let sentence = 0;
  let len = intBetween(rng, 6, 14);
  for (let i = 0; i < n; i++) {
    let w = pick(rng, WORDS);
    if (sentence === 0) w = w[0]!.toUpperCase() + w.slice(1);
    sentence++;
    if (sentence === len || i === n - 1) {
      w += ".";
      sentence = 0;
      len = intBetween(rng, 6, 14);
    }
    out.push(w);
  }
  return out.join(" ");
}

/** Words as HotCRP counts them (lib/base.php count_words). */
export function countWords(text: string): number {
  return text.match(/[^-\s.,;:<>!?*_~`#|]\S*/g)?.length ?? 0;
}

/**
 * Review text fields for `words` total words, keyed by field UID.
 * About a quarter goes to the summary (at least 1 word each when words >= 2).
 */
export function reviewText(key: string, words: number): Record<string, string> {
  const rng = rngFor(`review:${key}`);
  const [sumField, bodyField] = REVIEW_TEXT_FIELDS;
  const summary = words >= 2 ? Math.max(1, Math.floor(words / 4)) : words;
  return {
    [sumField]: fillerWords(rng, summary),
    [bodyField]: fillerWords(rng, words - summary),
  };
}

/** Comment text: "@First Last ..." for each mention, then `words` filler words (or the literal `body`). */
export function commentText(key: string, version: number, mentionNames: readonly string[], words: number, literal?: string): string {
  const rng = rngFor(`comment:${key}:${version}`);
  const lead = mentionNames.map((n) => `@${n}`).join(" ");
  const body = literal ?? fillerWords(rng, words);
  return lead ? `${lead} ${body}` : body;
}

export function abstractText(pid: number): string {
  return fillerWords(rngFor(`abstract:${pid}`), 60);
}

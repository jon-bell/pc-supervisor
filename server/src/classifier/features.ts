// Structural features of a comment (spec §5e), besides its text:
// - byAcOrLead:       the author is one of the paper's ACs (PCS_AC_ROLE) or its discussion lead;
// - mentions:         @mentions in the text (resolved roster mentions, or a bare "@word");
// - words:            the comment's word count;
// - hoursSincePrev:   hours since the previous comment or submitted review on the paper (null = first);
// - authorHasReview:  the author had submitted a review on the paper before this comment;
// - quotes:           the comment quotes earlier text ("> ..." lines, or a quoted span found in an
//                     earlier comment or review on the paper).
// Computed locally from the store; nothing leaves the process.

export interface StructuralFeatures {
  byAcOrLead: boolean;
  mentions: number;
  words: number;
  hoursSincePrev: number | null;
  authorHasReview: boolean;
  quotes: boolean;
}

/** Number of values featureVector() appends to an embedding. */
export const STRUCTURAL_DIM = 7;

/** The features scaled to roughly 0..1, for the model head. */
export function featureVector(f: StructuralFeatures): number[] {
  const hours = f.hoursSincePrev;
  return [
    f.byAcOrLead ? 1 : 0,
    f.mentions > 0 ? 1 : 0,
    Math.min(1, Math.log1p(f.words) / Math.log1p(400)),
    hours === null ? 1 : 0,
    hours === null ? 0 : Math.min(1, Math.log1p(Math.max(0, hours)) / Math.log1p(24 * 30)),
    f.authorHasReview ? 1 : 0,
    f.quotes ? 1 : 0,
  ];
}

/** Lower-case words with punctuation stripped, for quote matching. */
function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

const QUOTE_SPANS = /["“”«»]([^"“”«»\n]{12,400})["“”«»]/g;

/**
 * Does `text` quote earlier text? True for an e-mail style "> ..." line, or a
 * quoted span of at least 3 words that occurs in one of `earlier`.
 */
export function quotesEarlier(text: string, earlier: readonly string[]): boolean {
  if (/^\s*>\s*\S/m.test(text)) return true;
  if (earlier.length === 0) return false;
  let haystack: string | undefined;
  for (const m of text.matchAll(QUOTE_SPANS)) {
    const span = norm(m[1]!);
    if (span.split(" ").length < 3) continue;
    haystack ??= earlier.map(norm).join("\n");
    if (haystack.includes(span)) return true;
  }
  return false;
}

/** "@word" tokens in the text (HotCRP's mention syntax), for when the roster didn't resolve one. */
export function textMentions(text: string): number {
  return text.match(/(^|[\s([{,;/–—-])@[\p{L}\p{N}][\p{L}\p{N}._-]*/gu)?.length ?? 0;
}

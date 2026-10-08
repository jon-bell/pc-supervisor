// Paper-search scope (PCS_PAPER_SEARCH) and query composition.
//
// HotCRP's search grammar (src/searchoperatorset.php, src/searchparser.php):
// operators by precedence, loosest first, are HIGHLIGHT, THEN, (unnamed
// space-OR), OR, XOR, AND, (space = AND), NOT; parentheses group. Inside
// parentheses a space is always AND, and a run of bare numbers and ranges
// ("3 7-9 40") merges into one paper-number set (searchterm.php `pn`
// merge), so the pid-list chunks stay a union when wrapped.
//
// So a scope S and a query Q combine as `(S) AND (Q)`: both sides are
// parenthesized, so neither side's operators can capture the other. Q = "all"
// (or empty) is just `(S)`; Q = "NONE" stays "NONE" (the review-form trick).

/** `q` restricted to the scope; `q` unchanged when the scope is empty. */
export function scopedQuery(scope: string, q: string | undefined): string {
  const s = scope.trim();
  const query = (q ?? "").trim();
  if (s === "") return query === "" ? "all" : query;
  if (query.toUpperCase() === "NONE") return "NONE";
  if (query === "" || query.toLowerCase() === "all") return `(${s})`;
  return `(${s}) AND (${query})`;
}

/** Longest search accepted (PCS_PAPER_SEARCH or the in-app filter). */
export const MAX_SEARCH_LENGTH = 1000;

/**
 * A reason the search can't be safely parenthesized, or null if it can:
 * unbalanced parentheses (outside double quotes), an unclosed quote, a
 * control character, or more than MAX_SEARCH_LENGTH characters. HotCRP
 * itself judges everything else (unknown keywords come back as warnings,
 * which the client turns into errors).
 */
export function searchProblem(q: string): string | null {
  if (q.length > MAX_SEARCH_LENGTH) return `longer than ${MAX_SEARCH_LENGTH} characters`;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(q)) return "contains a control character";
  let depth = 0;
  let quoted = false;
  for (const ch of q) {
    if (ch === '"') quoted = !quoted;
    else if (quoted) continue;
    else if (ch === "(") depth++;
    else if (ch === ")" && --depth < 0) return "has a ) without a matching (";
  }
  if (quoted) return "has an unclosed double quote";
  if (depth > 0) return "has a ( without a matching )";
  return null;
}

// Paper-search scope (PCS_PAPER_SEARCH) and query composition.
//
// HotCRP's search grammar (src/searchoperatorset.php, src/searchparser.php):
// operators by precedence, loosest first, are HIGHLIGHT, THEN, (unnamed
// space-OR), OR, XOR, AND, (space = AND), NOT; parentheses group. Inside
// parentheses a space is always AND, and a run of bare numbers and ranges
// ("3 7-9 40") merges into one paper-number set (searchterm.php `pn`
// merge), so the pid-list chunks stay a union when wrapped.
//
// So a scope S and a query Q combine as `(S) AND (Q)`, each side wrapped by
// HotCRP's own SearchParser::safe_parenthesize (search-parens.ts), so neither
// side's operators can capture the other and a side with a stray `)` or an
// unclosed `"` or `(` means what it means to HotCRP alone. THEN and HIGHLIGHT
// are fine inside the parentheses: a THEN's papers are the union of its
// groups and a HIGHLIGHT's are its first operand's, wherever they sit
// (searchterm.php Then_SearchTerm); the harness parity test checks both.
// Q = "all" (or empty) is just `(S)`; Q = "NONE" stays "NONE" (the
// review-form trick; it matches nothing either way).

import { safeParenthesize } from "./search-parens.js";

/** `q` restricted to the scope; `q` unchanged when the scope is empty. */
export function scopedQuery(scope: string, q: string | undefined): string {
  const s = scope.trim();
  const query = (q ?? "").trim();
  if (s === "") return query === "" ? "all" : query;
  if (query.toUpperCase() === "NONE") return "NONE";
  if (query === "" || query.toLowerCase() === "all") return safeParenthesize(s);
  return `${safeParenthesize(s)} AND ${safeParenthesize(query)}`;
}

/** Longest search accepted (PCS_PAPER_SEARCH or the in-app filter). */
export const MAX_SEARCH_LENGTH = 1000;

/**
 * A reason the in-app filter won't send this search, or null. Only what
 * HotCRP itself can't take in a query string: more than MAX_SEARCH_LENGTH
 * characters, or a control character other than tab/newline (which HotCRP
 * reads as spaces). Unbalanced brackets and quotes are fine: HotCRP accepts
 * them, and safeParenthesize keeps their meaning. HotCRP judges everything
 * else (unknown keywords come back as warnings, which the client turns into
 * errors).
 */
export function searchProblem(q: string): string | null {
  if (q.length > MAX_SEARCH_LENGTH) return `longer than ${MAX_SEARCH_LENGTH} characters`;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(q)) return "contains a control character";
  return null;
}

/**
 * searchProblem, plus unbalanced parentheses (outside double quotes) or an
 * unclosed quote. For PCS_PAPER_SEARCH, which the chair writes once in .env:
 * HotCRP would accept these, but there they are almost surely typos.
 */
export function strictSearchProblem(q: string): string | null {
  const basic = searchProblem(q);
  if (basic) return basic;
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < q.length; ++i) {
    let ch = q[i]!;
    if (ch === "“" || ch === "”") ch = '"';
    if (quoted) {
      if (ch === "\\") ++i;
      else if (ch === '"') quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === "(") depth++;
    else if (ch === ")" && --depth < 0) return "has a ) without a matching (";
  }
  if (quoted) return "has an unclosed double quote";
  if (depth > 0) return "has a ( without a matching )";
  return null;
}

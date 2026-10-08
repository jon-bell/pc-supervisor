// Copyright (c) 2006-2026 Eddie Kohler. HotCRP is distributed under an
// MIT-style license; see https://github.com/kohler/hotcrp/blob/master/LICENSE.
// Ported from hotcrp@60f693f88b9a0ef9e34b11af957a513f1c122690
// src/searchparser.php SearchParser::safe_parenthesize.
//
// Wraps a HotCRP search in parentheses so that it can be combined with
// another search without changing what it means. HotCRP's own parser is
// forgiving, and so is this, exactly the way HotCRP is (checked against the
// harness in server/test/integration/search-parity.test.ts):
//   - an unmatched `)`, `]` or `}` is dropped (HotCRP ignores it at top level);
//   - an unclosed `"` is closed, and unclosed brackets are closed innermost
//     first (HotCRP runs them to the end of the string);
//   - inside quotes, `\` escapes the next character and brackets don't count;
//   - curly quotes (U+201C, U+201D) count as `"`.
// An empty search becomes `(*)`. A search that is already one parenthesized
// group is returned as is.
//
// The PHP walks UTF-8 bytes; this walks UTF-16 code units. Every character
// that matters is ASCII or U+201C/U+201D (one code unit), so the two agree.

const OPEN_TO_CLOSE: Record<string, string> = { "(": ")", "[": "]", "{": "}" };

export function safeParenthesize(str: string): string {
  const pstack: string[] = []; // expected close brackets, innermost last
  let quote = false;
  let startpos = 0;
  let ntopopen = 0;
  let out = "";
  const len = str.length;
  for (let pos = 0; pos < len; ++pos) {
    let ch = str[pos]!;
    if (ch === "“" || ch === "”") ch = '"';
    if (quote) {
      if (ch === "\\") {
        if (pos + 1 < len) {
          ++pos;
        } else {
          out += str.slice(startpos, pos) + "\\";
          startpos = pos;
        }
      } else if (ch === '"') {
        quote = false;
      }
    } else if (ch === "(" || ch === "[" || ch === "{") {
      if (ch === "(" && pstack.length === 0) ++ntopopen;
      pstack.push(OPEN_TO_CLOSE[ch]!);
    } else if (ch === ")" || ch === "]" || ch === "}") {
      // close unmatched inner brackets, drop unmatched close brackets
      while (pstack.length > 0 && pstack[pstack.length - 1] !== ch) {
        out += str.slice(startpos, pos) + pstack.pop()!;
        startpos = pos;
      }
      if (pstack.length === 0) {
        out += str.slice(startpos, pos);
        startpos = pos + 1;
      } else {
        pstack.pop();
      }
    } else if (ch === '"') {
      quote = true;
    }
  }
  out += str.slice(startpos);
  if (quote) out += '"';
  while (pstack.length > 0) out += pstack.pop()!;
  if (out === "") out = "*";
  if (ntopopen === 1 && out.startsWith("(") && out.endsWith(")")) return out;
  return `(${out})`;
}

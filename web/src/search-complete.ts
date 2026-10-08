// Autocomplete for the "Papers matching" box: which token the caret is in,
// what could complete it, and how accepting a suggestion edits the query.
// Pure functions (unit-tested in web/test/unit/search-complete.test.ts); the
// data comes from GET /api/search-completions.
//
// Tokens follow HotCRP's search parser (src/searchparser.php): words end at
// whitespace or a parenthesis, except inside double quotes; a leading `-`,
// `!` or `+` is an operator, not part of the word. So completion works
// mid-query: after `OR`, `-`, `(`, before a `)`.

import type { CompletionKeyword, SearchCompletionsResponse } from "./api";

export type CompletionData = Pick<SearchCompletionsResponse, "tags" | "pc" | "keywords" | "operators" | "values">;

export interface Token {
  /** Where the replaceable word starts (after any `-`/`!`/`+`). */
  start: number;
  /** Where it ends (the caret may be inside it). */
  end: number;
  /** The word's text before the caret: what is being completed. */
  prefix: string;
}

export type SuggestionKind = "tag" | "keyword" | "operator" | "value" | "person";

export interface Suggestion {
  /** Replaces the token. */
  insert: string;
  /** Shown in the list (usually = insert). */
  label: string;
  hint?: string;
  /** Papers (tags, decisions, rounds). */
  count?: number;
  kind: SuggestionKind;
  /** A keyword prefix ("re:", "#tag#"): keep completing, no trailing space. */
  continues: boolean;
}

/** At most this many suggestions are shown. */
export const MAX_SUGGESTIONS = 12;

const isSpace = (ch: string) => /\s/u.test(ch);
const isQuote = (ch: string) => ch === '"' || ch === "“" || ch === "”";

/** The token around `caret` in `q`. */
export function tokenAt(q: string, caret: number): Token {
  const at = Math.max(0, Math.min(caret, q.length));
  let start = 0;
  let quoted = false;
  for (let i = 0; i < at; i++) {
    const ch = q[i]!;
    if (quoted) {
      if (ch === "\\") i++;
      else if (isQuote(ch)) quoted = false;
    } else if (isQuote(ch)) quoted = true;
    else if (isSpace(ch) || ch === "(" || ch === ")") start = i + 1;
  }
  // A leading NOT/+ operator isn't part of the word.
  while (start < at && /[-!+]/.test(q[start]!)) start++;
  let end = at;
  for (; end < q.length; end++) {
    const ch = q[end]!;
    if (quoted) {
      if (ch === "\\") end++;
      else if (isQuote(ch)) quoted = false;
    } else if (isQuote(ch)) quoted = true;
    else if (isSpace(ch) || ch === "(" || ch === ")") break;
  }
  return { start, end: Math.min(end, q.length), prefix: q.slice(start, at) };
}

/**
 * How well `typed` matches `cand`, lower is better; null = no match.
 * 0 exact, 1 prefix, 2 prefix of a word inside (after - _ . @ ~ : space), 3
 * substring, 4 subsequence (only for 2+ characters). Case-insensitive.
 */
export function matchRank(typed: string, cand: string): number | null {
  if (typed === "") return 1;
  const t = typed.toLowerCase();
  const c = cand.toLowerCase();
  if (c === t) return 0;
  if (c.startsWith(t)) return 1;
  const i = c.indexOf(t);
  if (i > 0) return /[-_.@~:\s/]/.test(c[i - 1]!) ? 2 : 3;
  if (t.length < 2) return null;
  let j = 0;
  for (const ch of c) if (ch === t[j] && ++j === t.length) return 4;
  return null;
}

interface Scored extends Suggestion {
  rank: number;
  /** Tie-break inside a rank: lower first. */
  order: number;
}

const best = (typed: string, ...cands: (string | null | undefined)[]): number | null => {
  let r: number | null = null;
  for (const c of cands) {
    if (!c) continue;
    const m = matchRank(typed, c);
    if (m !== null && (r === null || m < r)) r = m;
  }
  return r;
};

const TAG_PREFIX = /^((?:tag|notag|hashtag|order|rorder|revorder|edit):#?|(?:show|hide|sort):#|#)(.*)$/i;
const KEYWORD = /^([A-Za-z0-9_][-_.A-Za-z0-9]*):(.*)$/s;

function finish(xs: Scored[], limit: number): Suggestion[] {
  xs.sort((a, b) => a.rank - b.rank || a.order - b.order);
  const out: Suggestion[] = [];
  const seen = new Set<string>();
  for (const x of xs) {
    const key = x.insert.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ insert: x.insert, label: x.label, hint: x.hint, count: x.count, kind: x.kind, continues: x.continues });
    if (out.length >= limit) break;
  }
  return out;
}

/** Tag name without a twiddle owner ("~mine", "12~mine" -> "mine"), for matching. */
const bareTag = (t: string) => t.replace(/^\d*~+/, "");

function tagSuggestions(data: CompletionData, lead: string, rest: string): Scored[] {
  const out: Scored[] = [];
  const hash = rest.indexOf("#", 1);
  if (hash > 0) {
    // #tag#… : the tag's values.
    const name = rest.slice(0, hash).toLowerCase();
    const typed = rest.slice(hash + 1);
    const tag = data.tags.find((t) => t.tag.toLowerCase() === name);
    if (!tag) return out;
    tag.values.forEach((v, i) => {
      const r = matchRank(typed, v);
      if (r !== null) out.push({ insert: `${lead}${tag.tag}#${v}`, label: `${lead}${tag.tag}#${v}`, kind: "tag", continues: false, rank: r, order: i });
    });
    return out;
  }
  data.tags.forEach((t, i) => {
    const r = best(rest, t.tag, bareTag(t.tag));
    if (r === null) return;
    out.push({
      insert: `${lead}${t.tag}`,
      label: `${lead}${t.tag}`,
      hint: t.values.length > 0 ? `values ${t.values.slice(0, 3).join(", ")}${t.values.length > 3 ? ", …" : ""}` : undefined,
      count: t.count,
      kind: "tag",
      continues: false,
      // Tags are listed by paper count (data.tags order) within a rank.
      rank: r,
      order: i,
    });
  });
  return out;
}

function findKeyword(data: CompletionData, kw: string): CompletionKeyword | undefined {
  const k = `${kw.toLowerCase()}:`;
  return (
    data.keywords.find((x) => x.text.toLowerCase() === k) ?? data.keywords.find((x) => (x.aliases ?? []).some((a) => `${a.toLowerCase()}:` === k))
  );
}

function valueSuggestions(data: CompletionData, typedKw: string, rest: string): Scored[] {
  const out: Scored[] = [];
  const kw = findKeyword(data, typedKw);
  const canon = kw ? kw.text.toLowerCase() : `${typedKw.toLowerCase()}:`;
  const lead = `${typedKw}:`;
  let order = 0;
  for (const v of kw?.fixed ?? []) {
    const r = matchRank(rest, v);
    if (r !== null) out.push({ insert: lead + v, label: lead + v, kind: "value", continues: false, rank: r, order: order++ });
  }
  for (const v of data.values) {
    if (!v.text.toLowerCase().startsWith(canon)) continue;
    const tail = v.text.slice(canon.length);
    const r = best(rest, tail, tail.replace(/^"/, ""));
    if (r === null) continue;
    out.push({ insert: lead + tail, label: lead + tail, hint: v.hint, count: v.count, kind: "value", continues: false, rank: r, order: order++ });
  }
  if (kw?.values === "pc") {
    for (const p of data.pc) {
      const r = best(rest, p.email, p.name, ...(p.name ?? "").split(/\s+/));
      if (r === null) continue;
      out.push({ insert: lead + p.email, label: lead + p.email, hint: p.name ?? undefined, kind: "person", continues: false, rank: r, order: order++ });
    }
  }
  if (kw?.values === "tag") {
    for (const s of tagSuggestions(data, "", rest)) out.push({ ...s, insert: lead + s.insert, label: lead + s.label, order: order + s.order });
  }
  return out;
}

function wordSuggestions(data: CompletionData, word: string): Scored[] {
  const out: Scored[] = [];
  if (/^[\d\s,-]+$/.test(word)) return out; // paper numbers
  data.keywords.forEach((k, i) => {
    const name = k.text.replace(/:$/, "");
    const r = best(word, k.text, name, ...(k.aliases ?? []));
    // Fuzzy matches of 2-letter keywords are noise; keep prefix-or-better.
    if (r === null || (word !== "" && r > 2)) return;
    out.push({ insert: k.text, label: k.text, hint: k.hint, kind: "keyword", continues: true, rank: r, order: 100 + i });
  });
  if (word !== "") {
    data.operators.forEach((o, i) => {
      if (o.text.startsWith(word.toUpperCase())) {
        out.push({ insert: o.text, label: o.text, hint: o.hint, kind: "operator", continues: false, rank: matchRank(word, o.text)!, order: i });
      }
    });
  } else {
    // Nothing typed (opened with ↓): the most-used tags, then keywords.
    data.tags.slice(0, 5).forEach((t, i) => out.push({ insert: `#${t.tag}`, label: `#${t.tag}`, count: t.count, kind: "tag", continues: false, rank: 0, order: i }));
  }
  return out;
}

/** Suggestions for the token at `caret`, best first, at most `limit`. */
export function suggest(data: CompletionData, q: string, caret: number, limit = MAX_SUGGESTIONS): { token: Token; items: Suggestion[] } {
  const token = tokenAt(q, caret);
  const p = token.prefix;
  let xs: Scored[];
  const tm = TAG_PREFIX.exec(p);
  const km = KEYWORD.exec(p);
  if (tm) xs = tagSuggestions(data, tm[1]!, tm[2]!);
  else if (km) xs = valueSuggestions(data, km[1]!, km[2]!);
  else xs = wordSuggestions(data, p);
  return { token, items: finish(xs, limit) };
}

/** `q` with the token replaced by `s`; the caret goes after it (and after a space unless `s` continues). */
export function applySuggestion(q: string, token: Token, s: Suggestion): { value: string; caret: number } {
  const before = q.slice(0, token.start);
  const after = q.slice(token.end);
  const space = s.continues || after.startsWith(" ") || after.startsWith(")") ? "" : " ";
  const value = `${before}${s.insert}${space}${after}`;
  const caret = before.length + s.insert.length + (s.continues ? 0 : after.startsWith(" ") ? 1 : space.length);
  return { value, caret };
}

/** Whether `s` would change nothing (the token already says it). */
export const isComplete = (q: string, token: Token, s: Suggestion): boolean => q.slice(token.start, token.end) === s.insert;

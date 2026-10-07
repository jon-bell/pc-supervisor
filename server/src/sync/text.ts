// Local text heuristics: word counts and @mention parsing (spec §3). No text
// ever leaves the process.

import { createHash } from "node:crypto";

/** Whitespace-separated tokens that contain at least one letter or digit. */
export function wordCount(text: string | null | undefined): number {
  if (!text) return 0;
  let n = 0;
  for (const tok of text.split(/\s+/)) if (/[\p{L}\p{N}]/u.test(tok)) n++;
  return n;
}

export function textHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// ---------------------------------------------------------------------------
// @mentions. A port of HotCRP's MentionParser (src/mentionparser.php), single
// roster list:
// - `@` must start the text or follow whitespace, one of ([{-+,;/ or an en/em
//   dash, and must not be followed by whitespace or the end of the text.
// - `@email` matches a roster email exactly (case-insensitive).
// - `@Name ...` matches roster names word by word (case- and
//   accent-insensitive). The first word may be the first given name or the
//   family name ("@Doe" = Jane Doe). More words are consumed while they keep
//   matching. A mention resolves only if exactly one person matches.
// - `@local` also matches the local part of a roster email (2+ letters).
// - A mention must end at the end of text, whitespace, or punctuation.

export interface MentionPerson {
  email: string;
  /** Display name; null/empty or an email-looking name means "no name". */
  name?: string | null;
}

interface Indexed {
  email: string;
  local: string;
  words: string[];
  /** Index of the first family-name word (= words.length if one word). */
  breakIdx: number;
}

export interface MentionRoster {
  readonly people: readonly Indexed[];
  readonly byEmail: ReadonlyMap<string, string>;
}

const collator = new Intl.Collator("en", { sensitivity: "base", usage: "search" });
const eq = (a: string, b: string) => collator.compare(a, b) === 0;

/** Precompute a roster once per sync. */
export function mentionRoster(people: Iterable<MentionPerson>): MentionRoster {
  const out: Indexed[] = [];
  const byEmail = new Map<string, string>();
  for (const p of people) {
    const email = p.email.trim().toLowerCase();
    if (email === "" || byEmail.has(email)) continue;
    byEmail.set(email, email);
    const name = (p.name ?? "").trim();
    const words = name === "" || name.includes("@") ? [] : name.replace(/\.\s*/g, " ").split(/\s+/).filter(Boolean);
    const at = email.indexOf("@");
    out.push({ email, local: at > 0 ? email.slice(0, at) : "", words, breakIdx: Math.max(words.length - 1, 0) });
  }
  return { people: out, byEmail };
}

const WORD_RE = /(\p{L}(?:[\p{L}\p{M}\p{N}]|-(?=\p{L}))*)\.?[ \t]*\r?\n?[ \t]*/uy;
const EMAIL_RE = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/y;
const END_PUNCT_RE = /(?!@)[\p{Po}\p{Pd}\p{Pe}\p{Pf}\p{S}\p{Z}]/uy;
const LEFT_OK = "([{-+,;/–—";

function wordAt(s: string, pos: number): { word: string; len: number } | undefined {
  WORD_RE.lastIndex = pos;
  const m = WORD_RE.exec(s);
  return m ? { word: m[1]!, len: m[0].length } : undefined;
}

function endsAt(s: string, pos: number): boolean {
  if (pos >= s.length) return true;
  if (".,;:?!)]}-/ \t\r\n\f\v".includes(s[pos]!)) return true;
  END_PUNCT_RE.lastIndex = pos;
  return END_PUNCT_RE.test(s);
}

interface Cand {
  p: Indexed;
  idx: number;
}

function matchWord(c: Cand, w: string): boolean {
  const { words, breakIdx } = c.p;
  if (c.idx < words.length && eq(words[c.idx]!, w)) {
    c.idx++;
    return true;
  }
  // Skip the rest of the given names and jump to the family name.
  if (c.idx < breakIdx && eq(words[breakIdx]!, w)) {
    c.idx = breakIdx + 1;
    return true;
  }
  return false;
}

/** Emails of roster members @mentioned in `text`, unique, in order of first mention. */
export function parseMentions(text: string, roster: MentionRoster): string[] {
  const found: string[] = [];
  const add = (e: string) => {
    if (!found.includes(e)) found.push(e);
  };
  let pos = 0;
  while ((pos = text.indexOf("@", pos)) !== -1) {
    const prev = pos > 0 ? text[pos - 1]! : undefined;
    const next = text[pos + 1];
    if ((prev !== undefined && !/\s/u.test(prev) && !LEFT_OK.includes(prev)) || next === undefined || /\s/u.test(next)) {
      pos++;
      continue;
    }

    // @email
    EMAIL_RE.lastIndex = pos + 1;
    const em = EMAIL_RE.exec(text);
    if (em) {
      // Trailing dots belong to the sentence, not the address.
      const email = em[0].replace(/\.+$/, "");
      const hit = roster.byEmail.get(email.toLowerCase());
      if (hit && endsAt(text, pos + 1 + email.length)) {
        add(hit);
        pos += 1 + email.length;
        continue;
      }
    }

    // @Name ...
    const first = wordAt(text, pos + 1);
    if (!first) {
      pos++;
      continue;
    }
    let cands: Cand[] = [];
    for (const p of roster.people) {
      const c: Cand = { p, idx: 0 };
      if (p.words.length > 0 && matchWord(c, first.word)) {
        cands.push(c);
      } else if (
        p.local.length > 1 &&
        text.slice(pos + 1, pos + 1 + p.local.length).toLowerCase() === p.local &&
        endsAt(text, pos + 1 + p.local.length)
      ) {
        cands.push({ p: { ...p, words: [p.local], breakIdx: 0 }, idx: 1 });
      }
    }
    let endpos = pos + 1 + first.word.length;
    let pos2 = pos + 1 + first.len;
    // Narrow while ambiguous.
    for (let w = wordAt(text, pos2); cands.length > 1 && w; w = wordAt(text, pos2)) {
      const word = w.word;
      cands = cands.filter((c) => matchWord(c, word));
      endpos = pos2 + word.length;
      pos2 += w.len;
    }
    // One left: consume the rest of its name.
    for (let w = wordAt(text, pos2); cands.length === 1 && w && matchWord(cands[0]!, w.word); w = wordAt(text, pos2)) {
      endpos = pos2 + w.word.length;
      pos2 += w.len;
    }
    if (cands.length === 1 && (endsAt(text, endpos) || (text[endpos] === "." && endsAt(text, endpos + 1)))) {
      add(cands[0]!.p.email);
    }
    pos = Math.max(pos2, pos + 1);
  }
  return found;
}

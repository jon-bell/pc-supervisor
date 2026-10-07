// Every identifying string a scenario puts into HotCRP: emails, full names,
// first and last names, affiliations, and titles (PLAN M13). Tests scan
// report and export output for these to prove nothing identifying leaks.

import type { Scenario } from "./format.js";

export interface SensitiveSet {
  /** Matched as substrings (case-insensitive): emails, full names, titles, affiliations. */
  phrases: string[];
  /** Matched as whole words (case-sensitive): single first/last names. */
  words: string[];
}

export function sensitiveStrings(sc: Scenario): SensitiveSet {
  const phrases = new Set<string>();
  const words = new Set<string>();
  const person = (p: { email?: string | null; first?: string; last?: string; affiliation?: string }) => {
    if (p.email) phrases.add(p.email.toLowerCase());
    if (p.first && p.last) phrases.add(`${p.first} ${p.last}`);
    for (const w of [p.first, p.last]) if (w && w.length >= 3) words.add(w);
    if (p.affiliation && p.affiliation.length >= 6) phrases.add(p.affiliation);
  };
  for (const p of sc.people) person(p);
  for (const p of sc.papers) {
    phrases.add(p.title);
    for (const a of p.authors) person(a as { email?: string; first?: string; last?: string; affiliation?: string });
  }
  return { phrases: [...phrases], words: [...words] };
}

/** The first sensitive string found in `text`, or null. */
export function findSensitive(text: string, s: SensitiveSet): string | null {
  const lower = text.toLowerCase();
  for (const p of s.phrases) if (lower.includes(p.toLowerCase())) return p;
  for (const w of s.words) if (new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(text)) return w;
  return null;
}

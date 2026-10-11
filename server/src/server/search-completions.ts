// What the "Papers matching" box completes (GET /api/search-completions).
//
// Two sources, merged:
//   - HotCRP's own: GET /searchcompletion (what HotCRP's search box offers
//     after `keyword:` — has:, dec:, round:, topic:, style:, show:/hide:,
//     submission fields, saved searches) and GET /alltags (tag names), both
//     read-only through hotcrp/client.ts with Zod schemas. HotCRP's
//     script.js hard-codes no keyword list, so the keywords themselves come
//     from hotcrp/search-keywords.ts (derived from its searchkeywords.json).
//   - The local store (SQL): tags with how many live papers carry each (the
//     ranking), tag values, PC members, decisions and rounds with counts,
//     review fields (score values like OveMer:>=4) and submission options.
// If HotCRP can't be reached the store-only answer is still useful
// (hotcrp: false). The token never appears: nothing from the client's
// errors is returned. Cached for COMPLETIONS_CACHE_MS of wall time, or until
// the next finished sync.

import { systemClock, type Clock } from "../clock.js";
import type { Config } from "../config.js";
import { SEARCH_COLLECTIONS } from "../hotcrp/collections.js";
import type { HotcrpClient } from "../hotcrp/client.js";
import { SEARCH_KEYWORDS, SEARCH_OPERATORS } from "../hotcrp/search-keywords.js";
import type { Store } from "../store/store.js";
import type { CompletionKeyword, SearchCompletionsResponse } from "./api-types.js";
import type { PaperFilter } from "./paper-filter.js";

export const COMPLETIONS_CACHE_MS = 60_000;
/** Distinct values kept per tag (e.g. #order#1 … #order#20). */
export const MAX_TAG_VALUES = 20;

export type SearchCompleter = Pick<HotcrpClient, "searchCompletion" | "allTags">;

type Value = SearchCompletionsResponse["values"][number];

export class SearchCompletions {
  #cache: { at: number; run: number; value: SearchCompletionsResponse } | null = null;

  constructor(
    private readonly store: Store,
    private readonly cfg: Pick<Config, "hotcrp">,
    private readonly paperFilter: PaperFilter,
    private readonly completer: SearchCompleter | undefined,
    private readonly wall: Clock = systemClock,
  ) {}

  async get(): Promise<SearchCompletionsResponse> {
    const now = this.wall.now().getTime();
    // A finished sync (new tags, decisions, people) invalidates the cache.
    const run = (this.store.db.prepare("select coalesce(max(id), 0) as id from sync_run where finished_at is not null").get() as { id: number }).id;
    if (this.#cache && this.#cache.run === run && now - this.#cache.at < COMPLETIONS_CACHE_MS) return this.#cache.value;
    const [hotcrp, defaultCollection] = await Promise.all([this.#hotcrp(), this.paperFilter.defaultCollection()]);
    const value = buildCompletions(this.store, { ...hotcrp, scoped: this.cfg.hotcrp.paperSearch !== "", defaultCollection });
    this.#cache = { at: now, run, value };
    return value;
  }

  clear(): void {
    this.#cache = null;
  }

  async #hotcrp(): Promise<{ completions: string[] | null; allTags: string[] | null }> {
    if (!this.completer) return { completions: null, allTags: null };
    const [c, t] = await Promise.allSettled([this.completer.searchCompletion(), this.completer.allTags()]);
    return {
      completions: c.status === "fulfilled" ? flattenCompletion(c.value.searchcompletion) : null,
      allTags: t.status === "fulfilled" ? t.value.tags : null,
    };
  }
}

/** HotCRP's completion list in its own order (script.js demand_load.search_completion: groups by pri; strings at pri 0). */
export function flattenCompletion(items: readonly (string | { pri?: number; nosort?: boolean; i: string | string[] })[]): string[] {
  const groups: { pri: number; i: string[] }[] = [];
  const plain: string[] = [];
  for (const it of items) {
    if (typeof it === "string") plain.push(it);
    else groups.push({ pri: it.pri ?? 0, i: [it.i].flat() });
  }
  if (plain.length > 0) groups.push({ pri: 0, i: plain });
  groups.sort((a, b) => a.pri - b.pri); // stable
  return groups.flatMap((g) => g.i);
}

interface Sources {
  completions: string[] | null;
  allTags: string[] | null;
  /** PCS_PAPER_SEARCH is set: tags HotCRP knows but no in-scope paper has are left out. */
  scoped: boolean;
  defaultCollection: string;
}

/** The response, from the store plus whatever HotCRP said. Pure apart from the SQL reads. */
export function buildCompletions(store: Store, src: Sources): SearchCompletionsResponse {
  const db = store.db;

  // Tags: one row per distinct tag string (name or name#value) on a live paper.
  const tagRows = db
    .prepare("select j.value as tag, count(*) as n from paper p, json_each(p.tags) j where p.deleted_seen_at is null group by j.value")
    .all() as { tag: string; n: number }[];
  const byName = new Map<string, { tag: string; count: number; spellings: Map<string, number>; values: Set<string> }>();
  for (const { tag, n } of tagRows) {
    const hash = tag.indexOf("#", 1);
    const name = hash > 0 ? tag.slice(0, hash) : tag;
    const value = hash > 0 ? tag.slice(hash + 1) : "";
    const key = name.toLowerCase();
    const e = byName.get(key) ?? { tag: name, count: 0, spellings: new Map<string, number>(), values: new Set<string>() };
    e.count += n;
    // Shown as its most common spelling (HotCRP tags are case-insensitive).
    const k = (e.spellings.get(name) ?? 0) + n;
    e.spellings.set(name, k);
    if (k > (e.spellings.get(e.tag) ?? 0) || (k === e.spellings.get(e.tag) && name < e.tag)) e.tag = name;
    if (value !== "" && value !== "0") e.values.add(value);
    byName.set(key, e);
  }
  if (!src.scoped) {
    for (const t of src.allTags ?? []) {
      const name = t.replace(/^#/, "");
      if (name && !byName.has(name.toLowerCase())) byName.set(name.toLowerCase(), { tag: name, count: 0, spellings: new Map(), values: new Set() });
    }
  }
  const tags = [...byName.values()]
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
    .map((e) => ({ tag: e.tag, count: e.count, values: [...e.values].sort(byNumber).slice(0, MAX_TAG_VALUES) }));

  const pc = db.prepare("select email, name from person where is_pc = 1 and removed_seen_at is null order by coalesce(name, email)").all() as {
    email: string;
    name: string | null;
  }[];

  const values: Value[] = [];
  const seen = new Map<string, Value>();
  const add = (v: Value) => {
    const key = v.text.toLowerCase();
    const had = seen.get(key);
    if (had) {
      if (v.count !== undefined) had.count = v.count;
      if (v.hint && !had.hint) had.hint = v.hint;
      return;
    }
    seen.set(key, v);
    values.push(v);
  };
  const keywords: CompletionKeyword[] = SEARCH_KEYWORDS.map((k) => ({ ...k }));
  const kwSeen = new Set(keywords.flatMap((k) => [k.text.toLowerCase(), ...(k.aliases ?? []).map((a) => `${a.toLowerCase()}:`)]));
  const addKeyword = (k: CompletionKeyword) => {
    if (kwSeen.has(k.text.toLowerCase())) return;
    kwSeen.add(k.text.toLowerCase());
    keywords.push(k);
  };

  // Decisions and rounds, with live-paper counts.
  const decisions = db
    .prepare("select decision, count(*) as n from paper where deleted_seen_at is null and decision is not null and decision != '' group by decision order by n desc")
    .all() as { decision: string; n: number }[];
  for (const d of decisions) add({ text: `dec:${quote(d.decision)}`, count: d.n });
  const rounds = db
    .prepare(
      "select round, count(distinct a.pid) as n from assignment a join paper p on p.pid = a.pid where a.removed_seen_at is null and p.deleted_seen_at is null and round is not null and round != '' group by round order by n desc",
    )
    .all() as { round: string; n: number }[];
  for (const r of rounds) add({ text: `round:${quote(r.round)}`, count: r.n });

  // HotCRP's own completions, in its order. "{placeholder}" entries become
  // keywords (the text before the brace) with the placeholder as the hint.
  for (const c of src.completions ?? []) {
    if (HOTCRP_BROKEN_COMPLETIONS.has(c.toLowerCase())) continue;
    const brace = c.indexOf("{");
    if (brace < 0) {
      add({ text: c });
      continue;
    }
    const prefix = c.slice(0, brace);
    if (!prefix.endsWith(":")) continue; // show:#{tag}, show:({formula}): tags and formulas are typed by hand
    const colon = prefix.indexOf(":");
    if (colon === prefix.length - 1) addKeyword({ text: prefix, hint: `submission field (${c.slice(brace + 1, c.indexOf("}", brace)) || "value"})` });
  }

  // Review fields: score fields complete to values and comparisons.
  for (const f of store.reviewFields()) {
    if (f.removedSeenAt !== null) continue;
    if (f.isText || !f.values || f.values.length === 0) {
      addKeyword({ text: `${f.uid}:`, hint: `review field: ${f.name}` });
      continue;
    }
    addKeyword({ text: `${f.uid}:`, hint: `score: ${f.name} (1–${f.values.length})` });
    const n = f.values.length;
    for (let i = n; i >= 1; i--) add({ text: `${f.uid}:${i}`, hint: `${f.name}: ${f.values[i - 1]}` });
    for (let i = n; i >= 2; i--) add({ text: `${f.uid}:>=${i}`, hint: `${f.name} at least ${i}` });
    for (let i = 1; i < n; i++) add({ text: `${f.uid}:<=${i}`, hint: `${f.name} at most ${i}` });
    add({ text: `${f.uid}:any`, hint: `any ${f.name} score` });
    add({ text: `${f.uid}:none`, hint: `no ${f.name} score` });
  }

  // Submission options (synced settings sf): opt:"Name" and has:"Name".
  const options = db.prepare("select name, type from submission_field where removed_seen_at is null order by name").all() as { name: string; type: string | null }[];
  for (const o of options) {
    add({ text: `opt:${quote(o.name)}`, hint: o.type ? `submission field (${o.type})` : "submission field" });
  }

  return {
    tags,
    pc,
    keywords,
    operators: [...SEARCH_OPERATORS],
    values,
    collections: SEARCH_COLLECTIONS.map((c) => ({ ...c })),
    defaultCollection: src.defaultCollection,
    hotcrp: src.completions !== null,
  };
}

/**
 * Completions HotCRP's /searchcompletion offers that its own parser warns
 * about at hotcrp@60f693f: `round:any` (Review_SearchTerm::parse_round calls
 * ReviewSearchMatcher::parse_round without allow_generic). An upstream bug;
 * spec §1 and §10.6.
 */
const HOTCRP_BROKEN_COMPLETIONS = new Set(["round:any"]);

const byNumber = (a: string, b: string) => {
  const x = Number(a);
  const y = Number(b);
  return Number.isFinite(x) && Number.isFinite(y) ? x - y : a.localeCompare(b);
};

/** HotCRP's SearchWord::quote (src/searchword.php): quote a value with spaces or specials. */
export function quote(s: string): string {
  if (s === "" || /^[-A-Za-z0-9_.@/]+$/.test(s)) return s;
  return `"${s.replace(/\\.?|"/gs, (m) => (m.length === 1 ? `\\${m}` : m))}"`;
}

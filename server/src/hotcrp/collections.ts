// HotCRP's "Search in" collections: the `t=` parameter of /search.
//
// From hotcrp@60f693f8 src/searchterm.php Limit_SearchTerm::$reqtype_map
// (canonical names only: HotCRP echoes the canonical name back in
// search_params, and the client checks the echo) and the descriptions in
// src/papersearch.php PaperSearch::$search_type_descriptions. The order is
// HotCRP's own selector order for a chair (PaperSearch::viewable_limits, then
// viewable_manager_limits). HotCRP silently treats an unknown `t` as "none",
// so only these are ever sent.
//
// "Your …" collections are relative to the token's account (the chair).

export interface SearchCollection {
  t: string;
  label: string;
}

export const SEARCH_COLLECTIONS = [
  { t: "s", label: "Submitted" },
  { t: "accepted", label: "Accepted" },
  { t: "undecided", label: "Undecided" },
  { t: "active", label: "Active" },
  { t: "all", label: "All" },
  { t: "unsub", label: "Draft submissions" },
  { t: "r", label: "Your reviews" },
  { t: "rout", label: "Your incomplete reviews" },
  { t: "req", label: "Your review requests" },
  { t: "lead", label: "Your discussion leads" },
  { t: "admin", label: "Submissions you administer" },
  { t: "alladmin", label: "Submissions you’re allowed to administer" },
  { t: "reviewable", label: "Reviewable" },
  { t: "viewable", label: "Submissions you can view" },
  { t: "a", label: "Your submissions" },
] as const satisfies readonly SearchCollection[];

export type SearchCollectionName = (typeof SEARCH_COLLECTIONS)[number]["t"];

const NAMES = new Set<string>(SEARCH_COLLECTIONS.map((c) => c.t));

export function isSearchCollection(t: string): t is SearchCollectionName {
  return NAMES.has(t);
}

export function collectionLabel(t: string): string {
  return SEARCH_COLLECTIONS.find((c) => c.t === t)?.label ?? t;
}

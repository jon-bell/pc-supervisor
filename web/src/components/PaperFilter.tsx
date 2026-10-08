// The in-app paper filter: the chair types a HotCRP search, and the
// paper-centric views (FILTERED_PATHS) show only the papers it matches. The
// server resolves it with HotCRP /search, ANDed with PCS_PAPER_SEARCH (shown
// here when set). The search lives in ?search= and its "Search in"
// collection in ?t= (sticky parameters, see router.tsx), so they survive
// navigation, reloads and shared links. The box autocompletes HotCRP syntax
// (SearchCombobox); HotCRP's warnings show beside the count, as HotCRP shows
// them above its results.

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { isFilterOn, usePaperSearch, usePaperSearchInfo, useSearchCompletions, type MetaResponse } from "../api";
import { plural } from "../format";
import { navigate, useLocation } from "../router";
import { SearchCombobox } from "./SearchCombobox";

/** Paths whose views honor ?search= (add new paper-centric views here). */
export const FILTERED_PATHS: readonly ((path: string) => boolean)[] = [
  (p) => p === "/" || p.startsWith("/papers/"),
  (p) => p === "/acs",
  (p) => p === "/leads" || p.startsWith("/leads/"),
  (p) => p === "/reviewers",
  (p) => p.startsWith("/people/"),
  (p) => p === "/overview",
];

export const isFiltered = (path: string) => FILTERED_PATHS.some((f) => f(path));

/** HotCRP's collections (labels as HotCRP shows them), until /api/search-completions answers. */
const FALLBACK_COLLECTIONS = [
  { t: "s", label: "Submitted" },
  { t: "all", label: "All" },
];

export function PaperFilterBar({ meta }: { meta: MetaResponse }) {
  const loc = useLocation();
  const filter = usePaperSearch();
  const [draft, setDraft] = useState(filter.search);
  useEffect(() => setDraft(filter.search), [filter.search]);
  const info = usePaperSearchInfo(filter);
  const visible = isFiltered(loc.path);
  const completions = useSearchCompletions(visible).data;
  if (!visible) return null;

  const go = (search: string, t: string) => {
    const q = new URLSearchParams(loc.query);
    if (search.trim()) q.set("search", search.trim());
    else q.delete("search");
    if (t) q.set("t", t);
    else q.delete("t");
    const s = q.toString();
    navigate(s ? `${loc.path}?${s}` : loc.path, { sticky: false });
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    go(draft, filter.t);
  };

  const collections = completions?.collections ?? FALLBACK_COLLECTIONS;
  const dflt = completions?.defaultCollection ?? "";
  const dfltLabel = collections.find((c) => c.t === dflt)?.label;

  let status: ReactNode = null;
  if (isFilterOn(filter)) {
    if (info.error) status = <span className="error" data-testid="paper-filter-error">{info.error.message}</span>;
    else if (info.data) {
      const { inStore, pids, warnings } = info.data;
      const extra = (pids?.length ?? 0) - (inStore ?? 0);
      status = (
        <>
          <span className="count" data-testid="paper-filter-status" data-papers={inStore ?? 0}>
            {plural(inStore ?? 0, "paper")} {inStore === 1 ? "matches" : "match"}
            {extra > 0 ? ` (HotCRP finds ${extra} more not yet synced)` : ""}
          </span>
          {warnings.length > 0 ? (
            <span className="warning" data-testid="paper-filter-warning" role="status">
              HotCRP: {warnings.join(" ")}
            </span>
          ) : null}
        </>
      );
    } else status = <span className="count">Searching HotCRP…</span>;
  }

  return (
    <form className="paper-filter" data-testid="paper-filter" onSubmit={submit} role="search">
      <label htmlFor="paper-filter-input" className="paper-filter-label">
        Papers matching
      </label>
      <SearchCombobox id="paper-filter-input" value={draft} onChange={setDraft} />
      <select
        id="paper-filter-collection"
        className="paper-filter-collection"
        data-testid="paper-filter-collection"
        aria-label="Search in (HotCRP collection)"
        title="Search in: HotCRP's collection (t=)"
        value={filter.t}
        onChange={(e) => go(draft, e.target.value)}
      >
        <option value="">{dfltLabel ? `${dfltLabel} (HotCRP default)` : "HotCRP default"}</option>
        {collections
          .filter((c) => c.t !== dflt)
          .map((c) => (
            <option key={c.t} value={c.t}>
              {c.label}
            </option>
          ))}
        {filter.t && !collections.some((c) => c.t === filter.t) ? <option value={filter.t}>{filter.t}</option> : null}
      </select>
      <button type="submit" className="btn" data-testid="paper-filter-apply">
        Filter
      </button>
      {isFilterOn(filter) ? (
        <button type="button" className="btn" data-testid="paper-filter-clear" onClick={() => go("", "")}>
          Clear
        </button>
      ) : null}
      {status}
      {meta.paperSearch ? (
        <span className="muted paper-scope" data-testid="paper-scope" title="PCS_PAPER_SEARCH: every view and sync is limited to these papers">
          Pinned to HotCRP search <code>{meta.paperSearch}</code>
        </span>
      ) : null}
    </form>
  );
}

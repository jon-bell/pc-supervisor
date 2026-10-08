// The in-app paper filter: the chair types a HotCRP search, and the
// paper-centric views (FILTERED_PATHS) show only the papers it matches. The
// server resolves it with HotCRP /search, ANDed with PCS_PAPER_SEARCH (shown
// here when set); the search lives in ?search= (a sticky parameter, see
// router.tsx), so it survives navigation, reloads and shared links.

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { usePaperSearch, usePaperSearchInfo, type MetaResponse } from "../api";
import { plural } from "../format";
import { navigate, useLocation } from "../router";

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

export function PaperFilterBar({ meta }: { meta: MetaResponse }) {
  const loc = useLocation();
  const search = usePaperSearch();
  const [draft, setDraft] = useState(search);
  useEffect(() => setDraft(search), [search]);
  const info = usePaperSearchInfo(search);
  if (!isFiltered(loc.path)) return null;

  const go = (value: string) => {
    const q = new URLSearchParams(loc.query);
    if (value.trim()) q.set("search", value.trim());
    else q.delete("search");
    const s = q.toString();
    navigate(s ? `${loc.path}?${s}` : loc.path, { sticky: false });
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    go(draft);
  };

  let status: ReactNode = null;
  if (search) {
    if (info.error) status = <span className="error" data-testid="paper-filter-error">{info.error.message}</span>;
    else if (info.data) {
      const { inStore, pids } = info.data;
      const extra = (pids?.length ?? 0) - (inStore ?? 0);
      status = (
        <span className="count" data-testid="paper-filter-status" data-papers={inStore ?? 0}>
          {plural(inStore ?? 0, "paper")} {inStore === 1 ? "matches" : "match"}
          {extra > 0 ? ` (HotCRP finds ${extra} more not yet synced)` : ""}
        </span>
      );
    } else status = <span className="count">Searching HotCRP…</span>;
  }

  return (
    <form className="paper-filter" data-testid="paper-filter" onSubmit={submit} role="search">
      <label>
        Papers matching{" "}
        <input
          type="search"
          data-testid="paper-filter-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="a HotCRP search, e.g. #tag or 1-50"
          aria-label="Filter papers by HotCRP search"
          spellCheck={false}
          maxLength={1000}
        />
      </label>
      <button type="submit" className="btn" data-testid="paper-filter-apply">
        Filter
      </button>
      {search ? (
        <button type="button" className="btn" data-testid="paper-filter-clear" onClick={() => go("")}>
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

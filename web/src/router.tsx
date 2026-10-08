// A minimal client-side router (History API). The server falls back to
// index.html for non-/api paths, so every route deep-links. Add M6 views to
// ROUTES in App.tsx; nothing here needs to change.
//
// Sticky query parameters: the in-app paper filter (?search=, a HotCRP
// search, and ?t=, its "Search in" collection) follows the chair from view
// to view. navigate() and <Link> carry the
// current value onto any in-app target that doesn't set it itself; pass
// { sticky: false } (navigate) to drop it, e.g. when clearing the filter.

import { useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from "react";

const NAV_EVENT = "pcs:navigate";

function subscribe(cb: () => void): () => void {
  window.addEventListener("popstate", cb);
  window.addEventListener(NAV_EVENT, cb);
  return () => {
    window.removeEventListener("popstate", cb);
    window.removeEventListener(NAV_EVENT, cb);
  };
}

const snapshot = () => `${window.location.pathname}${window.location.search}`;

export interface Location {
  path: string;
  query: URLSearchParams;
}

export function useLocation(): Location {
  const href = useSyncExternalStore(subscribe, snapshot);
  const u = new URL(href, "http://local");
  return { path: u.pathname, query: u.searchParams };
}

/** Query parameters that survive in-app navigation. */
export const STICKY_PARAMS: readonly string[] = ["search", "t"];

/** `to` with the current sticky parameters added (when it is an in-app path that doesn't set them). */
export function withSticky(to: string, current: string = window.location.search): string {
  if (!to.startsWith("/") || to.startsWith("//")) return to;
  const from = new URLSearchParams(current);
  const u = new URL(to, "http://local");
  let changed = false;
  for (const k of STICKY_PARAMS) {
    const v = from.get(k);
    if (v && !u.searchParams.has(k)) {
      u.searchParams.set(k, v);
      changed = true;
    }
  }
  return changed ? `${u.pathname}${u.search}${u.hash}` : to;
}

export function navigate(to: string, opts: { replace?: boolean; sticky?: boolean } = {}): void {
  if (opts.sticky !== false) to = withSticky(to);
  if (to === snapshot()) return;
  if (opts.replace) window.history.replaceState(null, "", to);
  else window.history.pushState(null, "", to);
  window.dispatchEvent(new Event(NAV_EVENT));
}

/** Match "/papers/:pid" against a path; returns params or null. */
export function match(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split("/").filter(Boolean);
  const s = path.split("/").filter(Boolean);
  if (p.length !== s.length) return null;
  const out: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    const seg = p[i]!;
    if (seg.startsWith(":")) out[seg.slice(1)] = decodeURIComponent(s[i]!);
    else if (seg !== s[i]) return null;
  }
  return out;
}

/** An in-app link: plain <a href> (middle-click works), client-side navigation on click. */
export function Link({ to, onClick, ...rest }: { to: string } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  const href = withSticky(to, `?${useLocation().query.toString()}`);
  const click = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(href);
  };
  return <a href={href} onClick={click} {...rest} />;
}

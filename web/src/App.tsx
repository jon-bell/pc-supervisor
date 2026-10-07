// The app shell: header (title, phase, now, nav, sync status) and the routed
// view. Views register in ROUTES and, if they belong in the nav, in NAV:
// triage (/, /papers/:pid), the AC table (/acs), reviewer outliers
// (/reviewers), the person page (/people/:email) and the overview (/overview).

import type { ReactNode } from "react";
import { useMeta, type MetaResponse } from "./api";
import { ModulesNav } from "./components/ModulesNav";
import { SyncIndicator } from "./components/SyncIndicator";
import { Volatile } from "./components/Time";
import { formatTime, PHASE_LABELS } from "./format";
import { Link, match, useLocation } from "./router";
import { Acs } from "./views/Acs";
import { EarlyReject } from "./views/EarlyReject";
import { Overview } from "./views/Overview";
import { Person } from "./views/Person";
import { Reviewers } from "./views/Reviewers";
import { TierProgress } from "./views/TierProgress";
import { Triage } from "./views/Triage";

interface Route {
  path: string;
  render: (meta: MetaResponse, params: Record<string, string>) => ReactNode;
}

const ROUTES: Route[] = [
  { path: "/", render: (meta) => <Triage meta={meta} pid={null} /> },
  { path: "/papers/:pid", render: (meta, p) => <Triage meta={meta} pid={/^\d+$/.test(p.pid ?? "") ? Number(p.pid) : null} /> },
  { path: "/acs", render: (meta) => <Acs meta={meta} /> },
  { path: "/reviewers", render: () => <Reviewers /> },
  { path: "/people/:email", render: (meta, p) => <Person key={p.email} meta={meta} email={p.email ?? ""} /> },
  { path: "/overview", render: (meta) => <Overview meta={meta} /> },
  { path: "/modules/tier-progress", render: (meta) => <TierProgress meta={meta} /> },
  { path: "/modules/early-reject", render: (meta) => <EarlyReject meta={meta} /> },
];

/** Top-level nav. Not a ranking of people anywhere (spec §2). */
const NAV: { to: string; label: string; active: (path: string) => boolean }[] = [
  { to: "/", label: "Triage", active: (p) => p === "/" || p.startsWith("/papers/") },
  { to: "/acs", label: "ACs", active: (p) => p === "/acs" },
  { to: "/reviewers", label: "Reviewers", active: (p) => p === "/reviewers" || p.startsWith("/people/") },
  { to: "/overview", label: "Overview", active: (p) => p === "/overview" },
];

export function App() {
  const meta = useMeta();
  const loc = useLocation();
  const m = meta.data;

  let view: ReactNode = null;
  if (m) {
    for (const r of ROUTES) {
      const params = match(r.path, loc.path);
      if (params) {
        view = r.render(m, params);
        break;
      }
    }
    view ??= (
      <p className="error" data-testid="not-found">
        No such page. <Link to="/">Back to triage</Link>
      </p>
    );
  }

  return (
    <div className="app">
      <header className="top">
        <div className="brand">PC Supervisor</div>
        <nav className="nav" data-testid="nav">
          {NAV.map((n) => (
            <Link key={n.to} to={n.to} className={n.active(loc.path) ? "active" : undefined}>
              {n.label}
            </Link>
          ))}
        </nav>
        <ModulesNav path={loc.path} />
        {m ? (
          <div className="phase" data-testid="phase">
            {PHASE_LABELS[m.phase] ?? m.phase} ·{" "}
            {m.pinned ? (
              <span title="PCS_NOW pins the clock">as of {formatTime(m.now, m.tz)}</span>
            ) : (
              <Volatile>as of {formatTime(m.now, m.tz)}</Volatile>
            )}
          </div>
        ) : null}
        <div className="spacer" />
        {m ? <SyncIndicator tz={m.tz} /> : null}
      </header>
      <main className="main">
        {meta.error ? <p className="error">Could not reach the local server: {meta.error.message}</p> : view}
      </main>
    </div>
  );
}

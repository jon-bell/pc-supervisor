// The app shell: header (title, phase, now, nav, sync status) and the routed
// view. Views register in ROUTES and, if they belong in the nav, in NAV:
// triage (/, /papers/:pid), the AC table (/acs), discussion leads (/leads,
// /leads/:email), reviewer outliers
// (/reviewers), the person page (/people/:email) and the overview (/overview).

import { useMemo, type ReactNode } from "react";
import { useMeta, type MetaResponse } from "./api";
import { ModulesNav } from "./components/ModulesNav";
import { PaperFilterBar } from "./components/PaperFilter";
import { SyncIndicator } from "./components/SyncIndicator";
import { Volatile } from "./components/Time";
import { formatTime, PHASE_LABELS } from "./format";
import { Link, match, useLocation } from "./router";
import { phaseStartOf } from "./table/model";
import { TableClockContext } from "./table/useTable";
import { TiersContext } from "./tiers";
import { Acs } from "./views/Acs";
import { Assignment } from "./views/Assignment";
import { LeadDetail, Leads } from "./views/Leads";
import { Solver } from "./views/Solver";
import { EarlyReject } from "./views/EarlyReject";
import { Overview } from "./views/Overview";
import { Person } from "./views/Person";
import { QuickReject } from "./views/QuickReject";
import { Reserve } from "./views/Reserve";
import { Reviewers } from "./views/Reviewers";
import { Report } from "./views/Report";
import { TierProgress } from "./views/TierProgress";
import { Triage } from "./views/Triage";
import { Rules } from "./views/Rules";
import { FlagHistory } from "./views/FlagHistory";

interface Route {
  path: string;
  render: (meta: MetaResponse, params: Record<string, string>) => ReactNode;
}

const ROUTES: Route[] = [
  { path: "/", render: (meta) => <Triage meta={meta} pid={null} /> },
  { path: "/papers/:pid", render: (meta, p) => <Triage meta={meta} pid={/^\d+$/.test(p.pid ?? "") ? Number(p.pid) : null} /> },
  { path: "/acs", render: (meta) => <Acs meta={meta} /> },
  { path: "/leads", render: (meta) => <Leads meta={meta} /> },
  { path: "/leads/:email", render: (meta, p) => <LeadDetail key={p.email} meta={meta} email={p.email ?? ""} /> },
  { path: "/reviewers", render: () => <Reviewers /> },
  { path: "/people/:email", render: (meta, p) => <Person key={p.email} meta={meta} email={p.email ?? ""} /> },
  { path: "/overview", render: (meta) => <Overview meta={meta} /> },
  // Chair rule settings and flag history (spec §5c).
  { path: "/rules", render: (meta) => <Rules meta={meta} /> },
  { path: "/flag-history", render: (meta) => <FlagHistory meta={meta} /> },
  // Phase-2 modules (spec §10.4).
  { path: "/modules/reserve", render: (meta) => <Reserve meta={meta} /> },
  { path: "/modules/quickreject", render: (meta) => <QuickReject meta={meta} /> },
  { path: "/modules/assignment", render: (meta) => <Assignment meta={meta} /> },
  { path: "/modules/solver", render: (meta) => <Solver meta={meta} /> },
  {
    path: "/modules/tier-progress",
    render: (meta) =>
      meta.tiersConfigured ? (
        <TierProgress meta={meta} />
      ) : (
        <p className="muted page" data-testid="no-tiers">
          No reviewer tiers are configured (PCS_TIER_TAGS is empty), so there is no per-tier view. <Link to="/">Back to triage</Link>
        </p>
      ),
  },
  { path: "/modules/early-reject", render: (meta) => <EarlyReject meta={meta} /> },
  { path: "/modules/report", render: (meta) => <Report meta={meta} /> },
];

/** Top-level nav. Not a ranking of people anywhere (spec §2). */
const NAV: { to: string; label: string; active: (path: string) => boolean }[] = [
  { to: "/", label: "Triage", active: (p) => p === "/" || p.startsWith("/papers/") },
  { to: "/acs", label: "ACs", active: (p) => p === "/acs" },
  { to: "/leads", label: "Leads", active: (p) => p === "/leads" || p.startsWith("/leads/") },
  { to: "/reviewers", label: "Reviewers", active: (p) => p === "/reviewers" || p.startsWith("/people/") },
  { to: "/overview", label: "Overview", active: (p) => p === "/overview" },
  { to: "/flag-history", label: "Flag history", active: (p) => p === "/flag-history" },
  { to: "/rules", label: "Rules", active: (p) => p === "/rules" },
];

export function App() {
  const meta = useMeta();
  const loc = useLocation();
  const m = meta.data;
  // Date filters resolve against the server's clock (PCS_NOW), never the browser's.
  const clock = useMemo(() => ({ now: m?.now ?? 0, tz: m?.tz ?? "UTC", phaseStart: m ? phaseStartOf(m.phases, m.now) : null }), [m]);

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
        <ModulesNav path={loc.path} tiers={m?.tiersConfigured ?? true} />
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
      {m ? <PaperFilterBar meta={m} /> : null}
      <main className="main">
        <TiersContext.Provider value={m?.tiersConfigured ?? true}>
          <TableClockContext.Provider value={clock}>
            {meta.error ? <p className="error">Could not reach the local server: {meta.error.message}</p> : view}
          </TableClockContext.Provider>
        </TiersContext.Provider>
      </main>
    </div>
  );
}

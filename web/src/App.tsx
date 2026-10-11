// The app shell: a collapsible sidebar (title; a status block with the phase,
// now, the next deadline and the sync status; the Monitor and Modules nav
// groups), the paper filter bar and the routed view. Views register in
// ROUTES and, if they belong in the nav, in NAV:
// triage (/, /papers/:pid), the AC table (/acs), discussion leads (/leads,
// /leads/:email), reviewer outliers
// (/reviewers), the person page (/people/:email) and the overview (/overview).

import { useMemo, useState, type ReactNode } from "react";
import { useMeta, type MetaResponse } from "./api";
import { ModulesNav } from "./components/ModulesNav";
import { FilterSlotContext, PaperFilterBar } from "./components/PaperFilter";
import { SyncIndicator } from "./components/SyncIndicator";
import { Volatile } from "./components/Time";
import { daysUntil, formatDate, formatTime, nextPhaseDate, PHASE_LABELS } from "./format";
import { Link, match, useLocation } from "./router";
import { ScalesContext, scalesOf } from "./scores";
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
];

const SIDEBAR_KEY = "pcs.sidebar";
function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_KEY) === "collapsed";
  } catch {
    return false;
  }
}

/** Phase, the clock, the next deadline and the sync status: the sidebar's status block. */
function StatusBlock({ m }: { m: MetaResponse }) {
  const next = nextPhaseDate(m);
  return (
    <div className="status-block">
      <div className="phase" data-testid="phase">
        <span className="phase-name">{PHASE_LABELS[m.phase] ?? m.phase}</span>{" "}
        {m.pinned ? (
          <span className="phase-asof" title="PCS_NOW pins the clock">
            as of {formatTime(m.now, m.tz)}
          </span>
        ) : (
          <span className="phase-asof">
            <Volatile>as of {formatTime(m.now, m.tz)}</Volatile>
          </span>
        )}
      </div>
      {next ? (
        <div className="phase-next" data-testid="phase-next" title={formatTime(next.at, m.tz)}>
          {next.label} {daysUntil(next.at, m.now)} <span className="muted">({formatDate(next.at, m.tz)})</span>
        </div>
      ) : null}
      <SyncIndicator tz={m.tz} />
    </div>
  );
}

export function App() {
  const meta = useMeta();
  const loc = useLocation();
  const m = meta.data;
  // Date filters resolve against the server's clock (PCS_NOW), never the browser's.
  const clock = useMemo(() => ({ now: m?.now ?? 0, tz: m?.tz ?? "UTC", phaseStart: m ? phaseStartOf(m.phases, m.now) : null }), [m]);
  const scales = useMemo(() => scalesOf(m), [m]);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [filterSlot, setFilterSlot] = useState<HTMLElement | null>(null);
  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    try {
      window.localStorage.setItem(SIDEBAR_KEY, next ? "collapsed" : "open");
    } catch {
      // Storage is a convenience; the toggle works without it.
    }
  };

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
    <div className={`app${collapsed ? " app-collapsed" : ""}`}>
      <aside className="side" aria-label="Navigation and status">
        <div className="side-head">
          <Link to="/" className="brand" title="PC Supervisor">
            <span className="brand-mark" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <span className="brand-name">PC Supervisor</span>
          </Link>
          <button
            type="button"
            className="side-toggle"
            data-testid="sidebar-toggle"
            aria-expanded={!collapsed}
            aria-controls="sidebar-body"
            title={collapsed ? "Show the sidebar" : "Hide the sidebar"}
            onClick={toggle}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              {collapsed ? <path d="M5 2l5 5-5 5" /> : <path d="M9 2L4 7l5 5" />}
            </svg>
            <span className="visually-hidden">{collapsed ? "Show the sidebar" : "Hide the sidebar"}</span>
          </button>
        </div>
        <div className="side-body" id="sidebar-body" hidden={collapsed}>
          {m ? <StatusBlock m={m} /> : null}
          <nav className="nav" data-testid="nav" aria-labelledby="nav-monitor">
            <h2 className="side-group" id="nav-monitor">
              Monitor
            </h2>
            {NAV.map((n) => {
              const on = n.active(loc.path);
              return (
                <Link key={n.to} to={n.to} className={on ? "active" : undefined} aria-current={on ? "page" : undefined}>
                  {n.label}
                </Link>
              );
            })}
          </nav>
          <ModulesNav path={loc.path} tiers={m?.tiersConfigured ?? true} />
        </div>
      </aside>
      <div className="content">
        {m ? <PaperFilterBar meta={m} slotRef={setFilterSlot} /> : null}
        <main className="main">
          <FilterSlotContext.Provider value={filterSlot}>
            <ScalesContext.Provider value={scales}>
              <TiersContext.Provider value={m?.tiersConfigured ?? true}>
                <TableClockContext.Provider value={clock}>
                  {meta.error ? <p className="error">Could not reach the local server: {meta.error.message}</p> : view}
                </TableClockContext.Provider>
              </TiersContext.Provider>
            </ScalesContext.Provider>
          </FilterSlotContext.Provider>
        </main>
      </div>
    </div>
  );
}

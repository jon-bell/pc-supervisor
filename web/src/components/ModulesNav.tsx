// The "Modules" nav group (spec §10.4, phase-2 modules) in the sidebar. Each
// module view adds one entry to MODULE_NAV; App.tsx renders <ModulesNav />
// under the Monitor group.

import { Link } from "../router";

export const MODULE_NAV: { to: string; label: string }[] = [
  { to: "/modules/reserve", label: "Reserve" },
  { to: "/modules/quickreject", label: "Quick reject" },
  { to: "/modules/assignment", label: "Assignment" },
  { to: "/modules/solver", label: "Solver" },
  { to: "/modules/tier-progress", label: "Reviewing by tier" },
  { to: "/modules/early-reject", label: "Early reject" },
  { to: "/modules/report", label: "Report" },
];

/** Module entries that only make sense with reviewer tiers (PCS_TIER_TAGS). */
const NEEDS_TIERS: ReadonlySet<string> = new Set(["/modules/tier-progress"]);

export function ModulesNav({ path, tiers = true }: { path: string; tiers?: boolean }) {
  return (
    <nav className="nav nav-group" data-testid="nav-modules" aria-labelledby="nav-modules-label">
      <h2 className="side-group" id="nav-modules-label">
        Modules
      </h2>
      {MODULE_NAV.filter((n) => tiers || !NEEDS_TIERS.has(n.to)).map((n) => (
        <Link key={n.to} to={n.to} className={path === n.to ? "active" : undefined} aria-current={path === n.to ? "page" : undefined}>
          {n.label}
        </Link>
      ))}
    </nav>
  );
}

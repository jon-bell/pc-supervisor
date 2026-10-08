// The "Modules" nav group (spec §10.4, phase-2 modules). Each module view
// adds one entry to MODULE_NAV; App.tsx renders <ModulesNav /> next to the main nav.

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

export function ModulesNav({ path }: { path: string }) {
  return (
    <nav className="nav nav-group" data-testid="nav-modules" aria-label="Modules">
      <span className="nav-group-label">Modules:</span>
      {MODULE_NAV.map((n) => (
        <Link key={n.to} to={n.to} className={path === n.to ? "active" : undefined}>
          {n.label}
        </Link>
      ))}
    </nav>
  );
}

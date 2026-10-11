// Every client-side view (web/src/App.tsx routes) with golden sample params,
// for specs that must visit them all (security.spec.ts, csp/csp.spec.ts).
import { P } from "@pcs/seed/scenarios/golden/scenario";

export const PAGES: readonly string[] = [
  "/",
  "/papers/4",
  "/acs",
  "/leads",
  `/leads/${encodeURIComponent(P.ben)}`,
  "/reviewers",
  `/people/${encodeURIComponent(P.silent)}`,
  "/overview",
  "/rules",
  "/flag-history",
  "/modules/reserve",
  "/modules/quickreject",
  "/modules/tier-progress",
  "/modules/early-reject",
  "/modules/report",
];

// Every client-side view (web/src/App.tsx routes) with golden sample params,
// for specs that must visit them all (security.spec.ts, csp/csp.spec.ts).
import { P } from "@pcs/seed/scenarios/golden/scenario";

export const PAGES: readonly string[] = [
  "/",
  "/papers/4",
  "/acs",
  "/reviewers",
  `/people/${encodeURIComponent(P.silent)}`,
  "/overview",
  "/modules/reserve",
  "/modules/quickreject",
  "/modules/tier-progress",
  "/modules/early-reject",
  "/modules/report",
];

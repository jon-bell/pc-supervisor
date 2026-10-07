// Settings the e2e server runs with (on top of the CI / .env.test env).
// The port is the e2e server's own, so a dev server on PCS_PORT can't be
// mistaken for it.
export const E2E_PORT = 5327;

export const E2E_ENV: Readonly<Record<string, string>> = {
  PCS_PORT: String(E2E_PORT),
  PCS_TIER_TAGS: "junior=junior,reciprocal=reciprocal",
  PCS_HISTORY_RPS: "50",
};

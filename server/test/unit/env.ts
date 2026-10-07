// A minimal valid env for config tests (synthetic dates from ci.yml).
export const BASE_ENV: Record<string, string> = {
  NODE_ENV: "test",
  PCS_HOTCRP_URL: "http://127.0.0.1:8080",
  PCS_HOTCRP_TOKEN: "hct_unitTestTokenNotReal0123456789",
  PCS_PHASE_REVIEW_DUE: "2030-02-01T23:59",
  PCS_PHASE_DISCUSSION_OPEN: "2030-02-12T00:00",
  PCS_PHASE_DISCUSSION_CLOSE: "2030-03-01T23:59",
  PCS_PHASE_DECISIONS_DUE: "2030-03-03T23:59",
};

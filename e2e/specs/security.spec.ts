// The served app's headers: a CSP with no external origins, and no token.
import { expect, test } from "@playwright/test";

test("the app is served with a same-origin-only CSP and never carries the token", async ({ request }) => {
  const token = process.env.PCS_HOTCRP_TOKEN ?? "";
  expect(token.length).toBeGreaterThan(8);
  for (const url of ["/", "/papers/4", "/api/meta", "/api/triage", "/api/papers/4", "/api/sync/status", "/api/actions", "/api/papers/4/nudge"]) {
    const r = await request.get(url);
    expect(r.status(), url).toBe(200);
    const csp = r.headers()["content-security-policy"] ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).not.toMatch(/https?:|\*|unsafe/);
    expect(await r.text()).not.toContain(token);
    expect(JSON.stringify(r.headers())).not.toContain(token);
  }
});

// `pcs probe` against the local harness (PLAN M0 "done when": green in CI).
// Assumes only what scripts/harness-smoke.sh seeds: >= 1 submitted paper
// ("Smoke Paper") with a metareviewer, >= 2 complete reviews, >= 1 comment,
// all by @example.org users.
//
// Run: set -a; . ./.env.test; set +a; npm run test:integration

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { assertHarnessUrl } from "../../src/hotcrp/harness-guard.js";
import { runProbe } from "../../src/probe/command.js";
import type { ProbeReport } from "../../src/probe/report.js";

const CLI = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));

/** Only the vars the probe needs, so a stray PCS_* in the shell can't break it. */
function probeEnv(): Record<string, string> {
  assertHarnessUrl();
  return { PCS_HOTCRP_URL: process.env.PCS_HOTCRP_URL!, PCS_HOTCRP_TOKEN: process.env.PCS_HOTCRP_TOKEN! };
}

async function probe(args: string[]) {
  let stdout = "";
  let stderr = "";
  const code = await runProbe(args, { env: probeEnv(), stdout: (s) => (stdout += s), stderr: (s) => (stderr += s) });
  return { code, stdout, stderr };
}

function expectNoContent(out: string) {
  expect(out).not.toContain("@example.org");
  expect(out).not.toContain("Smoke Paper");
  expect(out).not.toContain("Test Admin");
  expect(out).not.toContain(process.env.PCS_HOTCRP_TOKEN!);
}

let rep: ProbeReport;

beforeAll(async () => {
  const r = await probe(["--json"]);
  expect(r.stderr).toBe("");
  expect(r.code).toBe(0);
  expectNoContent(r.stdout);
  rep = JSON.parse(r.stdout) as ProbeReport;
});

describe("pcs probe against the harness", () => {
  it("reaches every endpoint and every schema passes", () => {
    expect(rep.endpoints.length).toBe(11);
    for (const e of rep.endpoints) {
      expect(e, e.name).toMatchObject({ reachable: true, schema: "pass", schemaIssues: [] });
    }
    expect(rep.account.chair).toBe(true);
  });

  it("counts what the smoke seed created", () => {
    expect(rep.papers?.all).toBeGreaterThanOrEqual(1);
    expect(rep.pc?.size).toBeGreaterThanOrEqual(1);
    expect(rep.reviews?.total).toBeGreaterThanOrEqual(2);
    expect(rep.reviews?.modifiedAt.present).toBeGreaterThanOrEqual(2);
    expect(rep.comments?.total).toBeGreaterThanOrEqual(1);
    expect(rep.assignments?.byAction.map(([a]) => a)).toContain("metareview");
    expect(rep.history.sampled).toBe(true);
  });

  it("finds the default review form and its scales", () => {
    const merit = rep.form.find((f) => f.uid === "OveMer");
    expect(merit?.labels).toHaveLength(5);
    expect(merit?.observed?.numeric).toBeGreaterThanOrEqual(2);
    expect(merit?.settingsId).toBe("s01");
    expect(rep.rateLimit.headers).toContain("x-ratelimit-remaining");
  });

  it("text and markdown reports are green and content-free", async () => {
    for (const fmt of [[], ["--markdown"]]) {
      const r = await probe(fmt);
      expect(r.code).toBe(0);
      expectNoContent(r.stdout + r.stderr);
      expect(r.stdout).toContain("PCS_FIELD_MERIT=OveMer");
    }
  });

  it("works as the `pcs probe` CLI", () => {
    const r = spawnSync(process.execPath, ["--import", "tsx", CLI, "probe"], {
      env: { PATH: process.env.PATH ?? "", ...probeEnv() },
      encoding: "utf8",
    });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Endpoints reachable: 11\/11/);
    expectNoContent(r.stdout);
  });
});

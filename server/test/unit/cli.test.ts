import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BASE_ENV } from "./env.js";

const CLI = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));

/** Run `pcs` in a subprocess with exactly `env` (plus PATH). No network. */
function pcs(args: string[], env: Record<string, string>) {
  const r = spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], {
    env: { PATH: process.env.PATH ?? "", ...env },
    encoding: "utf8",
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe("pcs CLI", { timeout: 60_000 }, () => {
  it("config-check prints a redacted summary", () => {
    const r = pcs(["config-check"], BASE_ENV);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^Configuration OK/);
    expect(r.stdout).toContain("HotCRP URL        http://127.0.0.1:8080");
    expect(r.stdout).not.toContain(BASE_ENV.PCS_HOTCRP_TOKEN);
  });

  it("config-check prints every problem once and exits 1", () => {
    const { PCS_HOTCRP_TOKEN: _omit, ...env } = BASE_ENV;
    const r = pcs(["config-check"], { ...env, PCS_PORT: "abc", PCS_PHASE_REVIEW_DUE: "nope" });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/^Invalid configuration \(3 problems\):\n/);
    expect(r.stderr).toContain("  PCS_HOTCRP_TOKEN: required");
    expect(r.stderr).toContain('  PCS_PHASE_REVIEW_DUE: expected an ISO date-time like 2027-01-15T23:59 (local to PCS_TZ), got "nope"');
    expect(r.stderr).toContain('  PCS_PORT: expected an integer from 1 to 65535, got "abc"');
    expect(r.stderr).not.toMatch(/at .*\.ts:\d+/); // no stack trace
  });

  it("rejects unknown commands with usage", () => {
    const r = pcs(["frobnicate"], {});
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/unknown command "frobnicate"[\s\S]*config-check/);
  });
});

// `pcs import` in a subprocess against a temp encrypted DB (PLAN M9). No network.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listRuns, runRows } from "../../src/imports/store.js";
import { openDb } from "../../src/store/db.js";
import { BASE_ENV } from "./env.js";

const CLI = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
const FIX = fileURLToPath(new URL("../../../seed/fixtures/imports/", import.meta.url));

function pcs(args: string[], env: Record<string, string>) {
  const r = spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], {
    env: { PATH: process.env.PATH ?? "", ...env },
    encoding: "utf8",
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

let dir: string;
let env: Record<string, string>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pcs-import-"));
  env = { ...BASE_ENV, PCS_DB_PATH: join(dir, "pcs.db"), PCS_DB_KEY: "cli-import-key", PCS_NOW: "2030-01-25T09:00" };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// Each test spawns several tsx subprocesses (~1 s each, more under a parallel run).
describe("pcs import", { timeout: 60_000 }, () => {
  it("imports a fixture, then --list shows counts and no content", () => {
    const r = pcs(["import", "invites", join(FIX, "invites.csv")], env);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^import #1 invites: 5 row\(s\); vs previous \+5 -0 ~0 \(sha256 [0-9a-f]{12}\)\n/);
    expect(r.stdout).toContain("ignored 1 unrecognized column(s)");

    const r2 = pcs(["import", "invites", join(FIX, "invites.v2.csv")], { ...env, PCS_NOW: "2030-01-28T09:00" });
    expect(r2.code).toBe(0);
    expect(r2.stdout).toMatch(/^import #2 invites: 5 row\(s\); vs previous \+1 -1 ~1 /);
    pcs(["import", "do-not-invite", join(FIX, "do-not-invite.csv")], env);

    const list = pcs(["import", "--list"], env);
    expect(list.code).toBe(0);
    const lines = list.stdout.trim().split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[1]).toMatch(/^ {2}1 {2}invites +2030-01-25T09:00:00-05:00 +5 {2}\+5 -0 ~0 /);
    expect(lines[2]).toMatch(/^ {2}3 {2}do-not-invite +2030-01-25T09:00:00-05:00 +3 /);
    expect(lines[3]).toMatch(/^ {2}2 {2}invites +2030-01-28T09:00:00-05:00 +5 {2}\+1 -1 ~1 /);
    for (const secret of ["example.org", "mallory", "rosa", "no-show", "PhD"]) expect(list.stdout).not.toContain(secret);

    const only = pcs(["import", "--list", "do-not-invite"], env);
    expect(only.stdout.trim().split("\n")).toHaveLength(2);

    // The rows are really in the encrypted DB.
    const db = openDb(env.PCS_DB_PATH!, { key: env.PCS_DB_KEY, readonly: true });
    try {
      expect(listRuns(db).map((x) => x.kind)).toEqual(["invites", "do-not-invite", "invites"]);
      expect(runRows(db, "do-not-invite", 3).map((x) => x.email)).toEqual([
        "mallory.stone@example.org",
        "victor.ash@example.org",
        "peggy.lark@example.org",
      ]);
    } finally {
      db.close();
    }
  });

  it("a malformed file prints a row-level report, exits 1, and imports nothing", () => {
    const r = pcs(["import", "invites", join(FIX, "invites.malformed.csv")], env);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/^pcs import: invites\.malformed\.csv has 8 problems; nothing was imported\n/);
    expect(r.stderr).toContain("  line 3, column pid: not an integer\n");
    expect(r.stderr).toContain("  line 7: 6 fields but the header has 5\n");
    expect(r.stderr).not.toContain("not-an-email");
    expect(pcs(["import", "--list"], env).stdout).toBe("no imports yet\n");
  });

  it("--help lists every kind and its columns", () => {
    const r = pcs(["import", "--help"], {});
    expect(r.code).toBe(0);
    for (const k of ["invites:", "tpms-assignments:", "tpms-registrations:", "refcheck:", "do-not-invite:"]) {
      expect(r.stdout).toContain(k);
    }
    expect(r.stdout).toContain("candidate_email *");
  });

  it("rejects bad usage, unknown kinds, and unreadable files", () => {
    expect(pcs(["import"], env).code).toBe(2);
    expect(pcs(["import", "invites"], env).code).toBe(2);
    expect(pcs(["import", "bogus", join(FIX, "invites.csv")], env).stderr).toMatch(/unknown kind "bogus"/);
    expect(pcs(["import", "--list", "bogus"], env).code).toBe(2);
    const missing = pcs(["import", "refcheck", join(dir, "nope.csv")], env);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toMatch(/cannot read .*nope\.csv: ENOENT/);
  });

  it("TPMS kinds: --map, header-less files, scores, and diffed registrations in --list", () => {
    const map = ["--map", "paper=Submission #,email=Assigned Reviewer,score=Match Quality,round=Phase"];
    const bad = pcs(["import", "tpms-assignments", join(FIX, "tpms-assignments.mapped.csv"), "--map", "paper=Nope,email=Assigned Reviewer"], env);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain('line 1, column pid: --map: no header cell is named "Nope"');
    const a = pcs(["import", "tpms-assignments", join(FIX, "tpms-assignments.mapped.csv"), ...map], env);
    expect(a.stderr).toBe("");
    expect(a.stdout).toMatch(/^import #1 tpms-assignments: 3 row\(s\); vs previous \+3 -0 ~0 /);
    expect(a.stdout).toContain("ignored 1 unrecognized column(s)");
    const l = pcs(["import", "affinity-local", join(FIX, "affinity-local.csv")], env);
    expect(l.stdout).toContain("note: no header row; columns read by position");
    const s = pcs(["import", "tpms-scores", join(FIX, "tpms-scores.csv"), "--no-header"], env);
    expect(s.code).toBe(1); // the header row read as data
    expect(pcs(["import", "tpms-registrations", join(FIX, "tpms-registrations.csv")], env).code).toBe(0);
    const r2 = pcs(["import", "tpms-registrations", join(FIX, "tpms-registrations.list.csv")], { ...env, PCS_NOW: "2030-01-26T09:00" });
    expect(r2.stdout).toMatch(/^import #4 tpms-registrations: 3 row\(s\); vs previous \+1 -2 ~2 /);
    const list = pcs(["import", "--list", "tpms-registrations"], env).stdout.trim().split("\n");
    expect(list[2]).toMatch(/^ {2}4 {2}tpms-registrations +2030-01-26T09:00:00-05:00 +3 {2}\+1 -2 ~2 /);
    expect(pcs(["import", "tpms-scores", join(FIX, "tpms-scores.csv"), "--bogus"], env).code).toBe(2);
  });

  it("reports a wrong DB key without the key", () => {
    openDb(env.PCS_DB_PATH!, { key: "the-real-key" }).close();
    const r = pcs(["import", "refcheck", join(FIX, "refcheck.csv")], env);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/wrong PCS_DB_KEY/);
    expect(r.stderr).not.toContain("cli-import-key");
  });
});

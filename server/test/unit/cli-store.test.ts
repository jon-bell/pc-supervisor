// `pcs wipe` / `pcs sync` argument handling, in a subprocess. No network:
// nothing here reaches a sync.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../../src/store/db.js";
import { BASE_ENV } from "./env.js";

const CLI = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));

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
  dir = mkdtempSync(join(tmpdir(), "pcs-cli-"));
  env = { ...BASE_ENV, PCS_DB_PATH: join(dir, "pcs.db"), PCS_DB_KEY: "cli-unit-key" };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("pcs wipe", { timeout: 60_000 }, () => {
  it("lists the files and refuses without --yes", () => {
    openDb(env.PCS_DB_PATH!, { key: env.PCS_DB_KEY }).close();
    const r = pcs(["wipe"], env);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(env.PCS_DB_PATH);
    expect(r.stderr).toContain("pcs wipe --yes");
    expect(existsSync(env.PCS_DB_PATH!)).toBe(true);
  });

  it("deletes with --yes", () => {
    openDb(env.PCS_DB_PATH!, { key: env.PCS_DB_KEY }).close();
    const r = pcs(["wipe", "--yes"], env);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`deleted ${env.PCS_DB_PATH}`);
    expect(existsSync(env.PCS_DB_PATH!)).toBe(false);
  });

  it("is a no-op when there is no DB", () => {
    const r = pcs(["wipe", "--yes"], env);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/nothing to delete/);
  });
});

describe("pcs sync / backfill", { timeout: 60_000 }, () => {
  it("reject unknown arguments", () => {
    expect(pcs(["sync", "--bogus"], env).code).toBe(2);
    expect(pcs(["backfill", "--limit"], env).code).toBe(2);
  });

  it("report a wrong DB key without a stack trace or the key", () => {
    openDb(env.PCS_DB_PATH!, { key: "the-real-key" }).close();
    const r = pcs(["sync"], env);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/wrong PCS_DB_KEY/);
    expect(r.stderr).not.toContain("cli-unit-key");
    expect(r.stderr).not.toContain("the-real-key");
    expect(r.stderr).not.toMatch(/at .*\.ts:\d+/);
  });
});

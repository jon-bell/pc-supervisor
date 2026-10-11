import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadDotEnv } from "../../src/env-file.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pcs-envfile-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(env: NodeJS.ProcessEnv) {
  const lines: string[] = [];
  const loaded = loadDotEnv(env, (l) => lines.push(l));
  return { loaded, lines };
}

describe("loadDotEnv", () => {
  it("loads INIT_CWD/.env when PCS_HOTCRP_URL is unset, and says so without values", () => {
    writeFileSync(join(dir, ".env"), "PCS_HOTCRP_URL=http://127.0.0.1:8080\nPCS_HOTCRP_TOKEN=hct_secretNotReal\nPCS_PORT=5317\n");
    const env: NodeJS.ProcessEnv = { INIT_CWD: dir, PCS_PORT: "6000" };
    const { loaded, lines } = run(env);
    expect(loaded).toBe(join(dir, ".env"));
    expect(env.PCS_HOTCRP_URL).toBe("http://127.0.0.1:8080");
    expect(env.PCS_HOTCRP_TOKEN).toBe("hct_secretNotReal");
    expect(env.PCS_PORT).toBe("6000"); // already set: the shell wins
    expect(lines).toEqual([`pcs: PCS_HOTCRP_URL is not set; loaded environment from ${join(dir, ".env")}`]);
    expect(lines.join("\n")).not.toContain("hct_secretNotReal");
  });

  it("does nothing when PCS_HOTCRP_URL is already set", () => {
    writeFileSync(join(dir, ".env"), "PCS_HOTCRP_TOKEN=hct_fromFile\n");
    const env: NodeJS.ProcessEnv = { INIT_CWD: dir, PCS_HOTCRP_URL: "http://127.0.0.1:8080" };
    expect(run(env)).toEqual({ loaded: undefined, lines: [] });
    expect(env.PCS_HOTCRP_TOKEN).toBeUndefined();
  });

  it("is silent when there is no .env", () => {
    const env: NodeJS.ProcessEnv = { INIT_CWD: dir };
    expect(run(env)).toEqual({ loaded: undefined, lines: [] });
    expect(env).toEqual({ INIT_CWD: dir });
  });
});

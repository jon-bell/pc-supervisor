// `pcs export tpms` on the local harness (spec §10.3): seed the `assignment`
// scenario (after a reset), sync it into a fresh store, build the TPMS
// bundle (store + GET /searchaction?action=get/pcconf), and run the CLI to
// check the files on disk (mode 0600) and its confidentiality notice.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixedClock } from "@pcs/server/clock";
import { loadConfig, type Config } from "@pcs/server/config";
import { clientFromConfig } from "@pcs/server/hotcrp/client";
import { tpmsExport, type TpmsBundle } from "@pcs/server/modules/tpms/index";
import { openStore, type Store } from "@pcs/server/store/store";
import { clientSource } from "@pcs/server/sync/source";
import { runSync } from "@pcs/server/sync/sync";
import { seedContextFromEnv, seedScenario } from "../../src/driver.js";
import { resolveWhen } from "../../src/time.js";
import { A, ASSIGNMENT_ENV, scenario } from "../../scenarios/assignment/scenario.js";

const CLI = fileURLToPath(new URL("../../../server/src/cli.ts", import.meta.url));
const sc = seedContextFromEnv();
const clock = fixedClock(resolveWhen(scenario.stages[0]!.now!, sc.ctx));
let dir: string;
let store: Store;
let cfg: Config;
let env: Record<string, string>;
let bundle: TpmsBundle;

beforeAll(async () => {
  await seedScenario(scenario, { reset: true });
  dir = mkdtempSync(join(tmpdir(), "pcs-tpms-int-"));
  env = { ...(process.env as Record<string, string>), ...ASSIGNMENT_ENV, PCS_DB_PATH: join(dir, "pcs.db"), PCS_DB_KEY: "tpms-integration-key" };
  cfg = loadConfig(env);
  store = openStore(cfg);
  const r = await runSync(store.db, clientSource(clientFromConfig(cfg.hotcrp)), {
    clock,
    chunkSize: cfg.sync.chunk,
    concurrency: cfg.sync.concurrency,
    tierTags: cfg.tierTags,
    acRole: cfg.acRole,
  });
  expect(r.ok, r.errors.join("; ")).toBe(true);
  bundle = await tpmsExport(store, cfg, clientFromConfig(cfg.hotcrp));
}, 180_000);

afterAll(() => {
  store?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const file = (n: string) => bundle.files.find((f) => f.name === n)?.content ?? "";
const emailsOf = (csv: string) => csv.trim().split("\n").slice(1).map((l) => l.split(",")[0]!);

describe("pcs export tpms against the assignment scenario", () => {
  it("conflicts.csv: the author conflicts of PC members, from get/pcconf", () => {
    const lines = file("conflicts.csv").trim().split("\n");
    expect(lines[0]).toBe("paper,title,given_name,family_name,email,conflicttype");
    // PC members who author a paper: s2 #1, s3 #2, s4 #6, s5 #7, s6 #8 (non-PC authors never appear).
    expect(lines.slice(1).map((l) => { const c = l.split(","); return `${c[0]} ${c[4]} ${c[5]}`; })).toEqual([
      `1 ${A.s2} Author`,
      `2 ${A.s3} Author`,
      `6 ${A.s4} Author`,
      `7 ${A.s5} Author`,
      `8 ${A.s6} Author`,
    ]);
  });

  it("pc.csv: every PC member; ACs and chairs are not assignable", () => {
    const rows = file("pc.csv").trim().split("\n").slice(1).map((l) => l.split(","));
    const byEmail = new Map(rows.map((r) => [r[0]!, r]));
    for (const k of ["s1", "s8", "j1", "r3"] as const) expect(byEmail.get(A[k])?.[4]).toBe("reviewer");
    expect([byEmail.get(A.ac1)?.[4], byEmail.get(A.ac2)?.[4]]).toEqual(["ac", "ac"]);
    expect(byEmail.has(A.a3)).toBe(false); // non-PC reserve-pool author
    expect(byEmail.get(A.j1)?.[3]).toBe("junior");
  });

  it("one load group per tier, with the ASSIGNMENT_ENV bands; the per-paper target", () => {
    expect(bundle.files.filter((f) => f.name.startsWith("load-")).map((f) => f.name)).toEqual(["load-senior.csv", "load-junior.csv", "load-reserve-active.csv"]);
    expect(emailsOf(file("load-senior.csv"))).toEqual([A.s1, A.s2, A.s3, A.s4, A.s5, A.s6, A.s7, A.s8].sort());
    expect(file("load-senior.csv").split("\n")[1]).toMatch(/,1,3$/);
    expect(emailsOf(file("load-junior.csv"))).toEqual([A.j1, A.j2, A.j3].sort());
    expect(file("load-reserve-active.csv").trim().split("\n").slice(1).every((l) => l.endsWith(",1,1"))).toBe(true);
    expect(file("reviews-per-paper.csv").split("\n")[1]).toBe("3,2,1,1,junior;reserve-active");
  });

  it("the CLI writes the files 0600 and says they contain emails; no review text anywhere", () => {
    const out = join(dir, "bundle");
    const r = spawnSync(process.execPath, ["--import", "tsx", CLI, "export", "tpms", out], { env, encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("CONFIDENTIAL: these files contain reviewer emails");
    expect(r.stdout).toContain("Download > Documents: Submissions");
    expect(readdirSync(out).sort()).toEqual(bundle.files.map((f) => f.name).sort());
    expect(statSync(out).mode & 0o777).toBe(0o700);
    for (const f of bundle.files) {
      expect(statSync(join(out, f.name)).mode & 0o777).toBe(0o600);
      expect(readFileSync(join(out, f.name), "utf8")).toBe(f.content);
    }
    const all = bundle.files.map((f) => f.content).join("\n");
    for (const rv of store.reviews()) for (const t of Object.values(store.reviewText(rv.rid))) if (t.length > 20) expect(all).not.toContain(t);
  }, 60_000);
});

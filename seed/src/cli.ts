// npm run seed -- <scenario> [--stage N] [--reset] [--force]
// npm run seed -- verify <scenario> [--stage N]
// npm run seed -- reset | status | list
//
// Harness only: refuses unless PCS_HOTCRP_URL is 127.0.0.1/localhost and the
// compose project (HOTCRP_COMPOSE_PROJECT) publishes that port. Needs the
// .env.test variables plus PCS_TZ and PCS_PHASE_* (e.g. the ci.yml values).

import { formatInZone } from "@pcs/server/tz";
import { resetHarness, seedContextFromEnv, seededState, seedScenario } from "./driver.js";
import { isScenarioName, loadScenario, SCENARIO_NAMES } from "./scenarios.js";
import { describeWhen, resolveWhen } from "./time.js";
import { verifyScenario } from "./verify.js";

const USAGE = `usage:
  npm run seed -- <${SCENARIO_NAMES.join("|")}> [--stage N] [--reset] [--force]
  npm run seed -- verify <scenario> [--stage N]
  npm run seed -- reset      empty the harness (keeps sysadmin accounts and tokens)
  npm run seed -- status     which scenario/stage the harness holds
  npm run seed -- list       scenarios, stages, and their PCS_NOW
`;

interface Args {
  cmd: string;
  scenario?: string;
  stage?: number;
  reset: boolean;
  force: boolean;
}

function parseArgs(argv: string[]): Args | string {
  const pos: string[] = [];
  const a: Args = { cmd: "", reset: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i]!;
    if (x === "--reset") a.reset = true;
    else if (x === "--force") a.force = true;
    else if (x === "--stage") {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1) return "--stage needs a positive integer";
      a.stage = n;
    } else if (x.startsWith("--")) return `unknown option ${x}`;
    else pos.push(x);
  }
  a.cmd = pos[0] ?? "";
  if (a.cmd === "verify") a.scenario = pos[1];
  else if (isScenarioName(a.cmd)) {
    a.scenario = a.cmd;
    a.cmd = "seed";
  }
  return a;
}

const log = (s: string) => process.stderr.write(`${s}\n`);

async function main(argv: string[]): Promise<number> {
  const a = parseArgs(argv);
  if (typeof a === "string") {
    process.stderr.write(`seed: ${a}\n${USAGE}`);
    return 2;
  }
  switch (a.cmd) {
    case "seed": {
      const scenario = await loadScenario(a.scenario as never);
      await seedScenario(scenario, { stage: a.stage, reset: a.reset, force: a.force, log });
      const sc = seedContextFromEnv();
      const stage = scenario.stages[(a.stage ?? scenario.stages.length) - 1]!;
      if (stage.now) log(`seed: observe this state at PCS_NOW=${formatInZone(resolveWhen(stage.now, sc.ctx), sc.ctx.tz).slice(0, 16)} (${describeWhen(stage.now)})`);
      return 0;
    }
    case "verify": {
      if (!a.scenario || !isScenarioName(a.scenario)) break;
      const scenario = await loadScenario(a.scenario);
      const sc = seedContextFromEnv();
      const t0 = performance.now();
      const { problems, checks } = await verifyScenario(scenario, sc.ctx, a.stage ?? scenario.stages.length);
      const secs = ((performance.now() - t0) / 1000).toFixed(1);
      for (const p of problems.slice(0, 50)) log(`  FAIL ${p}`);
      if (problems.length > 50) log(`  ... and ${problems.length - 50} more`);
      log(`verify ${scenario.name}: ${checks - problems.length}/${checks} checks passed (${secs} s)`);
      return problems.length === 0 ? 0 : 1;
    }
    case "reset":
      await resetHarness(seedContextFromEnv(process.env, log));
      return 0;
    case "status": {
      const m = await seededState(seedContextFromEnv());
      process.stdout.write(m ? `${m.scenario} stage ${m.stage}\n` : "(not seeded by pcs seed)\n");
      return 0;
    }
    case "list": {
      const sc = seedContextFromEnv();
      for (const name of SCENARIO_NAMES) {
        const s = await loadScenario(name);
        process.stdout.write(`${name}: ${s.description}\n`);
        s.stages.forEach((st, i) => {
          const now = st.now ? formatInZone(resolveWhen(st.now, sc.ctx), sc.ctx.tz).slice(0, 16) : "(unset)";
          process.stdout.write(`  stage ${i + 1} (${st.name}): ${st.events.length} events, PCS_NOW=${now}\n`);
        });
      }
      return 0;
    }
  }
  process.stderr.write(USAGE);
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    // Known failures (NotHarnessError, ConfigError, DockerError, ScenarioError, ...) carry readable messages.
    process.stderr.write(`seed: ${(e instanceof Error ? e.message : String(e)).replace(/^seed: /, "")}\n`);
    process.exitCode = 1;
  },
);

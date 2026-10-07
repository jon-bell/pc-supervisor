// `npm run seed -- <scenario>`. PLAN M2 implements the driver and the
// golden / shadow / scale scenarios (spec §9.3). The harness guard below is
// real: the seeder writes, so it must only ever target the local harness.

import { assertHarnessUrl, NotHarnessError } from "@pcs/server/hotcrp/harness-guard";

export const SCENARIOS = ["golden", "shadow", "scale"] as const;

function main(argv: string[]): number {
  const scenario = argv[0];
  if (scenario === undefined || !(SCENARIOS as readonly string[]).includes(scenario)) {
    process.stderr.write(`usage: npm run seed -- <${SCENARIOS.join("|")}>\n`);
    return 2;
  }
  try {
    assertHarnessUrl();
  } catch (e) {
    if (e instanceof NotHarnessError) {
      process.stderr.write(`seed: ${e.message}\n`);
      return 1;
    }
    throw e;
  }
  process.stdout.write(`seed: scenario "${scenario}" is not implemented yet (PLAN M2); nothing was seeded.\n`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));

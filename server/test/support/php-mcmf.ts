// Run HotCRP's own MinCostMaxFlow (PHP, inside the harness container) on a
// batch of instances, via seed/php/mcmf-driver.php. Harness only: the compose
// project must be the one PCS_HOTCRP_URL points at.

import { readFileSync } from "node:fs";
import { z } from "zod";
import { Harness, checkHarnessMatchesUrl, dockerOptionsFromEnv } from "@pcs/seed/docker";
import { assertHarnessUrl } from "../../src/hotcrp/harness-guard.js";
import type { Instance } from "./mcmf-instances.js";

const DRIVER = new URL("../../../seed/php/mcmf-driver.php", import.meta.url);
const DRIVER_IN_CONTAINER = "/tmp/pcs-seed/mcmf-driver.php";

const PhpResult = z.object({
  status: z.enum(["ok", "infeasible", "error", "hung"]),
  maxflow: z.number().int(),
  cost: z.number().int(),
  flows: z.array(z.number().int()),
  conserving: z.boolean(),
  bounded: z.boolean(),
  precision_limited: z.boolean(),
  message: z.string().optional(),
});
export type PhpResult = z.infer<typeof PhpResult>;

export async function phpMcmfRunner(): Promise<(instances: readonly Instance[]) => Promise<PhpResult[]>> {
  const url = assertHarnessUrl();
  const h = new Harness(dockerOptionsFromEnv());
  await checkHarnessMatchesUrl(h, url);
  await h.writeFile(DRIVER_IN_CONTAINER, readFileSync(DRIVER, "utf8"));
  return async (instances) => {
    const input = JSON.stringify({ max_progress: 10, instances: instances.map((i) => ({ n: i.n, edges: i.edges })) });
    const out = await h.sh(`php -d zend.assertions=1 -d assert.exception=1 ${DRIVER_IN_CONTAINER}`, input);
    const lines = out.split("\n").filter((l) => l.trim() !== "");
    if (lines.length !== instances.length) throw new Error(`mcmf-driver: ${lines.length} results for ${instances.length} instances:\n${out.slice(-2000)}`);
    return lines.map((l) => PhpResult.parse(JSON.parse(l)));
  };
}

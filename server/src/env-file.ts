// Loads a .env file into process.env, for the `pcs` CLI only (cli.ts).
//
// Only when PCS_HOTCRP_URL is unset: a shell, CI job, or test that sets it
// keeps full control of the environment, and none of the .env values leak in.
// Variables already set always win over the file. The file is resolved against
// the directory npm was invoked from (INIT_CWD), since `npm run pcs` runs in
// the server/ workspace.
// Prints the path it loads, never any values.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";

export function loadDotEnv(
  env: NodeJS.ProcessEnv = process.env,
  log: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): string | undefined {
  if (env.PCS_HOTCRP_URL) return undefined;
  const path = join(env.INIT_CWD || process.cwd(), ".env");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  for (const [k, v] of Object.entries(parseEnv(text))) env[k] ??= v;
  log(`pcs: PCS_HOTCRP_URL is not set; loaded environment from ${path}`);
  return path;
}

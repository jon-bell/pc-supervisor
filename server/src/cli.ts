#!/usr/bin/env node
// `pcs` entry point (bin: server/bin/pcs.js). Commands live in cli/main.ts,
// imported only after the Node check so no native module loads first.
import { loadDotEnv } from "./env-file.js";
import { nodeProblem } from "./node-check.js";

const problem = nodeProblem();
if (problem) {
  process.stderr.write(`${problem}\n`);
  process.exit(1);
}
loadDotEnv();
const { main } = await import("./cli/main.js");
process.exitCode = await main(process.argv.slice(2));

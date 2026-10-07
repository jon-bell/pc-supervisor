#!/usr/bin/env node
// `pcs` entry point (bin: server/bin/pcs.js). Commands live in cli/main.ts.
import { main } from "./cli/main.js";

process.exitCode = await main(process.argv.slice(2));

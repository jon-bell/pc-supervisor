#!/usr/bin/env node
// `pcs` entry point. Runs the compiled CLI (`npm run build`) when present;
// otherwise runs the TypeScript source through tsx (dev checkouts).
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const dist = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
if (existsSync(dist)) {
  await import(pathToFileURL(dist).href);
} else {
  const { tsImport } = await import("tsx/esm/api");
  await tsImport("../src/cli.ts", import.meta.url);
}

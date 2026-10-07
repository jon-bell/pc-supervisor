#!/usr/bin/env node
// `npm run dev`: the API (`pcs serve` on 127.0.0.1:PCS_PORT) plus the Vite dev
// server (127.0.0.1:5173, hot reload, /api proxied to PCS_PORT). Open
// http://127.0.0.1:5173/. Needs the usual PCS_* env and a synced store
// (`npm run pcs -- sync`). Ctrl-C stops both.
import { spawn } from "node:child_process";

const procs = [
  ["api", ["run", "pcs", "--", "serve"]],
  ["web", ["run", "dev", "-w", "@pcs/web"]],
].map(([name, args]) => {
  // PCS_DEV: the API accepts tag changes from the Vite origin (routes/actions.ts).
  const p = spawn("npm", args, { stdio: "inherit", env: { ...process.env, PCS_DEV: "true" } });
  p.on("exit", (code) => {
    process.stderr.write(`dev: ${name} exited (${code ?? "signal"}); stopping\n`);
    stop(code ?? 1);
  });
  return p;
});

let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const p of procs) if (p.exitCode === null) p.kill("SIGTERM");
  process.exitCode = code;
}
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

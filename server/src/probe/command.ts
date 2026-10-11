// `pcs probe` (PLAN M0): a read-only shape report of a HotCRP instance.
//
// This is the one command the chair may run by hand against the real
// instance (AGENTS.md rule 2), so it deliberately does NOT call
// assertHarnessUrl. It is GET-only (readonly.ts) and prints no content
// (safe.ts, report.ts).

import { ConfigError, loadHotcrpConfig } from "../config.js";
import { clientFromConfig } from "../hotcrp/client.js";
import { collect } from "./collect.js";
import { newRateLimitObservation, ProbeReader, readOnlyFetch } from "./readonly.js";
import { failingEndpoints, renderJson, renderMarkdown, renderText, type ProbeReport } from "./report.js";

type Env = Readonly<Record<string, string | undefined>>;

export const PROBE_USAGE = `Usage: pcs probe [--json | --markdown]

Calls every HotCRP endpoint the sync uses (GET only) and prints a shape
report: keys and types, counts, review-form fields and score ranges, user-tag
names, schema pass/fail, and rate-limit headers. It prints no titles, names,
emails, or text. Needs only PCS_HOTCRP_URL and PCS_HOTCRP_TOKEN.

  --json       machine-readable report
  --markdown   report formatted for pasting into an issue
`;

export interface ProbeIo {
  env?: Env;
  fetch?: typeof globalThis.fetch;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
}

/** Run the probe with an injectable fetch (tests). Returns the report. */
export async function probe(env: Env, fetchImpl: typeof globalThis.fetch = globalThis.fetch): Promise<ProbeReport> {
  const cfg = loadHotcrpConfig(env);
  const rateLimit = newRateLimitObservation();
  const client = clientFromConfig(cfg, { fetch: readOnlyFetch(fetchImpl, rateLimit), maxRetries: 3 });
  return collect(new ProbeReader(client), { rateLimit });
}

export async function runProbe(args: string[], io: ProbeIo = {}): Promise<number> {
  const out = io.stdout ?? ((s: string) => void process.stdout.write(s));
  const err = io.stderr ?? ((s: string) => void process.stderr.write(s));
  let format: "text" | "json" | "markdown" = "text";
  for (const a of args) {
    if (a === "--json") format = "json";
    else if (a === "--markdown" || a === "--md") format = "markdown";
    else if (a === "--help" || a === "-h") {
      out(PROBE_USAGE);
      return 0;
    } else {
      err(`pcs probe: unknown argument ${JSON.stringify(a.slice(0, 40))}\n\n${PROBE_USAGE}`);
      return 2;
    }
  }

  let report: ProbeReport;
  try {
    report = await probe(io.env ?? process.env, io.fetch);
  } catch (e) {
    if (e instanceof ConfigError) {
      err(`${e.message}\n`);
      return 1;
    }
    throw e;
  }

  out(format === "json" ? renderJson(report) : format === "markdown" ? renderMarkdown(report) : renderText(report));
  const bad = failingEndpoints(report);
  if (bad.length > 0) {
    err(`pcs probe: ${bad.length} of ${report.endpoints.length} endpoints failed: ${bad.map((e) => e.name).join(", ")}\n`);
    return 1;
  }
  return 0;
}

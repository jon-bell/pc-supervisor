// Shared helper for contract/integration tests: a client for the local
// harness. Re-checks the guard so a test file can never run against a real
// instance, even if imported outside the configured global setup: the URL is
// checked now, and before its first request the client also checks that it
// is the disposable harness (harness-verify.ts: compose port and chair email).
import { loadHotcrpConfig } from "../../src/config.js";
import { clientFromConfig, type HotcrpClient } from "../../src/hotcrp/client.js";
import { assertHarnessUrl } from "../../src/hotcrp/harness-guard.js";
import { verifiedFetch } from "../../src/hotcrp/harness-verify.js";

export function harnessClient(): HotcrpClient {
  assertHarnessUrl();
  return clientFromConfig(loadHotcrpConfig(process.env), { fetch: verifiedFetch() });
}

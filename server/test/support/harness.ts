// Shared helper for contract/integration tests: a client for the local
// harness. Re-checks the guard so a test file can never run against a real
// instance, even if imported outside the configured global setup.
import { loadHotcrpConfig } from "../../src/config.js";
import { clientFromConfig, type HotcrpClient } from "../../src/hotcrp/client.js";
import { assertHarnessUrl } from "../../src/hotcrp/harness-guard.js";

export function harnessClient(): HotcrpClient {
  assertHarnessUrl();
  return clientFromConfig(loadHotcrpConfig(process.env));
}


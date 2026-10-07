// Runs once before any spec. Refuses to start unless PCS_HOTCRP_URL is the
// local harness (AGENTS.md rule 2): M5+ specs seed and sync against it.
import { assertHarnessUrl } from "@pcs/server/hotcrp/harness-guard";

export default function globalSetup(): void {
  assertHarnessUrl();
}

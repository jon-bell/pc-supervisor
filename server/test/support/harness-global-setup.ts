import { verifyHarness } from "../../src/hotcrp/harness-verify.js";

// Before any contract/integration test: PCS_HOTCRP_URL is local, and it is the
// disposable harness (its compose project publishes that port; the token is
// the harness chair's). See harness-verify.ts.
export default async function setup(): Promise<void> {
  await verifyHarness();
}

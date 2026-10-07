import { assertHarnessUrl } from "../../src/hotcrp/harness-guard.js";

export default function setup(): void {
  assertHarnessUrl();
  if (!process.env.PCS_HOTCRP_TOKEN) {
    throw new Error("PCS_HOTCRP_TOKEN is not set; load .env.test: set -a; . ./.env.test; set +a");
  }
}

// Runs once before any spec (after the webServer is up: Playwright starts
// webServers first). Refuses unless PCS_HOTCRP_URL is the local harness
// (AGENTS.md rule 2) and checks the server is serving the pinned golden state.
import { assertHarnessUrl } from "@pcs/server/hotcrp/harness-guard";
import type { MetaResponse, SyncStatus } from "@pcs/server/server/api-types";
import { E2E_PORT } from "./env.js";

export default async function globalSetup(): Promise<void> {
  const url = assertHarnessUrl();
  if (process.env.ARGOS_TOKEN && !process.env.CI) throw new Error("ARGOS_TOKEN is set outside CI; refusing to upload screenshots");
  const base = `http://127.0.0.1:${E2E_PORT}`;
  const meta = (await (await fetch(`${base}/api/meta`)).json()) as MetaResponse;
  if (!meta.pinned) throw new Error("e2e server clock is not pinned (PCS_NOW)");
  if (meta.hotcrpUrl !== url.replace(/\/+$/, "")) throw new Error(`e2e server talks to ${meta.hotcrpUrl}, not ${url}`);
  const sync = (await (await fetch(`${base}/api/sync/status`)).json()) as SyncStatus;
  if (!sync.lastSuccessful || sync.lastSuccessful.nowUsed !== meta.now) throw new Error("e2e server has no sync at the pinned PCS_NOW");
}

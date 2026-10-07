// Direct HotCRP API access for specs that check what HotCRP itself holds
// (PLAN M8: the dry run changes nothing, the confirmed run sets the tags).
// Harness only: assertHarnessUrl() runs before a client exists.
import { loadHotcrpConfig } from "@pcs/server/config";
import { clientFromConfig, type HotcrpClient } from "@pcs/server/hotcrp/client";
import { assertHarnessUrl } from "@pcs/server/hotcrp/harness-guard";

export function harnessClient(): HotcrpClient {
  assertHarnessUrl();
  return clientFromConfig(loadHotcrpConfig(process.env));
}

/** Pids holding `tag` in HotCRP, from /search's tags field. */
export async function pidsWithTag(client: HotcrpClient, tag: string): Promise<number[]> {
  const res = await client.search({ t: "all", fields: ["tags"] });
  const has = (v: unknown) =>
    String(v ?? "")
      .split(/\s+/)
      .some((t) => t.replace(/^#/, "").replace(/#.*$/, "").toLowerCase() === tag.toLowerCase());
  return (res.papers ?? []).filter((p) => has((p as Record<string, unknown>).tags)).map((p) => p.pid).sort((a, b) => a - b);
}

/** Pids a HotCRP search matches (to check a copied search means what it says). */
export async function searchPids(client: HotcrpClient, q: string): Promise<number[]> {
  return (await client.search({ q, t: "all" })).ids.slice().sort((a, b) => a - b);
}

// Copyable HotCRP searches (PLAN M8, spec §6). Pure and dependency-free: the
// web app imports it too (@pcs/server/actions/search).
//
// HotCRP reads a search of bare paper numbers and ranges as that set of
// papers: "2-4 9 11-12" matches 2, 3, 4, 9, 11, 12 (checked on the harness;
// "#4 #5" and "4,5" mean the same). Consecutive pids collapse into ranges so
// a long list stays short enough for a URL and for the Mail tool's search box.

/** "2-4 9 11-12" for pids [9, 2, 3, 4, 12, 11]; "" for none. */
export function hotcrpPidSearch(pids: Iterable<number>): string {
  const sorted = [...new Set(pids)].filter((p) => Number.isInteger(p) && p > 0).sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
    // Two consecutive pids read better as "4 5" than "4-5".
    if (j === i) parts.push(String(sorted[i]));
    else if (j === i + 1) parts.push(String(sorted[i]), String(sorted[j]));
    else parts.push(`${sorted[i]}-${sorted[j]}`);
    i = j + 1;
  }
  return parts.join(" ");
}

/** `${base}/search?q=…` (all papers, so withdrawn ones in the set still show). */
export function hotcrpSearchUrl(base: string, q: string): string {
  return `${base.replace(/\/+$/, "")}/search?${new URLSearchParams({ q, t: "all" }).toString()}`;
}

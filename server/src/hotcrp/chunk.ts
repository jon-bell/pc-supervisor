// pid-range chunking (spec §4): reviews and comments are fetched in chunks of
// PCS_SYNC_CHUNK papers, each expressed as a HotCRP range search "first-last".

export interface PidChunk {
  /** HotCRP search, e.g. "1-200". */
  q: string;
  pids: number[];
}

/**
 * Split pids into chunks of at most `size` pids (sorted, de-duplicated). Each
 * chunk's range covers only its own pids plus any pids missing from the input
 * that fall between them, so chunks never overlap.
 */
export function pidChunks(pids: Iterable<number>, size: number): PidChunk[] {
  if (!Number.isInteger(size) || size < 1) throw new RangeError(`pidChunks: size must be a positive integer, got ${size}`);
  const sorted = [...new Set(pids)].sort((a, b) => a - b);
  for (const p of sorted) {
    if (!Number.isInteger(p) || p < 1) throw new RangeError(`pidChunks: invalid pid ${p}`);
  }
  const out: PidChunk[] = [];
  for (let i = 0; i < sorted.length; i += size) {
    const part = sorted.slice(i, i + size);
    const first = part[0]!;
    const last = part[part.length - 1]!;
    out.push({ q: first === last ? String(first) : `${first}-${last}`, pids: part });
  }
  return out;
}

/**
 * Like pidChunks, but each chunk's search names exactly its pids ("3 7-9 40"),
 * so a sparse pid set never pulls in the papers between them. HotCRP reads a
 * space-separated list of numbers and ranges as those papers.
 */
export function pidListChunks(pids: Iterable<number>, size: number): PidChunk[] {
  return pidChunks(pids, size).map((c) => {
    const parts: string[] = [];
    for (let i = 0; i < c.pids.length; ) {
      let j = i;
      while (j + 1 < c.pids.length && c.pids[j + 1] === c.pids[j]! + 1) j++;
      parts.push(i === j ? String(c.pids[i]) : `${c.pids[i]}-${c.pids[j]}`);
      i = j + 1;
    }
    return { q: parts.join(" "), pids: c.pids };
  });
}

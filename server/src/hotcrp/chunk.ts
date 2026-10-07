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

// Header sync status: when the last sync finished, whether it worked, and a
// "Sync now" button (POST /api/sync; the server refuses concurrent runs).

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, type ReactNode } from "react";
import { useSyncNow, useSyncStatus } from "../api";
import { formatTime } from "../format";
import { Volatile } from "./Time";

export function SyncIndicator({ tz }: { tz: string }) {
  const status = useSyncStatus();
  const syncNow = useSyncNow();
  const qc = useQueryClient();
  const s = status.data;
  const running = s?.running || syncNow.isPending;

  // When a run finishes, refetch everything that depends on the store.
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && s && !s.running) void qc.invalidateQueries();
    wasRunning.current = !!s?.running;
  }, [s, qc]);

  let label: ReactNode = "Never synced";
  let tone = "sync-none";
  if (s?.lastSuccessful) {
    tone = s.last && s.last.ok === false ? "sync-failed" : "sync-ok";
    label = (
      <>
        Synced <Volatile testId="sync-time">{formatTime(s.lastSuccessful.finishedAt ?? s.lastSuccessful.startedAt, tz)}</Volatile>
      </>
    );
  }
  const problem = s?.lastError ?? (s?.last && s.last.ok === false ? (s.last.errors.at(-1) ?? "last sync failed") : null);

  return (
    <div className={`sync ${tone}`} data-testid="sync-status" data-running={running ? "true" : "false"}>
      <span className="sync-dot" aria-hidden="true" />
      <span className="sync-label">{running ? "Syncing…" : label}</span>
      {problem && !running ? (
        <span className="sync-error" title={problem}>
          last sync failed
        </span>
      ) : null}
      <button type="button" className="btn" data-testid="sync-now" disabled={running} onClick={() => syncNow.mutate()}>
        Sync now
      </button>
    </div>
  );
}

// Shared pieces of the phase-2 module views (PLAN M11): the module's phase
// window banner, notes, and drafted HotCRP Mail-tool searches.

import { useState } from "react";
import type { MailDraftInfo, ModuleStatusInfo } from "../api";
import { formatTime, PHASE_LABELS } from "../format";

const phaseLabel = (p: string) => PHASE_LABELS[p] ?? p;

/** "Active now" or not, the phases the module runs in, and their window under the configured dates. */
export function ModuleWindow({ module: m, tz }: { module: ModuleStatusInfo; tz: string }) {
  const w = m.window;
  return (
    <p className={`module-window ${m.active ? "module-active" : "module-inactive"}`} data-testid="module-window" data-active={m.active ? "1" : "0"}>
      <strong>Module {m.letter}</strong> · {m.active ? "active now" : "not active now"} (current phase: {phaseLabel(m.phase)}) · runs in{" "}
      {m.activeIn.map(phaseLabel).join(", ")}
      {" · "}
      {w ? (
        <span data-testid="module-window-span">
          {w.from === null ? "from the start" : `after ${formatTime(w.from, tz)}`} until {w.to === null ? "open-ended" : formatTime(w.to, tz)}
        </span>
      ) : (
        <span className="muted">no window: none of these phases has a configured date</span>
      )}
    </p>
  );
}

export function Notes({ notes }: { notes: readonly string[] }) {
  if (notes.length === 0) return null;
  return (
    <ul className="notes muted" data-testid="module-notes">
      {notes.map((n) => (
        <li key={n}>{n}</li>
      ))}
    </ul>
  );
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => setDone(true));
      }}
    >
      {done ? "Copied" : "Copy"}
    </button>
  );
}

/** Drafted Mail-tool searches: paste into HotCRP > Mail and pick the recipients shown. Nothing is sent from here. */
export function MailDrafts({ drafts }: { drafts: readonly MailDraftInfo[] }) {
  if (drafts.length === 0) return <p className="muted">No mail drafts: nothing to follow up.</p>;
  return (
    <ul className="mail-drafts" data-testid="mail-drafts">
      {drafts.map((d) => (
        <li key={`${d.label}:${d.search}`} data-testid="mail-draft">
          <span>{d.label}</span> <span className="muted">({d.papers} papers; recipients: {d.recipients})</span>
          <code data-testid="mail-search">{d.search}</code>
          <CopyButton text={d.search} />
        </li>
      ))}
    </ul>
  );
}

// A comment's type chip (spec §5e) and the chair's relabel menu. The chip
// says the type, who labelled it (your label, the heuristic, the model) and
// the classifier's confidence; a low-confidence label is dashed and says
// "low confidence", so it never depends on colour. The menu sets your label
// in one click, or clears it (back to the classifier). Types describe
// comments, never people (spec §7).

import { useRef, useState } from "react";
import type { CommentDetail, CommentKindName, CommentType, CommentTypesMeta } from "../api";
import { useRelabel } from "../api";
import { Popover } from "./Popover";

export const KIND_LABEL: Readonly<Record<CommentKindName, string>> = {
  ping: "Ping",
  reply: "Reply",
  discussion: "Discussion",
  nonsubstantive: "Non-substantive",
};
const KIND_HINT: Readonly<Record<CommentKindName, string>> = {
  ping: "asks someone to respond or act",
  reply: "answers an earlier comment or review",
  discussion: "a substantive argument about the paper",
  nonsubstantive: "“agree”, “+1”, “thanks”, “fine with accept”",
};
const KINDS: readonly CommentKindName[] = ["ping", "reply", "discussion", "nonsubstantive"];
/** A glyph per type, so the chip reads without colour. */
const GLYPH: Readonly<Record<CommentKindName, string>> = { ping: "→", reply: "↩", discussion: "¶", nonsubstantive: "≈" };

const pct = (x: number) => `${Math.round(x * 100)}%`;

export function typeTitle(t: CommentType): string {
  const base = `${KIND_LABEL[t.kind]}: ${KIND_HINT[t.kind]}.`;
  if (t.source === "chair") {
    return `${base} Your label${t.classifier ? `; the ${t.classifier.source} said ${KIND_LABEL[t.classifier.kind].toLowerCase()} (${pct(t.classifier.confidence)})` : ""}.`;
  }
  return `${base} From the ${t.source}, ${pct(t.confidence)} confident${t.low ? " (low confidence)" : ""}. Click to relabel.`;
}

export function CommentTypeChip({ c, pid, disabled }: { c: CommentDetail; pid: number; disabled?: boolean }) {
  const t = c.type;
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const relabel = useRelabel(pid);
  const pick = (kind: CommentKindName | null) => {
    relabel.mutate({ cid: c.cid, kind }, { onSettled: () => setOpen(false) });
  };
  const cls = ["chip", "ctype", t ? `ctype-${t.kind}` : "ctype-none", t?.source === "chair" ? "ctype-chair" : "", t?.low ? "ctype-low" : ""].filter(Boolean).join(" ");
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className={cls}
        data-testid="comment-type"
        data-kind={t?.kind ?? ""}
        data-source={t?.source ?? ""}
        data-low={t?.low ? "true" : "false"}
        title={t ? typeTitle(t) : "Not classified yet. Click to label it."}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        {t ? (
          <>
            <span aria-hidden="true">{GLYPH[t.kind]}</span>
            {KIND_LABEL[t.kind]}
            <span className="ctype-src">
              {t.source === "chair" ? "· your label" : `· ${t.source} ${pct(t.confidence)}`}
              {t.low ? " · low confidence" : ""}
            </span>
          </>
        ) : (
          "unclassified"
        )}
        <span aria-hidden="true" className="ctype-caret">▾</span>
      </button>
      {open ? (
        <Popover anchor={anchor} onClose={() => setOpen(false)} label="Relabel this comment" testId="relabel-menu">
          <div className="fp ctype-menu">
            <div className="fp-title">This comment is a…</div>
            {KINDS.map((k) => {
              const current = t?.kind === k && t.source === "chair";
              return (
                <button
                  key={k}
                  type="button"
                  className={`ctype-option${t?.kind === k ? " ctype-option-on" : ""}`}
                  data-testid="relabel-option"
                  data-kind={k}
                  aria-pressed={t?.kind === k}
                  disabled={current || relabel.isPending}
                  onClick={() => pick(k)}
                >
                  <span aria-hidden="true">{GLYPH[k]}</span> <strong>{KIND_LABEL[k]}</strong> <span className="muted">{KIND_HINT[k]}</span>
                </button>
              );
            })}
            {t?.source === "chair" ? (
              <button type="button" className="btn btn-small" data-testid="relabel-clear" disabled={relabel.isPending} onClick={() => pick(null)}>
                Back to the classifier{t.classifier ? ` (${KIND_LABEL[t.classifier.kind].toLowerCase()})` : ""}
              </button>
            ) : null}
            {relabel.error ? <p className="error">{relabel.error.message}</p> : null}
            <p className="muted small">Your label stays in the local encrypted store and trains the local model. It is never sent anywhere.</p>
          </div>
        </Popover>
      ) : null}
    </>
  );
}

/** Which classifier labels comments, and how to get the local model when it is the heuristic. */
export function ClassifierNote({ meta }: { meta: CommentTypesMeta }) {
  if (meta.active === "off") return null;
  const hint = meta.active === "heuristic" ? (meta.fallback ?? "set PCS_COMMENT_CLASSIFIER=model and run `pcs model fetch` for the local model") : null;
  return (
    <span className="ctype-note" data-testid="classifier-note" data-active={meta.active} title={hint ?? "A local sentence-embedding model, run in-process with no network access."}>
      ({meta.active === "model" ? "local model" : "heuristic"}
      {hint ? (
        <>
          ; <code>pcs model fetch</code> for the model
        </>
      ) : null}
      )
    </span>
  );
}

/** "12 pings · 3 replies · …" for a breakdown, zero counts left out. */
export function kindBreakdown(counts: Partial<Record<CommentKindName, number>>): string {
  const plural: Record<CommentKindName, [string, string]> = {
    ping: ["ping", "pings"],
    reply: ["reply", "replies"],
    discussion: ["discussion", "discussion"],
    nonsubstantive: ["non-substantive", "non-substantive"],
  };
  return KINDS.filter((k) => (counts[k] ?? 0) > 0)
    .map((k) => `${counts[k]} ${plural[k][counts[k] === 1 ? 0 : 1]}`)
    .join(" · ");
}

// v1 actions (PLAN M8, spec §6), all human-in-the-loop:
// - SearchActions: a copyable HotCRP search for a set of papers (paste it
//   into HotCRP's search or Mail tool), plus a link that runs it in HotCRP.
// - CopyButton: copies text to the clipboard. Nothing is ever posted.
// - TagDialog: adds or removes PCS_ATTENTION_TAG. It always shows HotCRP's
//   dry run first and needs the tag name typed out before it writes; the
//   server enforces the same with a single-use preview token.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { hotcrpPidSearch, hotcrpSearchUrl } from "@pcs/server/actions/search";
import { useTagCommit, useTagPreview, type TagPaper } from "../api";
import { plural } from "../format";

export function CopyButton({ text, label, testId }: { text: string; label: string; testId?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 2000);
  };
  return (
    <button type="button" className="btn" data-testid={testId} data-state={state} onClick={() => void copy()} disabled={text === ""}>
      {state === "copied" ? "Copied" : state === "failed" ? "Copy failed; select the text" : label}
    </button>
  );
}

/** "HotCRP search: 2-4 9 [Copy search] [Search in HotCRP]" for a set of papers. */
export function SearchActions({ pids, base, children, lead }: { pids: readonly number[]; base: string; children?: ReactNode; lead?: ReactNode }) {
  const q = hotcrpPidSearch(pids);
  return (
    <div className="actions-bar" data-testid="search-actions">
      {lead}
      <span className="actions-group">
        <span className="muted">HotCRP search</span>
        <code className="search-q" data-testid="hotcrp-search" title={q}>
          {q || "(no papers)"}
        </code>
        <CopyButton text={q} label="Copy search" testId="copy-search" />
        {q ? (
          <a className="ext btn btn-ghost" href={hotcrpSearchUrl(base, q)} target="_blank" rel="noreferrer noopener" data-testid="hotcrp-search-link">
            search in HotCRP ↗
          </a>
        ) : null}
      </span>
      {children ? <span className="actions-group actions-tag">{children}</span> : null}
    </div>
  );
}

function PaperList({ papers, testId }: { papers: readonly TagPaper[]; testId: string }) {
  return (
    <ul className="tag-list" data-testid={testId}>
      {papers.map((p) => (
        <li key={p.pid} data-pid={p.pid}>
          <span className="pid">#{p.pid}</span> {p.title ?? <span className="muted">(not synced)</span>}
        </li>
      ))}
    </ul>
  );
}

/**
 * The tagging modal. Opens straight into HotCRP's dry run for `add`/`remove`;
 * the commit button stays disabled until the tag name is typed.
 */
export function TagDialog({ tag, add, remove, onClose }: { tag: string; add: readonly number[]; remove: readonly number[]; onClose: () => void }) {
  const preview = useTagPreview();
  const commit = useTagCommit();
  const [typed, setTyped] = useState("");
  const run = () => {
    commit.reset();
    setTyped("");
    preview.mutate({ add: [...add], remove: [...remove] });
  };
  // Run the dry run once on open.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    run();
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !commit.isPending) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, commit.isPending]);

  const p = preview.data;
  const done = commit.data;
  const confirmed = typed === tag;

  let body: ReactNode;
  if (preview.isPending || preview.isIdle) body = <p data-testid="tag-loading">Running a dry run in HotCRP…</p>;
  else if (preview.error) body = <p className="error" data-testid="tag-error">The dry run failed: {preview.error.message}</p>;
  else if (done) {
    body = (
      <p data-testid="tag-done">
        Done. HotCRP added #{tag} to {plural(done.gain.length, "paper")} and removed it from {plural(done.lose.length, "paper")}.{" "}
        {done.syncStarted ? "Syncing so the change shows here…" : "Press Sync now to see the change here."}
      </p>
    );
  } else if (p) {
    body = (
      <>
        <p className="muted">Dry run: HotCRP reports that confirming would make exactly these changes. Nothing has changed yet.</p>
        {p.gain.length ? (
          <>
            <h4>
              Add #{tag} to {plural(p.gain.length, "paper")}
            </h4>
            <PaperList papers={p.gain} testId="tag-gain" />
          </>
        ) : null}
        {p.lose.length ? (
          <>
            <h4>
              Remove #{tag} from {plural(p.lose.length, "paper")}
            </h4>
            <PaperList papers={p.lose} testId="tag-lose" />
          </>
        ) : null}
        {p.unchanged.length ? (
          <p className="muted" data-testid="tag-unchanged">
            Already as requested: {p.unchanged.map((x) => `#${x}`).join(" ")}
          </p>
        ) : null}
        {p.token === null ? (
          <p data-testid="tag-nothing">Nothing to change.</p>
        ) : (
          <label className="confirm">
            Type <code>{tag}</code> to confirm{" "}
            <input
              data-testid="tag-confirm-input"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              disabled={commit.isPending}
            />
          </label>
        )}
        {commit.error ? (
          <p className="error" data-testid="tag-error">
            Not changed: {commit.error.message}
          </p>
        ) : null}
      </>
    );
  }

  return (
    <div className="modal-backdrop" onClick={() => !commit.isPending && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={`Tag #${tag}`} data-testid="tag-dialog" onClick={(e) => e.stopPropagation()}>
        <h3>
          {remove.length && !add.length ? "Remove" : "Add"} #{tag}
        </h3>
        {body}
        <div className="modal-buttons">
          {commit.error || preview.error ? (
            <button type="button" className="btn" data-testid="tag-rerun" onClick={run}>
              Run the dry run again
            </button>
          ) : null}
          <button type="button" className="btn" data-testid="tag-cancel" onClick={onClose} disabled={commit.isPending}>
            {done ? "Close" : "Cancel"}
          </button>
          {p?.token && !done && !commit.error ? (
            <button
              type="button"
              className="btn btn-primary"
              data-testid="tag-commit"
              disabled={!confirmed || commit.isPending}
              onClick={() => commit.mutate({ token: p.token!, gain: p.gain.map((x) => x.pid), lose: p.lose.map((x) => x.pid), confirm: typed })}
            >
              {commit.isPending ? "Saving in HotCRP…" : "Confirm and save in HotCRP"}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

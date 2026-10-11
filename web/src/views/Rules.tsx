// The Rules page (spec §5c "Rule settings"): the chair decides what the
// paper-risk rules are. Each rule is a card with its switch, weight and
// thresholds (units, ranges, the env default and a per-field reset). Edits
// are a draft: the server previews it live (how many papers each rule would
// flag, which papers newly flag or unflag), and Save stores it as a revision
// with an optional note. The revisions list shows every change with its diff
// and restores any of them, or the env defaults.

import { useEffect, useMemo, useState } from "react";
import type { MetaResponse } from "../api";
import { AbsTime } from "../components/Time";
import { plural, ruleLabel } from "../format";
import { Link } from "../router";
import {
  RulesApiError,
  useRevertRules,
  useRevisions,
  useRules,
  useRulesPreview,
  useSaveRules,
  type RevisionInfo,
  type RuleInfo,
  type RuleSettingInfo,
  type RulesPreviewResponse,
  type SettingChange,
  type SettingValue,
} from "../rules-api";

type Draft = Record<string, SettingValue | null>;

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

const fmt = (v: SettingValue) => (typeof v === "boolean" ? (v ? "on" : "off") : String(v));

/** The value a field shows: the draft's, else the effective one. */
function shown(s: RuleSettingInfo, draft: Draft): SettingValue {
  const d = draft[s.key];
  return d === undefined ? s.value : d === null ? s.default : d;
}

function SettingField({ s, draft, setDraft, error }: { s: RuleSettingInfo; draft: Draft; setDraft: (k: string, v: SettingValue | null | undefined) => void; error?: string }) {
  const value = shown(s, draft);
  const [text, setText] = useState(String(value));
  // Follow outside changes (reset, discard, save) without fighting the typing ("0." stays "0.").
  useEffect(() => setText((t) => (Number(t) === value && t.trim() !== "" ? t : String(value))), [value]);
  const willOverride = draft[s.key] === undefined ? s.overridden : draft[s.key] !== null;
  const edited = draft[s.key] !== undefined;
  const local =
    text.trim() === "" || !Number.isFinite(Number(text))
      ? "enter a number"
      : (s.min !== undefined && Number(text) < s.min) || (s.max !== undefined && Number(text) > s.max)
        ? `from ${s.min} to ${s.max}`
        : s.kind === "int" && !Number.isInteger(Number(text))
          ? "a whole number"
          : null;
  const change = (t: string) => {
    setText(t);
    const n = Number(t);
    if (t.trim() === "" || !Number.isFinite(n)) return;
    if (n === s.value && s.overridden) setDraft(s.key, undefined);
    else if (n === s.default && !s.overridden) setDraft(s.key, undefined);
    else setDraft(s.key, n);
  };
  const id = `setting-${s.key}`;
  return (
    <div className={`rs-field${edited ? " rs-edited" : ""}`} data-testid="setting" data-key={s.key}>
      <label htmlFor={id} className="rs-label" title={s.description}>
        {s.label}
      </label>
      <div className="rs-input">
        <input
          id={id}
          type="number"
          inputMode="decimal"
          min={s.min}
          max={s.max}
          step={s.step ?? "any"}
          value={text}
          onChange={(e) => change(e.target.value)}
          aria-invalid={local !== null || error !== undefined}
          data-testid="setting-input"
        />
        <span className="muted">{s.unit}</span>
      </div>
      <div className="rs-default muted">
        env default {fmt(s.default)}
        {willOverride ? (
          <button type="button" className="btn btn-small" data-testid="setting-reset" onClick={() => setDraft(s.key, s.overridden ? null : undefined)} title="Back to the env default">
            reset
          </button>
        ) : null}
      </div>
      {local || error ? (
        <div className="error rs-err" data-testid="setting-error">
          {error ?? local}
        </div>
      ) : null}
      <div className="rs-desc muted">{s.description}</div>
    </div>
  );
}

function RuleCard({
  rule,
  settings,
  draft,
  setDraft,
  preview,
  errors,
}: {
  rule: RuleInfo;
  settings: ReadonlyMap<string, RuleSettingInfo>;
  draft: Draft;
  setDraft: (k: string, v: SettingValue | null | undefined) => void;
  preview: RulesPreviewResponse | undefined;
  errors: ReadonlyMap<string, string>;
}) {
  const en = settings.get(`PCS_RULE_${rule.name}_ENABLED`)!;
  const w = settings.get(`PCS_RULE_${rule.name}_WEIGHT`)!;
  const own = [...settings.values()].filter((s) => s.rule === rule.name && s.kind !== "bool" && s.key !== w.key);
  const shared = rule.settings.filter((k) => settings.get(k)?.rule !== rule.name).map((k) => settings.get(k)!);
  const on = shown(en, draft) as boolean;
  const cur = rule.papers;
  const next = preview ? preview.proposed.byRule[rule.name] : cur;
  return (
    <section className={`rs-card${on ? "" : " rs-off"}`} data-testid="rule-card" data-rule={rule.name}>
      <header className="rs-card-head">
        <label className="rs-toggle">
          <input
            type="checkbox"
            checked={on}
            data-testid="rule-enabled"
            onChange={(e) => {
              const v = e.target.checked;
              setDraft(en.key, v === en.value ? undefined : v === en.default && en.overridden ? null : v);
            }}
          />
          <strong>{ruleLabel(rule.name)}</strong>
        </label>
        <span className="muted rs-phase">{rule.phaseLabel}{rule.decisionIndependent ? " · decided papers too" : ""}</span>
        <span className="rs-count" data-testid="rule-count" data-current={cur} data-proposed={next}>
          {plural(cur, "paper")}
          {next !== cur ? (
            <>
              {" → "}
              <strong data-testid="rule-count-proposed">{next}</strong>
            </>
          ) : null}
        </span>
      </header>
      <p className="muted rs-rule-desc">{rule.description}</p>
      {en.overridden || draft[en.key] !== undefined ? (
        <p className="muted small">
          switch env default {fmt(en.default)}{" "}
          {(draft[en.key] === undefined ? en.overridden : draft[en.key] !== null) ? (
            <button type="button" className="btn btn-small" data-testid="setting-reset" onClick={() => setDraft(en.key, en.overridden ? null : undefined)}>
              reset
            </button>
          ) : null}
        </p>
      ) : null}
      <div className="rs-fields">
        <SettingField s={w} draft={draft} setDraft={setDraft} error={errors.get(w.key)} />
        {own.map((s) => (
          <SettingField key={s.key} s={s} draft={draft} setDraft={setDraft} error={errors.get(s.key)} />
        ))}
      </div>
      {shared.length ? (
        <p className="muted small">
          Also reads: {shared.map((s) => `${s.label} (${fmt(shown(s, draft))}${s.unit ? ` ${s.unit}` : ""})`).join(", ")}
        </p>
      ) : null}
    </section>
  );
}

function Diff({ diff }: { diff: readonly SettingChange[] }) {
  return (
    <ul className="rs-diff">
      {diff.map((c) => (
        <li key={c.key}>
          <code>{c.key}</code> {fmt(c.from)}
          {c.fromOverride ? "" : " (env default)"} → <strong>{fmt(c.to)}</strong>
          {c.toOverride ? "" : " (env default)"}
        </li>
      ))}
    </ul>
  );
}

function PreviewChanges({ p }: { p: RulesPreviewResponse }) {
  if (p.changesTotal === 0) return <p className="muted" data-testid="preview-none">No paper would change.</p>;
  return (
    <ul className="rs-changes" data-testid="preview-changes">
      {p.changes.map((c) => (
        <li key={c.pid} data-testid="preview-change" data-pid={c.pid}>
          <Link to={`/papers/${c.pid}`}>#{c.pid}</Link> <span className="ellipsis rs-title">{c.title}</span>{" "}
          {c.severityFrom === 0 && c.severityTo > 0 ? <span className="chip chip-alert">newly flagged</span> : null}
          {c.severityFrom > 0 && c.severityTo === 0 ? <span className="chip chip-info">unflagged</span> : null}{" "}
          {c.gained.map((r) => (
            <span key={r} className="rs-gain">
              +{ruleLabel(r)}{" "}
            </span>
          ))}
          {c.lost.map((r) => (
            <span key={r} className="rs-lose">
              −{ruleLabel(r)}{" "}
            </span>
          ))}
          <span className="muted">
            severity {c.severityFrom} → {c.severityTo}
          </span>
        </li>
      ))}
      {p.changesTotal > p.changes.length ? <li className="muted">… and {p.changesTotal - p.changes.length} more</li> : null}
    </ul>
  );
}

function Revisions({ tz, current }: { tz: string; current: number | null }) {
  const q = useRevisions();
  const revert = useRevertRules();
  const revs = q.data?.revisions ?? [];
  const label = (r: RevisionInfo) => (r.kind === "revert" ? (r.revertedTo === 0 ? "reset to env defaults" : `restored #${r.revertedTo}`) : "changed");
  return (
    <section className="ov-section" data-testid="revisions">
      <h2>Revisions</h2>
      {revert.error ? <p className="error">{revert.error.message}</p> : null}
      {revs.length === 0 ? <p className="muted">No changes yet: every rule uses its env default.</p> : null}
      <ol className="rs-revisions">
        {revs.map((r) => (
          <li key={r.id} data-testid="revision" data-id={r.id}>
            <div>
              <strong>#{r.id}</strong> <AbsTime ms={r.at} tz={tz} /> · {r.actor} · {label(r)}
              {r.id === current ? <span className="chip chip-neutral">in force</span> : null}
              {r.id !== current ? (
                <button type="button" className="btn btn-small" data-testid="revision-revert" disabled={revert.isPending} onClick={() => revert.mutate({ to: r.id, note: `restore #${r.id}` })}>
                  Restore this version
                </button>
              ) : null}
            </div>
            {r.note ? <div className="muted">“{r.note}”</div> : null}
            <Diff diff={r.diff} />
          </li>
        ))}
      </ol>
      {current !== null ? (
        <button type="button" className="btn" data-testid="rules-reset-all" disabled={revert.isPending} onClick={() => revert.mutate({ to: 0, note: "reset to env defaults" })}>
          Reset everything to the env defaults
        </button>
      ) : null}
    </section>
  );
}

export function Rules({ meta }: { meta: MetaResponse }) {
  const q = useRules();
  const save = useSaveRules();
  const [draft, setDraftState] = useState<Draft>({});
  const [note, setNote] = useState("");
  const debounced = useDebounced(draft, 250);
  const preview = useRulesPreview(debounced);
  const d = q.data;
  const settings = useMemo(() => new Map((d?.settings ?? []).map((s) => [s.key, s])), [d]);
  const setDraft = (k: string, v: SettingValue | null | undefined) =>
    setDraftState((cur) => {
      const next = Object.fromEntries(Object.entries(cur).filter(([key]) => key !== k));
      if (v !== undefined) next[k] = v;
      return next;
    });
  const errors = new Map<string, string>();
  for (const e of [preview.error, save.error]) if (e instanceof RulesApiError) for (const x of e.errors) errors.set(x.key, x.error);

  if (q.error) return <p className="error page">Could not load the rules: {q.error.message}</p>;
  if (!d) return <p className="muted page">Loading…</p>;
  const dirty = Object.keys(draft).length > 0;
  const p = dirty && Object.keys(debounced).length > 0 ? preview.data : undefined;
  const sharedSettings = d.settings.filter((s) => s.rule === null);

  const onSave = () =>
    save.mutate(
      { changes: draft, ...(note.trim() ? { note: note.trim() } : {}) },
      {
        onSuccess: () => {
          setDraftState({});
          setNote("");
        },
      },
    );

  return (
    <div className="page page-scroll" data-testid="rules-page">
      <div className="page-head">
        <h1>Rules</h1>
        <p className="muted" data-testid="rules-revision">
          {d.revision ? (
            <>
              Revision #{d.revision.id}, <AbsTime ms={d.revision.at} tz={meta.tz} /> by {d.revision.actor}. Values not changed here come from the environment (<code>PCS_*</code>).
            </>
          ) : (
            "Every value comes from the environment (PCS_*). Changes you make here are stored in the local database as revisions, never in HotCRP."
          )}
        </p>
      </div>

      <section className="rs-bar" data-testid="rules-bar">
        <div data-testid="preview-total" data-current={d.counts.flagged} data-proposed={p?.proposed.flagged ?? d.counts.flagged}>
          Flagged papers: <strong>{d.counts.flagged}</strong> of {d.papers}
          {p ? (
            <>
              {" → "}
              <strong data-testid="preview-total-proposed">{p.proposed.flagged}</strong> ({p.newlyFlagged} newly flagged, {p.unflagged} unflagged)
            </>
          ) : null}
          {dirty && preview.isFetching ? <span className="muted"> · previewing…</span> : null}
        </div>
        <input type="text" className="rs-note" placeholder="Note (optional): why this change" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} data-testid="rules-note" aria-label="Note" />
        <button type="button" className="btn btn-primary" disabled={!dirty || save.isPending || errors.size > 0} onClick={onSave} data-testid="rules-save">
          Save {dirty ? plural(Object.keys(draft).length, "change") : ""}
        </button>
        <button type="button" className="btn" disabled={!dirty} onClick={() => setDraftState({})} data-testid="rules-discard">
          Discard
        </button>
        {save.error && !(save.error instanceof RulesApiError && save.error.errors.length) ? <span className="error">{save.error.message}</span> : null}
        {save.data && !dirty ? (
          <span className="muted" data-testid="rules-saved">
            Saved revision #{save.data.revision.id}: {save.data.history.raised} flags raised, {save.data.history.cleared} cleared.
          </span>
        ) : null}
      </section>

      {p ? (
        <section className="ov-section" data-testid="preview">
          <h2>What would change</h2>
          <PreviewChanges p={p} />
        </section>
      ) : null}

      <div className="rs-cards">
        {d.rules.map((r) => (
          <RuleCard key={r.name} rule={r} settings={settings} draft={draft} setDraft={setDraft} preview={p} errors={errors} />
        ))}
        <section className="rs-card" data-testid="shared-settings">
          <header className="rs-card-head">
            <strong>Shared settings</strong>
          </header>
          <p className="muted rs-rule-desc">Read by several rules, or by the reviewer metrics rather than a paper rule.</p>
          <div className="rs-fields">
            {sharedSettings.map((s) => (
              <div key={s.key}>
                <SettingField s={s} draft={draft} setDraft={setDraft} error={errors.get(s.key)} />
                <p className="muted small">Used by: {[...s.rules.map(ruleLabel), ...s.alsoUsedBy].join(", ") || "—"}</p>
              </div>
            ))}
          </div>
        </section>
      </div>

      <Revisions tz={meta.tz} current={d.revision?.id ?? null} />
    </div>
  );
}

// Flag history (spec §5c "Flag history"): a feed of recent raises and clears,
// with why each happened (new data, a rule change with its revision, the
// baseline), and the chair's own tag writes; a per-rule count of open flags
// over time; both honour the paper filter (?search=). ?rule= narrows to one
// rule. "~" marks events reconstructed by `pcs backfill` (daily resolution).

import { useCommentLabels, type MetaResponse } from "../api";
import { KIND_LABEL } from "../components/CommentType";
import { TimeLines } from "../components/Charts";
import { AbsTime } from "../components/Time";
import { ruleLabel } from "../format";
import { Link, navigate, useLocation } from "../router";
import { useFlagHistory, type FlagFeedItem } from "../rules-api";

const CAUSE: Readonly<Record<string, string>> = { data: "new data", rules: "rule change", baseline: "history began" };

/** The chair's comment relabels (spec §5e), the audit trail. "After AC comment (ping)" in the feed above comes from these types. */
function Relabels({ tz }: { tz: string }) {
  const q = useCommentLabels();
  const items = q.data?.items ?? [];
  const label = (k: string | null) => (k === null ? "the classifier's label" : (KIND_LABEL[k as keyof typeof KIND_LABEL] ?? k).toLowerCase());
  return (
    <section className="ov-section">
      <h2>Comment relabels</h2>
      <p className="muted small">Your changes to comment types (ping, reply, discussion, non-substantive), newest first. They stay in the local store and train the local model.</p>
      {items.length === 0 ? (
        <p className="muted" data-testid="relabels-none">
          No relabels yet. Relabel a comment from its type chip in the paper drawer.
        </p>
      ) : (
        <ol className="fh-feed" data-testid="relabels">
          {items.map((r) => (
            <li key={r.id} className="fh-item" data-testid="relabel-item" data-cid={r.cid} data-kind={r.kind ?? ""}>
              <span className="fh-time">
                <AbsTime ms={r.at} tz={tz} />
              </span>
              <span>
                <Link to={`/papers/${r.pid}`}>#{r.pid}</Link> comment {r.cid}: {r.previous ? `${label(r.previous)} (${r.previousSource === "chair" ? "yours" : r.previousSource})` : "unclassified"} → <strong>{label(r.kind)}</strong> by {r.actor}{" "}
                <span className="muted ellipsis fh-title">{r.title ?? ""}</span>
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function Item({ it, tz }: { it: FlagFeedItem; tz: string }) {
  if (it.type === "action") {
    return (
      <li className="fh-item fh-action" data-testid="fh-item" data-type="action" data-pid={it.pid}>
        <span className="fh-time">
          <AbsTime ms={it.at} tz={tz} />
        </span>
        <span>
          <Link to={`/papers/${it.pid}`}>#{it.pid}</Link> {it.kind === "tag" ? "tagged" : "untagged"} <strong>#{it.tag}</strong> by {it.actor}{" "}
          <span className="muted ellipsis fh-title">{it.title}</span>
        </span>
      </li>
    );
  }
  return (
    <li className={`fh-item fh-${it.kind}`} data-testid="fh-item" data-type="flag" data-pid={it.pid} data-rule={it.rule} data-kind={it.kind} data-cause={it.cause}>
      <span className="fh-time">
        <AbsTime ms={it.at} tz={tz} approximate={it.reconstructed} />
      </span>
      <span>
        <Link to={`/papers/${it.pid}`}>#{it.pid}</Link> <strong>{ruleLabel(it.rule)}</strong> {it.kind}
        {it.why ? <span className="muted"> {it.why}</span> : <span className="muted"> ({CAUSE[it.cause] ?? it.cause})</span>}{" "}
        <span className="muted ellipsis fh-title">{it.title}</span>
        {it.kind === "raised" && it.reason ? <div className="muted small">{it.reason}</div> : null}
      </span>
    </li>
  );
}

export function FlagHistory({ meta }: { meta: MetaResponse }) {
  const loc = useLocation();
  const rule = loc.query.get("rule") ?? "";
  const q = useFlagHistory(rule);
  const d = q.data;
  const setRule = (r: string) => {
    const u = new URLSearchParams(loc.query);
    if (r) u.set("rule", r);
    else u.delete("rule");
    const s = u.toString();
    navigate(`/flag-history${s ? `?${s}` : ""}`, { replace: true });
  };
  if (q.error) return <p className="error page">Could not load the flag history: {q.error.message}</p>;
  if (!d) return <p className="muted page">Loading…</p>;
  const main = rule && d.series.byRule[rule] ? d.series.byRule[rule] : d.series.flagged;
  return (
    <div className="page page-scroll" data-testid="flag-history">
      <div className="page-head">
        <h1>Flag history</h1>
        <p className="muted">
          When each paper's flags were raised and cleared, and why.{" "}
          {d.since !== null ? (
            <>
              Recorded at every sync and rule change since <AbsTime ms={d.since} tz={meta.tz} />; earlier events (~) are reconstructed daily by <code>pcs backfill</code>.
            </>
          ) : (
            "Nothing recorded yet: run a sync."
          )}
        </p>
      </div>

      <div className="filters">
        <label>
          Rule{" "}
          <select value={rule} onChange={(e) => setRule(e.target.value)} data-testid="fh-rule">
            <option value="">All rules</option>
            {meta.rules.map((r) => (
              <option key={r.name} value={r.name}>
                {ruleLabel(r.name)}
              </option>
            ))}
          </select>
        </label>
      </div>

      <section className="ov-section">
        <h2>Open flags over time</h2>
        {d.series.ts.length > 1 ? (
          <TimeLines
            testId="fh-chart"
            ariaLabel="Open flags over time"
            ts={d.series.ts}
            tz={meta.tz}
            series={[
              { key: "main", label: rule ? ruleLabel(rule) : "flagged papers", className: "line-main", values: main },
              ...(rule ? [{ key: "flagged", label: "flagged papers", className: "line-ref", values: d.series.flagged }] : []),
            ]}
            markers={[
              { at: meta.phases.reviewDue, label: "Reviews due" },
              { at: meta.phases.discussionOpen, label: "Discussion" },
              { at: d.now, label: "Now", className: "marker marker-now" },
            ]}
          />
        ) : (
          <p className="muted">Not enough history for a chart yet.</p>
        )}
        <table className="fh-summary" data-testid="fh-summary">
          <thead>
            <tr>
              <th>Rule</th>
              <th className="num">open now</th>
              <th className="num">raised, 7 days</th>
              <th className="num">cleared, 7 days</th>
            </tr>
          </thead>
          <tbody>
            {d.summary.map((s) => (
              <tr key={s.rule} data-testid="fh-summary-row" data-rule={s.rule}>
                <td>
                  <button type="button" className="btn btn-small" onClick={() => setRule(rule === s.rule ? "" : s.rule)}>
                    {ruleLabel(s.rule)}
                  </button>
                </td>
                <td className="num">{s.open}</td>
                <td className="num">{s.raised7d}</td>
                <td className="num">{s.cleared7d}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="ov-section">
        <h2>Recent changes</h2>
        {d.items.length === 0 ? <p className="muted">No flag changes recorded.</p> : null}
        <ol className="fh-feed" data-testid="fh-feed">
          {d.items.map((it) => (
            <Item key={`${it.type}-${it.id}`} it={it} tz={meta.tz} />
          ))}
        </ol>
        {d.more ? <p className="muted">Showing the latest {d.items.length}.</p> : null}
      </section>
      {meta.commentTypes.active !== "off" ? <Relabels tz={meta.tz} /> : null}
    </div>
  );
}

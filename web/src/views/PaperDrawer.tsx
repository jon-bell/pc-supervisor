// The paper drawer (spec §5c): reasons, then one timeline of reviews, score
// changes, comments (author, word count, mentions) and the author response,
// with full text from the local store. Every review links into HotCRP.
// Actions (PLAN M8): draft a nudge comment to copy (never posted), and add or
// remove PCS_ATTENTION_TAG behind HotCRP's dry run and a typed confirmation.

import { useState, type ReactNode } from "react";
import type { CommentDetail, MetaResponse, PaperDetail, ReviewDetail, TimelineEvent } from "../api";
import { useActions, useNudge, usePaper } from "../api";
import { CopyButton, TagDialog } from "../components/Actions";
import { Chip, ReasonChips } from "../components/Chip";
import { AbsTime } from "../components/Time";
import { formatRatings } from "@pcs/server/ratings";
import { hotcrp, plural } from "../format";
import { useTiersConfigured } from "../tiers";

function Who({ name, tier, role }: { name: string; tier: string; role?: string }) {
  const tiers = useTiersConfigured();
  return (
    <span className="who">
      <strong>{name}</strong>
      {role && role !== "other" ? <span className="role"> {role}</span> : null}
      {tiers && tier !== "senior" ? <span className="tier"> · {tier}</span> : null}
    </span>
  );
}

function ReviewEvent({ r, base, pid }: { r: ReviewDetail; base: string; pid: number }) {
  const label = r.role === "AC" ? "Metareview" : `Review ${r.ordinal ?? ""}`.trim();
  return (
    <>
      <div className="ev-head">
        <a href={hotcrp.review(base, pid, r.ordinal, r.rid)} target="_blank" rel="noreferrer noopener" className="ext" data-testid="review-link">
          {label} ↗
        </a>{" "}
        by <Who name={r.reviewer.name} tier={r.reviewer.tier} /> submitted
      </div>
      <div className="ev-meta">
        {r.merit !== null ? `merit ${r.merit}` : null}
        {r.expertise !== null ? ` · expertise ${r.expertise}` : null} · {plural(r.wordCount, "word")}
        {r.ratings && formatRatings(r.ratings) ? (
          <span data-testid="review-ratings" title="HotCRP review ratings: raters per flag">
            {" · rated "}
            {formatRatings(r.ratings)}
          </span>
        ) : null}
      </div>
      {r.text.length ? (
        <details className="ev-text">
          <summary>Review text</summary>
          {r.text.map((t) => (
            <div key={t.field}>
              <h4>{t.field}</h4>
              <p>{t.text}</p>
            </div>
          ))}
        </details>
      ) : null}
    </>
  );
}

function CommentEvent({ c, tz }: { c: CommentDetail; tz: string }) {
  return (
    <>
      <div className="ev-head">
        {c.isResponse ? "Author response" : "Comment"} by <Who name={c.author.name} tier={c.author.tier} role={c.role} />
        {c.draft ? <Chip tone="neutral">draft</Chip> : null}
      </div>
      <div className="ev-meta">
        <span data-testid="word-count">{plural(c.wordCount, "word")}</span>
        {c.mentions.length ? (
          <span data-testid="mentions">
            {" · mentions "}
            {c.mentions.map((m, i) => (
              <span key={m.email}>
                {i ? ", " : ""}
                <strong>@{m.name}</strong>
              </span>
            ))}
          </span>
        ) : null}
        {c.editedAt !== null ? (
          <span>
            {" · edited "}
            <AbsTime ms={c.editedAt} tz={tz} />
          </span>
        ) : null}
      </div>
      <p className="ev-body">{c.text}</p>
    </>
  );
}

function eventKey(e: TimelineEvent): string {
  switch (e.kind) {
    case "review":
      return `review-${e.rid}`;
    case "score":
      return `score-${e.rid}-${e.field}-${e.at}`;
    case "decision":
      return `decision-${e.at}`;
    default:
      return `${e.kind}-${e.cid}`;
  }
}

function Timeline({ d, meta }: { d: PaperDetail; meta: MetaResponse }) {
  const reviews = new Map(d.reviews.map((r) => [r.rid, r]));
  const comments = new Map(d.comments.map((c) => [c.cid, c]));
  const discussionOpen = meta.phases.discussionOpen;
  let markerShown = false;
  const items: ReactNode[] = [];
  for (const e of d.timeline) {
    if (!markerShown && e.at >= discussionOpen) {
      markerShown = true;
      items.push(
        <li key="discussion-open" className="ev ev-marker">
          Discussion opened <AbsTime ms={discussionOpen} tz={meta.tz} />
        </li>,
      );
    }
    let body: ReactNode;
    if (e.kind === "review") body = <ReviewEvent r={reviews.get(e.rid)!} base={meta.hotcrpUrl} pid={d.pid} />;
    else if (e.kind === "score") {
      const r = reviews.get(e.rid)!;
      body = (
        <div className="ev-head">
          <Who name={r.reviewer.name} tier={r.reviewer.tier} /> changed {e.field} {e.from} → {e.to}
        </div>
      );
    } else if (e.kind === "decision") body = <div className="ev-head">Decision: {e.decision}</div>;
    else body = <CommentEvent c={comments.get(e.cid)!} tz={meta.tz} />;
    const id = "cid" in e ? e.cid : "rid" in e ? e.rid : 0;
    items.push(
      <li key={eventKey(e)} className={`ev ev-${e.kind}`} data-testid={`timeline-${e.kind}`} data-id={id}>
        <div className="ev-time">
          <AbsTime ms={e.at} tz={meta.tz} approximate={e.approximate} />
        </div>
        <div className="ev-main">{body}</div>
      </li>,
    );
  }
  if (!markerShown) {
    items.push(
      <li key="discussion-open" className="ev ev-marker">
        Discussion opens <AbsTime ms={discussionOpen} tz={meta.tz} />
      </li>,
    );
  }
  return (
    <ol className="timeline" data-testid="timeline">
      {items}
    </ol>
  );
}

const hasTag = (tags: readonly string[], tag: string) => tags.some((t) => t.replace(/#.*$/, "").toLowerCase() === tag.toLowerCase());

function DrawerActions({ d }: { d: PaperDetail }) {
  const actions = useActions().data;
  const [showNudge, setShowNudge] = useState(false);
  const [tagging, setTagging] = useState(false);
  const nudge = useNudge(d.pid, showNudge);
  const tag = actions?.attentionTag;
  const tagged = tag ? hasTag(d.tags, tag) : false;
  return (
    <section className="drawer-actions" data-testid="drawer-actions">
      <div className="actions-bar">
        <button type="button" className="btn" data-testid="nudge-draft" aria-expanded={showNudge} onClick={() => setShowNudge((v) => !v)}>
          {showNudge ? "Hide nudge draft" : "Draft a nudge comment"}
        </button>
        {tag && actions?.taggingAvailable ? (
          <button type="button" className="btn" data-testid="drawer-tag" onClick={() => setTagging(true)}>
            {tagged ? `Remove #${tag}…` : `Tag #${tag}…`}
          </button>
        ) : null}
      </div>
      {showNudge ? (
        <div className="nudge" data-testid="nudge-panel">
          {nudge.error ? <p className="error">{nudge.error.message}</p> : null}
          {nudge.data ? (
            <>
              <p className="muted">A draft to copy into a HotCRP comment and edit there. The app never posts it.</p>
              <textarea readOnly className="nudge-text" data-testid="nudge-text" value={nudge.data.text} rows={Math.min(14, nudge.data.text.split("\n").length + 1)} />
              <CopyButton text={nudge.data.text} label="Copy draft" testId="copy-nudge" />
            </>
          ) : nudge.isLoading ? (
            <p className="muted">Drafting…</p>
          ) : null}
        </div>
      ) : null}
      {tagging && tag ? (
        <TagDialog tag={tag} add={tagged ? [] : [d.pid]} remove={tagged ? [d.pid] : []} onClose={() => setTagging(false)} />
      ) : null}
    </section>
  );
}

export function PaperDrawer({ pid, meta, onClose }: { pid: number; meta: MetaResponse; onClose: () => void }) {
  const q = usePaper(pid);
  const d = q.data;
  const pcComments = d?.comments.filter((c) => !c.isResponse && !c.draft).length ?? 0;
  return (
    <aside className="drawer" data-testid="paper-drawer" data-pid={pid} aria-label={`Paper ${pid}`}>
      <header className="drawer-head">
        <div>
          <div className="drawer-pid">
            #{pid}{" "}
            <a href={hotcrp.paper(meta.hotcrpUrl, pid)} target="_blank" rel="noreferrer noopener" className="ext" data-testid="drawer-hotcrp-link">
              open in HotCRP ↗
            </a>
          </div>
          <h2 data-testid="drawer-title">{d?.title ?? (q.error ? "Not found" : "Loading…")}</h2>
        </div>
        <button type="button" className="btn close" onClick={onClose} aria-label="Close" data-testid="drawer-close">
          ×
        </button>
      </header>
      {q.error ? <p className="error">{q.error.message}</p> : null}
      {d ? (
        <div className="drawer-body">
          <dl className="facts">
            <dt>AC</dt>
            <dd>{d.acs.map((a) => a.name).join(", ") || "none"}</dd>
            <dt>Decision</dt>
            <dd>{d.decision ?? "none yet"}</dd>
            <dt>Severity</dt>
            <dd data-testid="drawer-severity">{d.severity}</dd>
            <dt>Tags</dt>
            <dd data-testid="drawer-tags">{d.tags.length ? d.tags.map((t) => `#${t}`).join(" ") : "none"}</dd>
          </dl>
          {d.reasons.length ? (
            <ul className="reasons" data-testid="drawer-reasons">
              {d.reasons.map((r) => (
                <li key={r.rule}>
                  <ReasonChips reasons={[r]} /> {r.reason}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted" data-testid="drawer-no-reasons">
              No rules fire for this paper.
            </p>
          )}
          <DrawerActions d={d} />
          {pcComments === 0 ? <p className="muted">No comments yet.</p> : null}
          <Timeline d={d} meta={meta} />
        </div>
      ) : null}
    </aside>
  );
}

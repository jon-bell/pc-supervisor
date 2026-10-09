// Listbox pieces shared by the search box (SearchCombobox) and the column
// filters (ColumnFilters): the active-option keyboard model (↓/↑ wrap, the
// active option scrolled into view, exposed through aria-activedescendant),
// the suggestion list itself, and the typed-prefix highlight.

import { useEffect, useId, useState, type KeyboardEvent, type ReactNode } from "react";

export interface ListNav {
  listId: string;
  /** -1 when the list is empty. */
  activeIndex: number;
  setActive: (i: number) => void;
  optionId: (i: number) => string;
  /** ↓/↑ (and Home/End when `homeEnd`): returns true when it handled the key. */
  onNavKey: (e: KeyboardEvent) => boolean;
}

export function useListNav(count: number, shown: boolean, opts: { homeEnd?: boolean; resetOn?: unknown } = {}): ListNav {
  const listId = useId();
  const [active, setActive] = useState(0);
  const activeIndex = count === 0 ? -1 : Math.min(active, count - 1);
  const optionId = (i: number) => `${listId}-${i}`;
  useEffect(() => setActive(0), [opts.resetOn]);
  useEffect(() => {
    if (!shown || activeIndex < 0) return;
    document.getElementById(`${listId}-${activeIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [shown, activeIndex, listId]);
  const onNavKey = (e: KeyboardEvent) => {
    if (!shown || count === 0) return false;
    let next: number | null = null;
    if (e.key === "ArrowDown") next = (activeIndex + 1) % count;
    else if (e.key === "ArrowUp") next = (activeIndex - 1 + count) % count;
    else if (opts.homeEnd && e.key === "Home") next = 0;
    else if (opts.homeEnd && e.key === "End") next = count - 1;
    if (next === null) return false;
    e.preventDefault();
    setActive(next);
    return true;
  };
  return { listId, activeIndex, setActive, optionId, onNavKey };
}

export interface ComboOption {
  key: string;
  label: string;
  hint?: string;
  count?: number;
  countTitle?: string;
  className?: string;
  attrs?: Record<string, string>;
}

/** A suggestion listbox under a combobox input (CSS .combo-list). Options accept on mousedown so the input keeps focus. */
export function ComboList({
  nav,
  options,
  shown,
  typed,
  label,
  onPick,
  testId,
  optionTestId,
}: {
  nav: ListNav;
  options: readonly ComboOption[];
  shown: boolean;
  typed: string;
  label: string;
  onPick: (o: ComboOption, i: number) => void;
  testId?: string;
  optionTestId?: string;
}) {
  return (
    <>
      <ul id={nav.listId} role="listbox" aria-label={label} className="combo-list" data-testid={testId} hidden={!shown}>
        {shown
          ? options.map((o, i) => (
              <li
                key={o.key}
                id={nav.optionId(i)}
                role="option"
                aria-selected={i === nav.activeIndex}
                className={`combo-item${o.className ? ` ${o.className}` : ""}`}
                data-testid={optionTestId}
                {...o.attrs}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onPick(o, i);
                }}
                onMouseMove={() => i !== nav.activeIndex && nav.setActive(i)}
              >
                <span className="combo-label">
                  <Marked text={o.label} typed={typed} />
                </span>
                {o.hint ? <span className="combo-hint">{o.hint}</span> : null}
                {o.count !== undefined ? (
                  <span className="combo-count" title={o.countTitle}>
                    {o.count}
                  </span>
                ) : null}
              </li>
            ))
          : null}
      </ul>
      <LiveCount n={shown ? options.length : null} noun="suggestion" />
    </>
  );
}

/** A polite live region announcing how many options a list has. */
export function LiveCount({ n, noun }: { n: number | null; noun: string }) {
  return (
    <span className="visually-hidden" aria-live="polite">
      {n === null ? "" : `${n} ${noun}${n === 1 ? "" : "s"}`}
    </span>
  );
}

/** `text` with the typed prefix in bold when it is one (else the first match, for substring search). */
export function Marked({ text, typed, anywhere = false }: { text: string; typed: string; anywhere?: boolean }): ReactNode {
  if (!typed) return <>{text}</>;
  const at = text.toLowerCase().indexOf(typed.toLowerCase());
  if (at === 0 || (anywhere && at > 0)) {
    return (
      <>
        {text.slice(0, at)}
        <b>{text.slice(at, at + typed.length)}</b>
        {text.slice(at + typed.length)}
      </>
    );
  }
  return <>{text}</>;
}

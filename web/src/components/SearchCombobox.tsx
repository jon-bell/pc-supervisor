// The "Papers matching" input with HotCRP-search autocomplete: an ARIA 1.2
// combobox (input + listbox) that completes the token under the caret
// (search-complete.ts). Keyboard: ↓/↑ move (↓ also opens), Tab/Enter accept,
// Esc closes; Enter with the list closed (or on an already-complete token)
// submits the form.

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useSearchCompletions } from "../api";
import { applySuggestion, isComplete, suggest, type Suggestion } from "../search-complete";

export function SearchCombobox({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [caret, setCaret] = useState(value.length);
  const [active, setActive] = useState(0);
  const pendingCaret = useRef<number | null>(null);
  const listId = useId();
  const data = useSearchCompletions(true).data;

  const { token, items } = useMemo(
    () => (data ? suggest(data, value, caret) : { token: { start: 0, end: 0, prefix: "" }, items: [] as Suggestion[] }),
    [data, value, caret],
  );
  const shown = open && items.length > 0;
  const activeIndex = Math.min(active, items.length - 1);

  useEffect(() => setActive(0), [token.start, token.prefix]);
  useLayoutEffect(() => {
    const at = pendingCaret.current;
    if (at !== null && input.current) {
      input.current.setSelectionRange(at, at);
      pendingCaret.current = null;
    }
  }, [value]);
  useEffect(() => {
    if (!shown) return;
    document.getElementById(`${listId}-${activeIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [shown, activeIndex, listId]);

  const syncCaret = () => setCaret(input.current?.selectionStart ?? value.length);

  const accept = (s: Suggestion) => {
    const r = applySuggestion(value, token, s);
    pendingCaret.current = r.caret;
    setCaret(r.caret);
    onChange(r.value);
    setOpen(s.continues);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!shown) {
        syncCaret();
        setOpen(true);
        setActive(0);
      } else setActive((activeIndex + 1) % items.length);
    } else if (e.key === "ArrowUp" && shown) {
      e.preventDefault();
      setActive((activeIndex - 1 + items.length) % items.length);
    } else if ((e.key === "Enter" || e.key === "Tab") && shown && !e.shiftKey) {
      const s = items[activeIndex]!;
      if (isComplete(value, token, s)) {
        setOpen(false);
        return; // Enter submits, Tab moves on
      }
      e.preventDefault();
      accept(s);
    } else if (e.key === "Escape" && shown) {
      e.preventDefault(); // not the search input's clear-on-Esc
      setOpen(false);
    }
  };

  return (
    <span className="combo">
      <input
        ref={input}
        id={id}
        type="search"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={shown}
        aria-controls={listId}
        aria-activedescendant={shown ? `${listId}-${activeIndex}` : undefined}
        data-testid="paper-filter-input"
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setCaret(e.target.selectionStart ?? e.target.value.length);
          setOpen(true);
        }}
        onSelect={syncCaret}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
        placeholder="a HotCRP search, e.g. #tag or 1-50"
        aria-label="Filter papers by HotCRP search"
        autoComplete="off"
        spellCheck={false}
        maxLength={1000}
      />
      <ul id={listId} role="listbox" aria-label="Search suggestions" className="combo-list" data-testid="paper-filter-suggestions" hidden={!shown}>
        {shown
          ? items.map((s, i) => (
              <li
                key={s.insert}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === activeIndex}
                className={`combo-item kind-${s.kind}`}
                data-testid="paper-filter-suggestion"
                data-insert={s.insert}
                // mousedown, not click: keep the input's focus (and caret).
                onMouseDown={(e) => {
                  e.preventDefault();
                  accept(s);
                }}
                onMouseMove={() => i !== activeIndex && setActive(i)}
              >
                <span className="combo-label">
                  <Marked text={s.label} typed={token.prefix} />
                </span>
                {s.hint ? <span className="combo-hint">{s.hint}</span> : null}
                {s.count !== undefined ? (
                  <span className="combo-count" title={`${s.count} paper${s.count === 1 ? "" : "s"} in the store`}>
                    {s.count}
                  </span>
                ) : null}
              </li>
            ))
          : null}
      </ul>
      <span className="visually-hidden" aria-live="polite">
        {shown ? `${items.length} suggestion${items.length === 1 ? "" : "s"}` : ""}
      </span>
    </span>
  );
}

/** `text` with the typed prefix in bold when it is one. */
function Marked({ text, typed }: { text: string; typed: string }) {
  if (typed && text.toLowerCase().startsWith(typed.toLowerCase())) {
    return (
      <>
        <b>{text.slice(0, typed.length)}</b>
        {text.slice(typed.length)}
      </>
    );
  }
  return <>{text}</>;
}

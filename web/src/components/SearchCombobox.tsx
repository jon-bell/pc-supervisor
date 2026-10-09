// The "Papers matching" input with HotCRP-search autocomplete: an ARIA 1.2
// combobox (input + listbox) that completes the token under the caret
// (search-complete.ts). Keyboard: ↓/↑ move (↓ also opens), Tab/Enter accept,
// Esc closes; Enter with the list closed (or on an already-complete token)
// submits the form.

import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useSearchCompletions } from "../api";
import { applySuggestion, isComplete, suggest, type Suggestion } from "../search-complete";
import { ComboList, useListNav, type ComboOption } from "./listbox";

export function SearchCombobox({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [caret, setCaret] = useState(value.length);
  const pendingCaret = useRef<number | null>(null);
  const data = useSearchCompletions(true).data;

  const { token, items } = useMemo(
    () => (data ? suggest(data, value, caret) : { token: { start: 0, end: 0, prefix: "" }, items: [] as Suggestion[] }),
    [data, value, caret],
  );
  const shown = open && items.length > 0;
  const nav = useListNav(items.length, shown, { resetOn: `${token.start}:${token.prefix}` });
  const activeIndex = nav.activeIndex;
  const options = useMemo<ComboOption[]>(
    () =>
      items.map((s) => ({
        key: s.insert,
        label: s.label,
        hint: s.hint || undefined,
        count: s.count,
        countTitle: s.count === undefined ? undefined : `${s.count} paper${s.count === 1 ? "" : "s"} in the store`,
        className: `kind-${s.kind}`,
        attrs: { "data-insert": s.insert },
      })),
    [items],
  );

  useLayoutEffect(() => {
    const at = pendingCaret.current;
    if (at !== null && input.current) {
      input.current.setSelectionRange(at, at);
      pendingCaret.current = null;
    }
  }, [value]);

  const syncCaret = () => setCaret(input.current?.selectionStart ?? value.length);

  const accept = (s: Suggestion) => {
    const r = applySuggestion(value, token, s);
    pendingCaret.current = r.caret;
    setCaret(r.caret);
    onChange(r.value);
    setOpen(s.continues);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" && !shown) {
      e.preventDefault();
      syncCaret();
      setOpen(true);
      nav.setActive(0);
    } else if (nav.onNavKey(e)) {
      // moved
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
        aria-controls={nav.listId}
        aria-activedescendant={shown ? nav.optionId(activeIndex) : undefined}
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
      <ComboList
        nav={nav}
        options={options}
        shown={shown}
        typed={token.prefix}
        label="Search suggestions"
        testId="paper-filter-suggestions"
        optionTestId="paper-filter-suggestion"
        onPick={(_, i) => accept(items[i]!)}
      />
    </span>
  );
}

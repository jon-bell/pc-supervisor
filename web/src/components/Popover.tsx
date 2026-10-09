// A non-modal popover anchored to a button (the column filter menus). It is
// portalled to <body> with fixed positioning, so a table's overflow never
// clips it: below the anchor, flipped above when there is no room, clamped to
// the viewport, and re-placed on scroll and resize. Focus moves into it on
// open; Esc closes it and returns focus to the anchor; a press outside, or
// tabbing out, closes it.

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

const MARGIN = 8;

/** Where a box of `size` goes next to `anchor` in a `view`-sized viewport. Pure, for tests and reuse. */
export function placeBelow(anchor: { top: number; bottom: number; left: number }, size: { width: number; height: number }, view: { width: number; height: number }) {
  const below = view.height - anchor.bottom - MARGIN;
  const above = anchor.top - MARGIN;
  const flip = size.height > below && above > below;
  const top = flip ? Math.max(MARGIN, anchor.top - 2 - size.height) : anchor.bottom + 2;
  const left = Math.max(MARGIN, Math.min(anchor.left, view.width - size.width - MARGIN));
  const maxHeight = Math.max(120, flip ? above : below);
  return { top, left, maxHeight };
}

export function Popover({
  anchor,
  onClose,
  label,
  children,
  testId,
}: {
  anchor: RefObject<HTMLElement | null>;
  onClose: () => void;
  label: string;
  children: ReactNode;
  testId?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; maxHeight: number } | null>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useLayoutEffect(() => {
    const place = () => {
      const a = anchor.current?.getBoundingClientRect();
      const b = box.current;
      if (!a || !b) return;
      setPos(placeBelow(a, { width: b.offsetWidth, height: b.offsetHeight }, { width: window.innerWidth, height: window.innerHeight }));
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchor]);

  useEffect(() => {
    const el = box.current;
    const first = el?.querySelector<HTMLElement>("[data-autofocus]") ?? el?.querySelector<HTMLElement>("input, button, select, [tabindex]:not([tabindex='-1'])");
    first?.focus();
    const down = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!box.current?.contains(t) && !anchor.current?.contains(t)) close.current();
    };
    document.addEventListener("mousedown", down, true);
    return () => document.removeEventListener("mousedown", down, true);
  }, [anchor]);

  return createPortal(
    <div
      ref={box}
      className="popover"
      role="dialog"
      aria-label={label}
      data-testid={testId}
      style={pos ? { top: pos.top, left: pos.left, maxHeight: pos.maxHeight } : { top: -9999, left: -9999 }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          close.current();
          anchor.current?.focus();
        }
      }}
      onBlur={(e) => {
        const next = e.relatedTarget as Node | null;
        if (next && !box.current?.contains(next) && !anchor.current?.contains(next)) close.current();
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

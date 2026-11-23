import { useEffect, useLayoutEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import "./Menu.css";

export interface MenuItem {
  label: string;
  /** Zweite Zeile, z. B. "wird vorbereitet" oder "aus komprimierter Aufnahme". */
  hint?: ReactNode;
  icon?: LucideIcon;
  /** Aktion – oder href für echte Links/Downloads (kein Blob-Umweg). */
  onSelect?: () => void;
  href?: string;
  /** setzt das download-Attribut am Link */
  download?: boolean;
  disabled?: boolean;
  /** Platz rechts, z. B. <Badge> oder <Spinner>. */
  end?: ReactNode;
}

export interface MenuProps {
  /** Inhalt des Auslöse-Buttons (Icon/Text). */
  trigger: ReactNode;
  /** Pflicht, falls trigger nur ein Icon ist. */
  label: string;
  items: MenuItem[];
  align?: "start" | "end";
  triggerClassName?: string;
}

/** Ausklappmenü (WAI-ARIA menu button): Enter/Leertaste/↓ öffnet, ↑/↓ wählt, Esc schließt. */
export function Menu({ trigger, label, items, align = "end", triggerClassName = "btn btn--ghost btn--md btn--icon" }: MenuProps) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState({ above: false, height: 480 });

  useLayoutEffect(() => {
    if (!open || !btn.current || !list.current) return;
    const rect = btn.current.getBoundingClientRect();
    const below = Math.max(0, window.innerHeight - rect.bottom - 16);
    const above = Math.max(0, rect.top - 16);
    const flip = list.current.scrollHeight > below && above > below;
    setPlacement({ above: flip, height: flip ? above : below });
  }, [open, items.length]);

  const focusItem = (dir: 1 | -1 | 0) => {
    const els = [...(root.current?.querySelectorAll<HTMLElement>("[role=menuitem]:not([aria-disabled=true])") ?? [])];
    if (!els.length) return;
    const i = els.indexOf(document.activeElement as HTMLElement);
    els[dir === 0 ? 0 : (i + dir + els.length) % els.length]?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", close);
    requestAnimationFrame(() => focusItem(0));
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && open) { e.preventDefault(); setOpen(false); btn.current?.focus(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); open ? focusItem(1) : setOpen(true); }
    else if (e.key === "ArrowUp" && open) { e.preventDefault(); focusItem(-1); }
    else if (e.key === "Tab" && open) setOpen(false);
  };

  const pick = (it: MenuItem) => { if (it.disabled) return; setOpen(false); it.onSelect?.(); };

  return (
    <div className="menu" ref={root} onKeyDown={onKey}>
      <button ref={btn} type="button" className={triggerClassName} aria-haspopup="menu" aria-expanded={open}
        aria-controls={id} aria-label={label} onClick={() => setOpen((o) => !o)}>
        {trigger}
      </button>
      {open && (
        <div ref={list} className={`menu__list menu__list--${align}${placement.above ? " menu__list--above" : ""}`}
          style={{ maxHeight: placement.height }} role="menu" id={id} aria-label={label}>
          {items.map((it, i) => {
            const body = (
              <>
                {it.icon && <it.icon size={16} aria-hidden className="menu__icon" />}
                <span className="menu__text"><span>{it.label}</span>{it.hint && <span className="menu__hint">{it.hint}</span>}</span>
                {it.end && <span className="menu__end">{it.end}</span>}
              </>
            );
            return it.href && !it.disabled ? (
              <a key={i} role="menuitem" tabIndex={-1} className="menu__item" href={it.href}
                download={it.download || undefined} onClick={() => pick(it)}>{body}</a>
            ) : (
              <button key={i} type="button" role="menuitem" tabIndex={-1} className="menu__item"
                aria-disabled={it.disabled || undefined} onClick={() => pick(it)}>{body}</button>
            );
          })}
        </div>
      )}
    </div>
  );
}

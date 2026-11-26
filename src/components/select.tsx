"use client";

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, Search } from "lucide-react";

/**
 * A dropdown with the sandbox's own look, in place of the browser's. It opens a list under the button (or above,
 * near the bottom of the screen), can be worked from the keyboard, and has a search box once the list is long.
 */

export interface SelectOption {
  value: string;
  label: string;
  /** A second, quieter line. */
  hint?: string;
  /** Options with the same group are listed under its name. */
  group?: string;
  icon?: ReactNode;
  disabled?: boolean;
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  /** Shows a search box. By default, once there are more than seven options. */
  searchable?: boolean;
  tone?: "light" | "dark";
  size?: "sm" | "md";
  disabled?: boolean;
  className?: string;
  /** For screen readers, where no visible label says what this is. */
  label?: string;
  /** Show the option in a monospace font (for codes such as payment.authorize). */
  mono?: boolean;
}

const LOOK = {
  light: {
    button: "border-gray-300 bg-white text-gray-900 shadow-sm hover:border-gray-400 focus-visible:border-[#3b1f6e] focus-visible:ring-2 focus-visible:ring-[#3b1f6e]/20",
    open: "border-[#3b1f6e] ring-2 ring-[#3b1f6e]/20",
    panel: "border-gray-200 bg-white text-gray-900 shadow-xl shadow-gray-900/10",
    search: "border-gray-200 bg-gray-50 text-gray-900 placeholder:text-gray-400 focus:border-[#3b1f6e] focus:bg-white",
    group: "text-gray-400",
    active: "bg-[#f3effa] text-[#3b1f6e]",
    chosen: "text-[#3b1f6e]",
    hint: "text-gray-500",
    chevron: "text-gray-400",
    empty: "text-gray-500",
  },
  dark: {
    button: "border-slate-700 bg-slate-900 text-slate-100 hover:border-slate-500 focus-visible:border-indigo-400 focus-visible:ring-2 focus-visible:ring-indigo-400/25",
    open: "border-indigo-400 ring-2 ring-indigo-400/25",
    panel: "border-slate-700 bg-slate-900 text-slate-100 shadow-xl shadow-black/40",
    search: "border-slate-700 bg-slate-950 text-slate-100 placeholder:text-slate-500 focus:border-indigo-400",
    group: "text-slate-500",
    active: "bg-indigo-500/15 text-white",
    chosen: "text-indigo-300",
    hint: "text-slate-400",
    chevron: "text-slate-400",
    empty: "text-slate-500",
  },
};

export function Select({ value, onChange, options, placeholder = "Choose…", searchable, tone = "light", size = "md", disabled, className = "", label, mono }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [up, setUp] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const id = useId();
  const look = LOOK[tone];
  const canSearch = searchable ?? options.length > 7;
  const chosen = options.find((o) => o.value === value);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? options.filter((o) => `${o.label} ${o.hint ?? ""} ${o.group ?? ""} ${o.value}`.toLowerCase().includes(q)) : options;
  }, [options, query]);

  const show = () => {
    if (disabled) return;
    setQuery("");
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    setOpen(true);
  };
  const close = (focus = true) => {
    setOpen(false);
    if (focus) button.current?.focus();
  };
  const pick = (o: SelectOption | undefined) => {
    if (!o || o.disabled) return;
    onChange(o.value);
    close();
  };

  // Opens upwards when there is not room below.
  useLayoutEffect(() => {
    if (!open || !box.current) return;
    const r = box.current.getBoundingClientRect();
    setUp(window.innerHeight - r.bottom < 300 && r.top > window.innerHeight - r.bottom);
    if (canSearch) search.current?.focus();
    else list.current?.focus();
  }, [open, canSearch]);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && close(false);
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  // Keeps the highlighted option in view.
  useEffect(() => {
    if (!open) return;
    list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const keys = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) return show();
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((a) => {
        for (let i = 1; i <= shown.length; i++) {
          const n = (a + step * i + shown.length) % shown.length;
          if (!shown[n]?.disabled) return n;
        }
        return a;
      });
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (open) pick(shown[active]);
      else show();
    } else if (e.key === "Escape" && open) {
      e.preventDefault();
      close();
    } else if (e.key === "Tab" && open) close(false);
    else if (e.key === " " && !open) {
      e.preventDefault();
      show();
    }
  };

  const sm = size === "sm";

  return (
    <div ref={box} className={`relative ${className}`} onKeyDown={keys}>
      <button
        ref={button}
        type="button"
        disabled={disabled}
        onClick={() => (open ? close() : show())}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={label}
        className={`flex w-full items-center gap-2 rounded-lg border text-left transition outline-none disabled:cursor-not-allowed disabled:opacity-50 ${sm ? "px-2 py-1 text-xs" : "px-3 py-2 text-sm"} ${look.button} ${open ? look.open : ""}`}
      >
        {chosen?.icon}
        <span className={`min-w-0 flex-1 truncate ${mono ? "font-mono" : ""} ${chosen ? "" : "opacity-60"}`}>{chosen?.label ?? placeholder}</span>
        <ChevronDown aria-hidden className={`h-4 w-4 shrink-0 transition ${open ? "rotate-180" : ""} ${look.chevron}`} />
      </button>

      {open && (
        <div className={`absolute left-0 z-50 w-full min-w-[12rem] overflow-hidden rounded-xl border ${look.panel} ${up ? "bottom-full mb-1.5" : "top-full mt-1.5"}`}>
          {canSearch && (
            <div className="relative border-b border-inherit p-2">
              <Search aria-hidden className="pointer-events-none absolute top-1/2 left-4 h-3.5 w-3.5 -translate-y-1/2 opacity-50" />
              <input
                ref={search}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActive(0);
                }}
                placeholder="Search…"
                aria-label="Search the list"
                className={`w-full rounded-md border py-1.5 pr-2.5 pl-7 text-sm outline-none ${look.search}`}
              />
            </div>
          )}
          <ul ref={list} id={id} role="listbox" tabIndex={-1} aria-label={label} className="max-h-72 overflow-y-auto p-1 outline-none">
            {shown.length === 0 && <li className={`px-3 py-2 text-sm ${look.empty}`}>Nothing matches “{query}”.</li>}
            {shown.map((o, i) => {
              const head = o.group && o.group !== shown[i - 1]?.group ? o.group : undefined;
              return (
                <li key={o.value} role="presentation">
                  {head && <div className={`px-2.5 pt-2.5 pb-1 text-[10px] font-semibold tracking-[0.12em] uppercase ${look.group}`}>{head}</div>}
                  <div
                    role="option"
                    aria-selected={o.value === value}
                    aria-disabled={o.disabled}
                    data-index={i}
                    onMouseEnter={() => setActive(i)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => pick(o)}
                    className={`flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm ${i === active ? look.active : ""} ${o.disabled ? "cursor-not-allowed opacity-40" : ""}`}
                  >
                    {o.icon}
                    <span className="min-w-0 flex-1">
                      <span className={`block truncate ${mono ? "font-mono text-[13px]" : ""} ${o.value === value ? "font-medium" : ""}`}>{o.label}</span>
                      {o.hint && <span className={`block truncate text-xs ${look.hint}`}>{o.hint}</span>}
                    </span>
                    {o.value === value && <Check aria-hidden className={`h-4 w-4 shrink-0 ${look.chosen}`} strokeWidth={2.5} />}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

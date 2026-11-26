"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { InnofemmeLogo } from "@/components/brand";

/** The interactive parts of the documentation page: the top bar, the contents that follow your reading, and copyable code. */

export type ContentsPart = { title: string; items: [id: string, label: string][] };

/** The bar across the top, always in view: a clear way back, and the page's name. */
export function DocsHeader({ back, teamLabel }: { back: { href: string; label: string }; teamLabel?: string }) {
  return (
    <header className="sticky top-0 z-30 border-b border-gray-200 bg-white/95 backdrop-blur">
      <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-2.5">
        <Link href={back.href} className="inline-flex shrink-0 items-center gap-2 rounded-lg bg-[#3b1f6e] px-3.5 py-2 text-sm font-semibold text-white shadow-sm hover:bg-[#2e1757]">
          <span aria-hidden>←</span>
          {back.label}
        </Link>
        <div className="ml-1 hidden h-6 w-px bg-gray-200 sm:block" />
        <InnofemmeLogo size={30} />
        <div className="min-w-0 leading-tight">
          <div className="truncate text-sm font-semibold text-gray-900">Documentation</div>
          <div className="truncate text-xs text-gray-500">{teamLabel ? `${teamLabel} · Mobile money sandbox` : "Mobile money sandbox"}</div>
        </div>
      </div>
    </header>
  );
}

/** Watches which section is on screen, so the contents can show where the reader is. */
function useActive(ids: string[]) {
  const [active, setActive] = useState(ids[0]);
  useEffect(() => {
    const seen = new Map<string, boolean>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) seen.set(e.target.id, e.isIntersecting);
        const first = ids.find((id) => seen.get(id));
        if (first) setActive(first);
      },
      { rootMargin: "-80px 0px -65% 0px" },
    );
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) io.observe(el);
    }
    return () => io.disconnect();
  }, [ids]);
  return active;
}

function ContentsList({ parts, active, onPick }: { parts: ContentsPart[]; active?: string; onPick?: () => void }) {
  return (
    <div className="space-y-5">
      {parts.map((part) => (
        <div key={part.title}>
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-gray-400">{part.title}</div>
          <ul className="space-y-0.5 border-l border-gray-200">
            {part.items.map(([id, label]) => (
              <li key={id}>
                <a
                  href={`#${id}`}
                  onClick={onPick}
                  className={`-ml-px block border-l-2 py-1 pl-3 text-sm ${active === id ? "border-[#3b1f6e] font-medium text-[#3b1f6e]" : "border-transparent text-gray-600 hover:border-gray-300 hover:text-gray-900"}`}
                >
                  {label}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/** The contents: a column on wide screens that follows your reading, and a drop-down on small ones. */
export function DocsNav({ parts }: { parts: ContentsPart[] }) {
  const ids = parts.flatMap((p) => p.items.map(([id]) => id));
  const active = useActive(ids);
  const [open, setOpen] = useState(false);
  const current = parts.flatMap((p) => p.items).find(([id]) => id === active)?.[1];
  return (
    <>
      <nav aria-label="On this page" className="hidden lg:block">
        <div className="sticky top-20 max-h-[calc(100vh-6rem)] overflow-y-auto pb-8 pr-2">
          <ContentsList parts={parts} active={active} />
        </div>
      </nav>
      <div className="sticky top-[57px] z-20 -mx-4 mb-2 border-b border-gray-200 bg-white/95 px-4 py-2 backdrop-blur lg:hidden">
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-center justify-between rounded-lg border border-gray-300 bg-white px-3 py-2 text-left text-sm">
          <span className="truncate">
            <span className="text-gray-500">On this page: </span>
            <span className="font-medium text-gray-900">{current}</span>
          </span>
          <span aria-hidden className="ml-2 text-xs text-gray-500">
            {open ? "▲" : "▼"}
          </span>
        </button>
        {open && (
          <div className="mt-2 max-h-[60vh] overflow-y-auto rounded-lg border border-gray-200 bg-white p-4 shadow-lg">
            <ContentsList parts={parts} active={active} onPick={() => setOpen(false)} />
          </div>
        )}
      </div>
    </>
  );
}

/** A block of code or commands, with a button to copy it. */
export function CopyCode({ children, label }: { children: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="group relative my-3 overflow-hidden rounded-xl border border-slate-800 bg-slate-950">
      <div className="flex items-center justify-between border-b border-slate-800 px-3 py-1.5">
        <span className="font-mono text-[11px] text-slate-400">{label ?? "terminal"}</span>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(children);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          className="rounded px-2 py-0.5 text-[11px] font-medium text-slate-300 hover:bg-slate-800 hover:text-white"
        >
          {copied ? "Copied ✓" : "Copy"}
        </button>
      </div>
      <pre className="overflow-x-auto p-3 font-mono text-[12.5px] leading-relaxed text-slate-100">{children}</pre>
    </div>
  );
}

/** One value to copy, such as the team's address or key. */
export function CopyValue({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2">
      <span className="shrink-0 text-xs font-medium text-gray-500">{label}</span>
      <code className="min-w-0 flex-1 truncate font-mono text-[13px] text-gray-900">{value}</code>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard?.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        className="shrink-0 rounded-md border border-gray-200 px-2 py-0.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
      >
        {copied ? "Copied ✓" : "Copy"}
      </button>
    </div>
  );
}

/** Back to the top, once the reader is well down the page. */
export function ToTop() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const on = () => setShow(window.scrollY > 900);
    on();
    window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, []);
  if (!show) return null;
  return (
    <button type="button" onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })} className="fixed bottom-20 right-5 z-30 rounded-full border border-gray-200 bg-white px-3.5 py-2 text-sm font-medium text-gray-700 shadow-lg hover:bg-gray-50">
      ↑ Top
    </button>
  );
}

"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { InnofemmeLogo } from "@/components/brand";
import { ArrowLeft, ArrowUp, Check, ChevronDown, Copy, CornerDownLeft, FileText, Search } from "lucide-react";

/** The interactive parts of the documentation page: the top bar, the contents that follow your reading, and copyable code. */

export type ContentsPart = { title: string; items: [id: string, label: string][] };

/** The bar across the top, always in view: a clear way back, and the page's name. */
export function DocsHeader({ back, teamLabel }: { back: { href: string; label: string }; teamLabel?: string }) {
  return (
    <header className="sticky top-0 z-30 border-b border-gray-200 bg-white/95 backdrop-blur">
      <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-2.5">
        <Link href={back.href} className="inline-flex shrink-0 items-center gap-2 rounded-lg bg-[#3b1f6e] px-3.5 py-2 text-sm font-semibold text-white shadow-sm hover:bg-[#2e1757]">
          <ArrowLeft className="h-4 w-4" aria-hidden />
          {back.label}
        </Link>
        <div className="ml-1 hidden h-6 w-px bg-gray-200 sm:block" />
        <InnofemmeLogo size={30} />
        <div className="min-w-0 leading-tight">
          <div className="truncate text-sm font-semibold text-gray-900">Documentation</div>
          <div className="truncate text-xs text-gray-500">{teamLabel ? `${teamLabel} · Mobile money sandbox` : "Mobile money sandbox"}</div>
        </div>
        <DocsSearch />
      </div>
    </header>
  );
}

interface Found {
  id: string;
  title: string;
  part: string;
  snippet: React.ReactNode;
  score: number;
}

/** Marks the words searched for. */
function mark(text: string, words: string[]) {
  if (!words.length) return text;
  const re = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  return text.split(re).map((p, i) =>
    i % 2 ? (
      <mark key={i} className="rounded-sm bg-amber-200/70 text-gray-900">
        {p}
      </mark>
    ) : (
      p
    ),
  );
}

/** Search across the whole page: every section's heading and text. Opens with ⌘K, Ctrl+K or "/". */
function DocsSearch() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [index, setIndex] = useState<{ id: string; title: string; part: string; text: string }[]>([]);
  const input = useRef<HTMLInputElement>(null);

  const show = () => {
    // What is on the page is read when the search opens, so it always matches what the reader sees.
    const parts = new Map<string, string>();
    document.querySelectorAll("nav[aria-label='On this page'] a[href^='#']").forEach((a) => {
      // The part a section belongs to is the heading just above its list in the contents.
      const part = a.closest("ul")?.previousElementSibling?.textContent ?? "";
      parts.set(a.getAttribute("href")!.slice(1), part.replace(/^\d+\s*·\s*/, ""));
    });
    setIndex(
      [...document.querySelectorAll<HTMLElement>("main section[id]")].map((el) => ({
        id: el.id,
        title: el.querySelector("h2")?.textContent?.replace(/#$/, "").trim() ?? el.id,
        part: parts.get(el.id) ?? "",
        text: (el.innerText || el.textContent || "").replace(/\s+/g, " "),
      })),
    );
    setQuery("");
    setActive(0);
    setOpen(true);
  };

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement)?.closest("input, textarea, [contenteditable]");
      if (((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") || (e.key === "/" && !typing)) {
        e.preventDefault();
        show();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);

  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);

  const words = useMemo(() => query.toLowerCase().split(/\s+/).filter((w) => w.length > 1), [query]);
  const found: Found[] = useMemo(() => {
    if (!words.length) return [];
    return index
      .flatMap((s) => {
        const title = s.title.toLowerCase();
        const text = s.text.toLowerCase();
        if (!words.every((w) => title.includes(w) || text.includes(w))) return [];
        const score = words.reduce((n, w) => n + (title.includes(w) ? 10 : 0) + Math.min(5, text.split(w).length - 1), 0);
        const at = Math.max(0, text.indexOf(words[0]));
        const from = Math.max(0, at - 50);
        const piece = `${from > 0 ? "…" : ""}${s.text.slice(from, at + 110).trim()}…`;
        return [{ id: s.id, title: s.title, part: s.part, snippet: mark(piece, words), score }];
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);
  }, [index, words]);

  const go = (f: Found | undefined) => {
    if (!f) return;
    setOpen(false);
    location.hash = f.id;
    document.getElementById(f.id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <>
      <button type="button" onClick={show} className="ml-auto flex items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-1.5 text-sm text-gray-500 hover:border-gray-300 hover:bg-white sm:w-64">
        <Search className="h-4 w-4" />
        <span className="hidden flex-1 text-left sm:inline">Search the docs…</span>
        <kbd className="hidden rounded border border-gray-200 bg-white px-1.5 font-sans text-[11px] text-gray-400 sm:inline">⌘K</kbd>
      </button>
      {/* Drawn at the level of the page: inside the blurred top bar, "fixed" would only cover the bar. */}
      {open && createPortal(
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-gray-900/40 px-4 pt-[12vh] backdrop-blur-sm" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
          <div className="w-full max-w-xl overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl" role="dialog" aria-label="Search the documentation">
            <div className="flex items-center gap-3 border-b border-gray-100 px-4">
              <Search className="h-5 w-5 shrink-0 text-gray-400" />
              <input
                ref={input}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActive(0);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setOpen(false);
                  else if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setActive((a) => Math.min(a + 1, found.length - 1));
                  } else if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setActive((a) => Math.max(a - 1, 0));
                  } else if (e.key === "Enter") go(found[active]);
                }}
                placeholder="Search: plug-in, SIM swap, team key, payment…"
                className="h-14 flex-1 bg-transparent text-base text-gray-900 outline-none placeholder:text-gray-400"
              />
              <kbd className="rounded border border-gray-200 px-1.5 text-[11px] text-gray-400">Esc</kbd>
            </div>
            <div className="max-h-[60vh] overflow-y-auto p-2">
              {!words.length && <p className="px-3 py-6 text-center text-sm text-gray-500">Type to search every section of the documentation.</p>}
              {words.length > 0 && !found.length && <p className="px-3 py-6 text-center text-sm text-gray-500">Nothing found for “{query}”.</p>}
              {found.map((f, i) => (
                <button
                  key={f.id}
                  type="button"
                  onMouseEnter={() => setActive(i)}
                  onClick={() => go(f)}
                  className={`flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left ${i === active ? "bg-[#f3effa]" : ""}`}
                >
                  <FileText className={`mt-0.5 h-4 w-4 shrink-0 ${i === active ? "text-[#3b1f6e]" : "text-gray-400"}`} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                      <span className="truncate text-sm font-semibold text-gray-900">{f.title}</span>
                      {f.part && <span className="shrink-0 text-[11px] text-gray-400">{f.part}</span>}
                    </span>
                    <span className="mt-0.5 line-clamp-2 block text-[13px] leading-5 text-gray-600">{f.snippet}</span>
                  </span>
                  {i === active && <CornerDownLeft className="mt-0.5 h-4 w-4 shrink-0 text-[#3b1f6e]" />}
                </button>
              ))}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
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
          <ChevronDown aria-hidden className={`ml-2 h-4 w-4 text-gray-500 transition ${open ? "rotate-180" : ""}`} />
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

// ---------- colours for code ----------

const KEYWORDS = new Set(
  "def return if elif else for while in not and or is import from as export function const let var await async new class try except catch finally raise throw with lambda pass yield true false null undefined None True False print curl python3 python node npm pnpm cd jq".split(" "),
);
const VERBS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const TOKENS =
  /((?:^|(?<=\s))(?:#|\/\/)[^\n]*)|("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|(https?:\/\/[^\s"'`)]+|(?:bridge|code):\/\/[^\s"'`)]+)|((?<=\s)--?[a-zA-Z][\w-]*)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)/gm;

const STYLE: Record<string, string> = {
  comment: "text-slate-500 italic",
  string: "text-emerald-300",
  key: "text-sky-300",
  url: "text-teal-300",
  flag: "text-orange-300",
  number: "text-amber-300",
  keyword: "text-fuchsia-300",
  verb: "font-semibold text-rose-300",
  call: "text-blue-300",
};

/** Splits code into coloured pieces: comments, strings, keys, addresses, flags, numbers, keywords and function calls. */
export function highlight(code: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const m of code.matchAll(TOKENS)) {
    const at = m.index ?? 0;
    if (at > last) out.push(code.slice(last, at));
    const text = m[0];
    // Groups, in order: comment, string, address, flag, number, word.
    const [, comment, str, url, flag, num, word] = m;
    let kind: string | undefined;
    if (comment) kind = "comment";
    else if (str) kind = /^\s*:/.test(code.slice(at + text.length)) ? "key" : "string";
    else if (url) kind = "url";
    else if (flag) kind = "flag";
    else if (num) kind = "number";
    else if (word) kind = VERBS.has(text) ? "verb" : KEYWORDS.has(text) ? "keyword" : code[at + text.length] === "(" ? "call" : undefined;
    out.push(kind ? (
      <span key={n++} className={STYLE[kind]}>
        {text}
      </span>
    ) : (
      text
    ));
    last = at + text.length;
  }
  if (last < code.length) out.push(code.slice(last));
  return out;
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
          <span className="flex items-center gap-1">{copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>
      <pre className="overflow-x-auto p-3 font-mono text-[12.5px] leading-relaxed text-slate-200">{highlight(children)}</pre>
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
      <span className="flex items-center gap-1.5"><ArrowUp className="h-4 w-4" /> Top</span>
    </button>
  );
}

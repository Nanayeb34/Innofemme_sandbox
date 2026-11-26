"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Eraser, PanelRightClose, PanelRightOpen, Play, Plus, Redo2, RotateCw, Search, Undo2, AArrowDown, AArrowUp } from "lucide-react";
import { CodeEditor, type CodeEditorHandle, type EditorInfo } from "@/components/code-editor";
import { LangLogo } from "@/components/lang-logo";
import { Select } from "@/components/select";
import { Loading, Shell, useView } from "@/components/ui";
import { api, when } from "@/lib/client";
import { TEMPLATES, type Lang } from "./developer-templates";
import { askConfirm, usePrefs } from "@/stores/ui";

interface Institution {
  id: string;
  name: string;
  group: string;
  points: { point: string; when: string; answers: string[] }[];
}

interface Overview {
  enabled: boolean;
  languages: Record<Lang, boolean>;
  institutions: Institution[];
  plugins: { id: string; name: string; language: Lang; address: string; status: string; places: number; updatedAt: number }[];
}

interface Detail {
  id: string;
  name: string;
  language: Lang;
  source: string;
  address: string;
  updatedAt: number;
  run: { status: string; error: string | null; calls: number; logs: { at: string; kind: "out" | "err" | "info"; text: string }[] };
  places: { id: string; institution: string; institutionName: string; point: string; when: string; enabled: boolean; calls: number; ifDown: string }[];
  calls: { at: string; institutionName: string; point: string; decision: string; message: string | null; ms: number }[];
}

const LANG: Record<Lang, { label: string; file: string }> = {
  javascript: { label: "JavaScript", file: "plugin.mjs" },
  python: { label: "Python", file: "plugin.py" },
};
const STATUS: Record<string, { label: string; dot: string }> = {
  running: { label: "Running", dot: "bg-emerald-400" },
  starting: { label: "Starting", dot: "bg-amber-400" },
  stopped: { label: "Idle", dot: "bg-gray-300" },
  failed: { label: "Cannot start", dot: "bg-rose-500" },
};
const NEW = "__new__";

/** Where teams write their own plug-ins in JavaScript or Python, try them, and plug them into any institution. Laid out like a code editor. */
export default function Developer({ team }: { team: string }) {
  const { data, error, refresh } = useView<Overview>(team, "/code", 5000);
  const [chosen, setChosen] = useState<string | null>(null);
  if (!data) return <Loading error={error} />;
  const selected = chosen && (chosen === NEW || data.plugins.some((p) => p.id === chosen)) ? chosen : (data.plugins[0]?.id ?? NEW);

  return (
    <Shell team={team} title="Developer console" subtitle="Write your own plug-ins" color="#ffffff" textOn="#111827" bare>
      {!data.enabled ? (
        <div className="m-6 rounded-xl border border-gray-200 bg-white p-5 text-sm text-gray-700">Running your own code is switched off on this server. You can still plug in an API you run yourself, from any institution&apos;s Plug-ins tab.</div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col bg-gray-50 text-gray-700 lg:h-[calc(100dvh-63px)] lg:flex-none lg:flex-row">
          <Explorer team={team} plugins={data.plugins} selected={selected} onPick={setChosen} />
          {selected === NEW ? (
            <NewPlugin
              team={team}
              languages={data.languages}
              hasAny={data.plugins.length > 0}
              onMade={(id) => {
                setChosen(id);
                refresh();
              }}
            />
          ) : (
            <Workspace key={selected} team={team} id={selected} institutions={data.institutions} onChange={refresh} onDeleted={() => (setChosen(null), refresh())} />
          )}
        </div>
      )}
    </Shell>
  );
}

// ---------- the file list on the left ----------

function Explorer({ team, plugins, selected, onPick }: { team: string; plugins: Overview["plugins"]; selected: string; onPick: (id: string) => void }) {
  return (
    <aside className="flex shrink-0 flex-col border-b border-gray-200 bg-white lg:w-56 lg:border-r lg:border-b-0 xl:w-64">
      <div className="flex items-center justify-between px-4 pt-4 pb-2">
        <span className="text-[11px] font-semibold tracking-[0.14em] text-gray-500 uppercase">Plug-ins</span>
        <button type="button" onClick={() => onPick(NEW)} title="New plug-in" className={`rounded-md px-2 py-0.5 text-sm font-semibold ${selected === NEW ? "bg-[#3b1f6e] text-white" : "text-gray-700 hover:bg-gray-100 hover:text-gray-900"}`}>
          <span className="flex items-center gap-1"><Plus className="h-3.5 w-3.5" strokeWidth={2.5} /> New</span>
        </button>
      </div>
      <nav className="flex gap-1 overflow-x-auto px-2 pb-2 lg:flex-1 lg:flex-col lg:overflow-y-auto">
        {plugins.length === 0 && <p className="px-2 py-2 text-xs text-gray-500">No plug-ins yet.</p>}
        {plugins.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => onPick(p.id)}
            className={`group flex min-w-48 items-center gap-2.5 rounded-lg px-2.5 py-2 text-left lg:min-w-0 ${selected === p.id ? "bg-[#f3effa] text-[#3b1f6e]" : "text-gray-700 hover:bg-gray-100"}`}
          >
            <LangLogo language={p.language} size={20} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{p.name}</span>
              <span className="block truncate text-[11px] text-gray-500">{p.places ? `Plugged in · ${p.places} place${p.places === 1 ? "" : "s"}` : "Not plugged in"}</span>
            </span>
            <span className={`h-2 w-2 shrink-0 rounded-full ${STATUS[p.status]?.dot ?? "bg-slate-500"}`} title={STATUS[p.status]?.label} />
          </button>
        ))}
      </nav>
      <div className="hidden border-t border-gray-200 p-4 text-xs leading-5 text-gray-500 lg:block">
        Write <code className="text-gray-700">decide(point, data, ctx)</code>, save, test, then plug it in.{" "}
        <Link href={`/t/${team}/docs#developer`} className="text-[#3b1f6e] hover:underline">
          Read the guide →
        </Link>
      </div>
    </aside>
  );
}

// ---------- making a new plug-in ----------

function NewPlugin({ team, languages, hasAny, onMade }: { team: string; languages: Record<Lang, boolean>; hasAny: boolean; onMade: (id: string) => void }) {
  const [name, setName] = useState("");
  const [lang, setLang] = useState<Lang>("javascript");
  const [template, setTemplate] = useState(TEMPLATES[1].id);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const t = TEMPLATES.find((x) => x.id === template) ?? TEMPLATES[0];
  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<{ id: string }>(team, "/code", { body: { name: name.trim() || t.label, language: lang, source: t.source[lang] } });
      onMade(r.id);
    } catch (err) {
      setMsg((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <form onSubmit={create} className="mx-auto max-w-3xl px-6 py-10">
        <h2 className="text-2xl font-semibold tracking-tight text-gray-900">{hasAny ? "New plug-in" : "Your first plug-in"}</h2>
        <p className="mt-2 text-sm leading-6 text-gray-500">Write code here and the sandbox runs it: no server of your own. Then plug it into any step of a network, a bank or the national switch.</p>

        <div className="mt-8 grid gap-5 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-gray-500">Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t.label} className="input" />
          </label>
          <div>
            <span className="mb-1.5 block text-xs font-medium text-gray-500">Language</span>
            <div className="grid grid-cols-2 gap-2">
              {(["javascript", "python"] as Lang[]).map((l) => (
                <label key={l} className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm ${lang === l ? "border-[#3b1f6e] bg-[#f3effa] text-gray-900" : "border-gray-300 text-gray-700 hover:border-gray-400"} ${languages[l] ? "" : "pointer-events-none opacity-40"}`}>
                  <input type="radio" name="lang" className="sr-only" checked={lang === l} disabled={!languages[l]} onChange={() => setLang(l)} />
                  <LangLogo language={l} size={18} />
                  {LANG[l].label}
                </label>
              ))}
            </div>
            {!languages.python && <p className="mt-1 text-xs text-gray-500">Python is not installed on this server.</p>}
          </div>
        </div>

        <div className="mt-6">
          <span className="mb-1.5 block text-xs font-medium text-gray-500">Start from</span>
          <div className="grid gap-3 md:grid-cols-3">
            {TEMPLATES.map((x) => (
              <label key={x.id} className={`flex cursor-pointer flex-col rounded-xl border p-4 transition ${template === x.id ? "border-[#3b1f6e] bg-[#f3effa]" : "border-gray-300 hover:border-gray-400"}`}>
                <input type="radio" name="template" className="sr-only" checked={template === x.id} onChange={() => setTemplate(x.id)} />
                <span className="text-sm font-semibold text-gray-900">{x.label}</span>
                <span className="mt-1 text-xs leading-5 text-gray-500">{x.about}</span>
              </label>
            ))}
          </div>
        </div>

        <div className="mt-8 flex flex-wrap items-center gap-3">
          <button className="btn-run !px-4 !py-2 !text-sm" disabled={busy}>
            {busy ? "Creating…" : "Create plug-in"}
          </button>
          {msg && <span className="text-sm text-rose-700">{msg}</span>}
        </div>
      </form>
    </div>
  );
}

// ---------- editing one plug-in ----------

function Workspace({ team, id, institutions, onChange, onDeleted }: { team: string; id: string; institutions: Institution[]; onChange: () => void; onDeleted: () => void }) {
  const { data, error, refresh } = useView<Detail>(team, `/code/${id}`, 2500);
  const editor = useRef<CodeEditorHandle>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [info, setInfo] = useState<EditorInfo>({ line: 1, column: 1, lines: 0, canUndo: false, canRedo: false });
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [side, setSide] = useState<"plug" | "test" | "settings">("plug");
  // Layout and text size are preferences, kept in the shared store and remembered between visits.
  const prefs = usePrefs();
  const wide = typeof window === "undefined" || window.innerWidth >= 1280 || window.innerWidth < 1024;
  const sideOpen = prefs.devSide ?? wide;
  const setSideOpen = (f: (o: boolean) => boolean) => prefs.set({ devSide: f(sideOpen) });
  const [bottom, setBottom] = useState<"output" | "questions">("output");
  const bottomOpen = prefs.devBottom;
  const setBottomOpen = (o: boolean) => prefs.set({ devBottom: o });
  const size = prefs.codeSize;
  const resize = (by: number) => prefs.set({ codeSize: Math.min(20, Math.max(10, size + by)) });
  if (!data || data.id !== id) return <div className="flex flex-1 items-center justify-center text-sm text-gray-500">{error ?? "Opening…"}</div>;
  const text = draft ?? data.source;
  const dirty = text !== data.source;
  const st = STATUS[data.run.status] ?? STATUS.stopped;
  const save = async () => {
    if (saving) return;
    setSaving(true);
    setNote(null);
    try {
      const r = await api<{ started: { ok: boolean; error?: string } }>(team, `/code/${id}`, { method: "PUT", body: { source: text } });
      setNote(r.started.ok ? { ok: true, text: "Saved · running" } : { ok: false, text: r.started.error ?? "Saved, but it could not start" });
      await refresh();
      setDraft(null);
      onChange();
    } catch (e) {
      setNote({ ok: false, text: (e as Error).message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col lg:flex-row">
      {/* centre: toolbar, editor, output, status bar */}
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-1 overflow-x-auto border-b border-gray-200 bg-white px-2 py-1.5">
          <div className="mr-auto flex min-w-0 items-center gap-2 rounded-t-md border-b-2 border-[#3b1f6e] px-3 py-1.5 text-sm text-gray-900">
            <LangLogo language={data.language} size={18} />
            <span className="truncate font-medium">{data.name}</span>
            <span className="hidden font-mono text-xs text-gray-500 2xl:inline">{LANG[data.language].file}</span>
            {dirty && <span className="h-2 w-2 rounded-full bg-amber-400" title="Unsaved changes" />}
          </div>
          <button type="button" className="btn-ide" disabled={!info.canUndo} onClick={() => editor.current?.undo()} title="Undo (⌘Z / Ctrl+Z)">
            <Undo2 className="h-4 w-4" />
            <span className="hidden 2xl:inline">Undo</span>
          </button>
          <button type="button" className="btn-ide" disabled={!info.canRedo} onClick={() => editor.current?.redo()} title="Redo (⇧⌘Z / Ctrl+Y)">
            <Redo2 className="h-4 w-4" />
            <span className="hidden 2xl:inline">Redo</span>
          </button>
          <button type="button" className="btn-ide" onClick={() => editor.current?.find()} title="Find and replace (⌘F / Ctrl+F)">
            <Search className="h-4 w-4" />
            <span className="hidden 2xl:inline">Find</span>
          </button>
          <span className="mx-1 h-5 w-px bg-gray-200" />
          <button type="button" className="btn-ide" disabled={size <= 10} onClick={() => resize(-1)} title="Smaller text">
            <AArrowDown className="h-4 w-4" />
          </button>
          <span className="hidden w-8 text-center text-[11px] text-gray-500 tabular-nums xl:inline">{size}px</span>
          <button type="button" className="btn-ide" disabled={size >= 20} onClick={() => resize(1)} title="Larger text">
            <AArrowUp className="h-4 w-4" />
          </button>
          <span className="mx-1 h-5 w-px bg-gray-200" />
          <button type="button" className="btn-ide" onClick={() => void api(team, `/code/${id}`, { body: { action: "restart" } }).then(refresh)} title="Stop and start the saved code">
            <RotateCw className="h-4 w-4" />
            <span className="hidden 2xl:inline">Restart</span>
          </button>
          <button type="button" className="btn-run ml-1 shrink-0 whitespace-nowrap" disabled={!dirty || saving} onClick={save} title="Save and run (⌘S / Ctrl+S)">
            <Play className="h-3.5 w-3.5 fill-current" /> {saving ? "Saving…" : dirty ? "Save and run" : "Saved"}
          </button>
          <button type="button" className="btn-ide hidden lg:inline-flex" onClick={() => setSideOpen((o) => !o)} title={sideOpen ? "Hide the side panel" : "Show the side panel"}>
            {sideOpen ? <PanelRightClose className="h-4 w-4" /> : (
              <>
                <PanelRightOpen className="h-4 w-4" /> Plug in · Test
              </>
            )}
          </button>
        </div>

        {data.run.error && (
          <div className="flex items-start gap-2 border-b border-rose-200 bg-rose-50 px-4 py-2 font-mono text-xs text-rose-800">
            <span className="font-sans font-semibold">Error</span>
            <span className="min-w-0 break-words">{data.run.error}</span>
          </div>
        )}

        <div className="h-[60vh] min-h-0 lg:h-auto lg:flex-1" style={{ ["--code-size" as string]: `${size}px` }}>
          <CodeEditor ref={editor} initial={data.source} language={data.language} onChange={setDraft} onSave={() => dirty && void save()} onInfo={setInfo} />
        </div>

        <BottomPanel team={team} id={id} data={data} tab={bottom} setTab={setBottom} open={bottomOpen} setOpen={setBottomOpen} onChange={refresh} size={Math.max(10, size - 1.5)} />

        <footer className="flex flex-wrap items-center gap-x-4 gap-y-1 bg-[#3b1f6e] px-3 py-1 text-[11px] text-white/90">
          <span className="flex items-center gap-1.5">
            <span className={`h-2 w-2 rounded-full ${st.dot}`} />
            {st.label}
          </span>
          <span>{data.places.length ? `Plugged in at ${data.places.length} place${data.places.length === 1 ? "" : "s"}` : "Not plugged in"}</span>
          <span>{data.run.calls} question(s) answered</span>
          {note && <span className={note.ok ? "text-emerald-200" : "text-rose-200"}>{note.text}</span>}
          <span className="ml-auto">
            Ln {info.line}, Col {info.column}
          </span>
          <span>{data.language === "python" ? "Spaces: 4" : "Spaces: 2"}</span>
          <span>{LANG[data.language].label}</span>
          <span>{dirty ? "● Unsaved" : "Saved"}</span>
        </footer>
      </section>

      {/* right: plug in, test, settings */}
      {sideOpen && (
        <aside className="flex shrink-0 flex-col border-t border-gray-200 bg-white lg:w-80 lg:border-t-0 lg:border-l 2xl:w-[23rem]">
          <div className="flex border-b border-gray-200 px-2">
            {(
              [
                ["plug", "Plug in"],
                ["test", "Test"],
                ["settings", "Settings"],
              ] as const
            ).map(([k, label]) => (
              <button key={k} type="button" onClick={() => setSide(k)} className={`-mb-px border-b-2 px-3 py-2.5 text-xs font-semibold tracking-wide uppercase ${side === k ? "border-[#3b1f6e] text-gray-900" : "border-transparent text-gray-500 hover:text-gray-800"}`}>
                {label}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {side === "plug" && <PlugIn team={team} id={id} institutions={institutions} places={data.places} onChange={() => (refresh(), onChange())} />}
            {side === "test" && <TryIt team={team} id={id} institutions={institutions} dirty={dirty} onDone={refresh} />}
            {side === "settings" && <Settings team={team} data={data} onChange={() => (refresh(), onChange())} onDeleted={onDeleted} />}
          </div>
        </aside>
      )}
    </div>
  );
}

function BottomPanel({ team, id, data, tab, setTab, open, setOpen, onChange, size }: { team: string; id: string; data: Detail; tab: "output" | "questions"; setTab: (t: "output" | "questions") => void; open: boolean; setOpen: (o: boolean) => void; onChange: () => void; size: number }) {
  const box = useRef<HTMLDivElement>(null);
  const count = data.run.logs.length;
  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [count, tab, open]);
  const errors = data.run.logs.filter((l) => l.kind === "err").length;
  return (
    <div className="flex shrink-0 flex-col border-t border-gray-200 bg-white">
      <div className="flex items-center gap-1 px-2">
        {(
          [
            ["output", "Output", count],
            ["questions", "Questions", data.calls.length],
          ] as const
        ).map(([k, label, n]) => (
          <button
            key={k}
            type="button"
            onClick={() => {
              setTab(k);
              setOpen(true);
            }}
            className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-xs font-semibold tracking-wide uppercase ${open && tab === k ? "border-[#3b1f6e] text-gray-900" : "border-transparent text-gray-500 hover:text-gray-800"}`}
          >
            {label}
            {n > 0 && <span className={`rounded-full px-1.5 text-[10px] ${k === "output" && errors ? "bg-rose-500/20 text-rose-300" : "bg-gray-200 text-gray-700"}`}>{n}</span>}
          </button>
        ))}
        <span className="ml-auto flex items-center gap-1">
          {tab === "output" && open && (
            <button type="button" className="btn-ide" onClick={() => void api(team, `/code/${id}`, { body: { action: "clear_logs" } }).then(onChange)} title="Clear the output">
              <Eraser className="h-3.5 w-3.5" /> Clear
            </button>
          )}
          <button type="button" className="btn-ide" onClick={() => setOpen(!open)} title={open ? "Hide the panel" : "Show the panel"}>
            {open ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
          </button>
        </span>
      </div>
      {open && (
        <div ref={box} className="h-44 overflow-auto bg-[#282c34] px-4 py-2 font-mono leading-[1.6]" style={{ fontSize: `${size}px` }}>
          {tab === "output" ? (
            count === 0 ? (
              <span className="text-[#5c6370]">console.log() / print() output and errors appear here.</span>
            ) : (
              data.run.logs.map((l, i) => (
                <div key={i} className={l.kind === "err" ? "whitespace-pre-wrap text-[#e06c75]" : l.kind === "info" ? "text-[#7f848e] italic" : "whitespace-pre-wrap text-[#abb2bf]"}>
                  <span className="mr-3 text-[#5c6370] select-none">{when(l.at, false)}</span>
                  {l.text}
                </div>
              ))
            )
          ) : data.calls.length === 0 ? (
            <span className="font-sans text-[#7f848e]">Once it is plugged in, every question an institution asks it, and the answer, shows here.</span>
          ) : (
            <table className="w-full font-sans">
              <tbody>
                {data.calls.map((c, i) => (
                  <tr key={i} className="border-b border-[#3a3f4b] align-top">
                    <td className="py-1.5 pr-3 whitespace-nowrap text-[#7f848e]">{when(c.at)}</td>
                    <td className="py-1.5 pr-3 whitespace-nowrap text-[#abb2bf]">
                      {c.institutionName} · <span className="font-mono text-[#61afef]">{c.point}</span>
                    </td>
                    <td className="py-1.5 pr-3">
                      <Decision value={c.decision} />
                    </td>
                    <td className="w-full py-1.5 pr-3 text-[#abb2bf]">{c.message}</td>
                    <td className="py-1.5 text-right whitespace-nowrap text-[#5c6370]">{c.ms} ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

function Decision({ value }: { value: string }) {
  const tone = value === "allow" || value === "sent" ? "bg-emerald-500/15 text-emerald-300" : value === "error" || value === "reject" ? "bg-rose-500/15 text-rose-300" : "bg-amber-500/15 text-amber-700";
  return <span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${tone}`}>{value}</span>;
}

// ---------- side panel ----------

function Field({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-gray-500">{label}</span>
      {children}
      {hint && <span className="mt-1.5 block text-[11px] leading-4 text-gray-500">{hint}</span>}
    </label>
  );
}

function InstitutionSelect({ institutions, value, onChange }: { institutions: Institution[]; value: string; onChange: (v: string) => void }) {
  return <Select value={value} onChange={onChange} label="Institution" options={institutions.map((i) => ({ value: i.id, label: i.name, group: i.group }))} />;
}

function PointSelect({ points, value, onChange }: { points: Institution["points"]; value: string; onChange: (v: string) => void }) {
  return <Select value={value} onChange={onChange} label="Step" mono options={points.map((p) => ({ value: p.point, label: p.point, hint: p.when }))} />;
}

function Message({ msg }: { msg: { ok: boolean; text: string } | null }) {
  if (!msg) return null;
  return <p className={`mt-3 rounded-lg px-3 py-2 text-xs ${msg.ok ? "bg-emerald-50 text-emerald-800" : "bg-rose-50 text-rose-800"}`}>{msg.text}</p>;
}

function PlugIn({ team, id, institutions, places, onChange }: { team: string; id: string; institutions: Institution[]; places: Detail["places"]; onChange: () => void }) {
  const [institution, setInstitution] = useState(institutions[0]?.id ?? "mtn");
  const inst = institutions.find((i) => i.id === institution) ?? institutions[0];
  const [point, setPoint] = useState("payment.authorize");
  const p = inst.points.find((x) => x.point === point) ?? inst.points[0];
  const [ifDown, setIfDown] = useState("carry_on");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const go = async () => {
    setMsg(null);
    try {
      const r = await api<{ message: string }>(team, `/code/${id}`, { body: { action: "plug", institution: inst.id, point: p.point, ifDown } });
      setMsg({ ok: true, text: r.message });
      onChange();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  };
  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold text-gray-900">Plug it in</h3>
        <p className="mt-1 text-xs leading-5 text-gray-500">The institution will ask your code at this step, every time it happens.</p>
        <div className="mt-4 space-y-4">
          <Field label="Institution">
            <InstitutionSelect institutions={institutions} value={inst.id} onChange={setInstitution} />
          </Field>
          <Field
            label="Step"
            hint={
              <>
                {p.when}. {p.answers.length ? <>Answers: {p.answers.join(", ")}.</> : "For information only: the answer is ignored."}
              </>
            }
          >
            <PointSelect points={inst.points} value={p.point} onChange={setPoint} />
          </Field>
          <Field label="If your code fails or is slow">
            <Select
              value={ifDown}
              onChange={setIfDown}
              label="If your code fails or is slow"
              options={[
                { value: "carry_on", label: "Carry on, as if it allowed", hint: "Customers are never held up by a bug" },
                { value: "refuse", label: "Refuse, to be safe", hint: "Nothing goes through unchecked" },
              ]}
            />
          </Field>
          <button type="button" className="btn-run w-full justify-center !py-2 !text-sm" onClick={go}>
            Plug in
          </button>
        </div>
        <Message msg={msg} />
      </div>

      <div>
        <div className="mb-2 text-[11px] font-semibold tracking-[0.14em] text-gray-500 uppercase">Plugged in at</div>
        {places.length === 0 ? (
          <p className="rounded-lg border border-dashed border-gray-300 px-3 py-4 text-center text-xs text-gray-500">Nowhere yet.</p>
        ) : (
          <ul className="space-y-2">
            {places.map((x) => (
              <li key={x.id} className="flex items-center gap-3 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2.5">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-gray-800">{x.institutionName}</span>
                  <span className="block truncate font-mono text-[11px] text-gray-500">{x.point}</span>
                  <span className="block text-[11px] text-gray-500">
                    {x.calls} question(s) · if it fails: {x.ifDown === "refuse" ? "refuse" : "carry on"}
                  </span>
                </span>
                <button type="button" className="btn-ide !text-rose-700 hover:!bg-rose-50" onClick={() => void api(team, `/code/${id}`, { body: { action: "unplug", integration: x.id } }).then(onChange)}>
                  Unplug
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function TryIt({ team, id, institutions, dirty, onDone }: { team: string; id: string; institutions: Institution[]; dirty: boolean; onDone: () => void }) {
  const mtn = institutions[0];
  const [point, setPoint] = useState("payment.authorize");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; answer?: unknown; error?: string; ms: number; sent: unknown; problem?: string } | null>(null);
  const run = async () => {
    setBusy(true);
    try {
      setResult(await api(team, `/code/${id}`, { body: { action: "try", point, institution: mtn.id } }));
      onDone();
    } catch (e) {
      setResult({ ok: false, error: (e as Error).message, ms: 0, sent: null });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <h3 className="text-sm font-semibold text-gray-900">Test</h3>
      <p className="mt-1 text-xs leading-5 text-gray-500">Sends your code the example a network sends at a step. Nothing happens for real.</p>
      <div className="mt-4 space-y-4">
        <Field label="Step" hint={mtn.points.find((x) => x.point === point)?.when}>
          <PointSelect points={mtn.points} value={point} onChange={setPoint} />
        </Field>
        <button type="button" className="btn-run w-full justify-center !py-2 !text-sm" disabled={busy} onClick={run}>
          {busy ? "Asking…" : (
            <>
              <Play className="h-3.5 w-3.5 fill-current" /> Send a test
            </>
          )}
        </button>
        {dirty && <p className="text-[11px] text-amber-700">You have unsaved changes: the saved version answers.</p>}
      </div>
      {result && (
        <div className="mt-5 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold tracking-[0.14em] text-gray-500 uppercase">Answer</span>
            <span className="text-[11px] text-gray-500">{result.ms} ms</span>
          </div>
          {result.ok ? (
            <pre className={`overflow-x-auto rounded-lg border p-3 font-mono text-xs leading-5 whitespace-pre-wrap ${result.problem ? "border-amber-200 bg-amber-50 text-amber-900" : "border-emerald-200 bg-emerald-50 text-emerald-900"}`}>
              {JSON.stringify(result.answer, null, 2)}
            </pre>
          ) : (
            <p className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800">{result.error}</p>
          )}
          {result.problem && <p className="text-[11px] text-amber-700">{result.problem}</p>}
          {result.sent !== null && (
            <details className="group">
              <summary className="cursor-pointer text-xs text-gray-500 hover:text-gray-900">What was sent as data</summary>
              <pre className="mt-2 max-h-72 overflow-auto rounded-lg bg-[#0b1120] p-3 font-mono text-[11px] leading-5 text-gray-800">{JSON.stringify(result.sent, null, 2)}</pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

function Settings({ team, data, onChange, onDeleted }: { team: string; data: Detail; onChange: () => void; onDeleted: () => void }) {
  const [name, setName] = useState(data.name);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const rename = async () => {
    try {
      await api(team, `/code/${data.id}`, { method: "PUT", body: { name } });
      setMsg({ ok: true, text: "Renamed." });
      onChange();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  };
  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold text-gray-900">Settings</h3>
        <div className="mt-4 space-y-4">
          <Field label="Name">
            <div className="flex gap-2">
              <input value={name} onChange={(e) => setName(e.target.value)} className="input" />
              <button type="button" className="btn-ide border border-gray-300" disabled={!name.trim() || name === data.name} onClick={rename}>
                Rename
              </button>
            </div>
          </Field>
          <Field label="Address" hint="Also works in any institution's Plug-ins tab, as an API address.">
            <div className="flex items-center gap-2 rounded-lg border border-gray-300 bg-gray-50 px-3 py-2">
              <code className="min-w-0 flex-1 truncate font-mono text-xs text-gray-800">{data.address}</code>
              <button
                type="button"
                className="text-xs text-[#3b1f6e] hover:underline"
                onClick={() => {
                  void navigator.clipboard?.writeText(data.address);
                  setCopied(true);
                }}
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          </Field>
          <Field label="Language">
            <div className="text-sm text-gray-800">
              {LANG[data.language].label} <span className="font-mono text-xs text-gray-500">({LANG[data.language].file})</span>
            </div>
          </Field>
        </div>
        <Message msg={msg} />
      </div>

      <div className="space-y-3 border-t border-gray-200 pt-5">
        <div className="text-[11px] font-semibold tracking-[0.14em] text-gray-500 uppercase">Danger zone</div>
        <button
          type="button"
          className="btn-ide w-full justify-center border border-gray-300"
          onClick={async () =>
            (await askConfirm({ title: "Empty the store?", message: "Everything this plug-in has kept in ctx.store is removed. Its code stays.", confirm: "Empty it", danger: true })) &&
            void api(team, `/code/${data.id}`, { body: { action: "clear_store" } }).then(() => setMsg({ ok: true, text: "The store is empty." }))
          }
        >
          Empty its store
        </button>
        <button
          type="button"
          className="btn-ide w-full justify-center border border-rose-200 !text-rose-700 hover:!bg-rose-50"
          onClick={async () => {
            if (!(await askConfirm({ title: `Delete "${data.name}"?`, message: "It is unplugged everywhere and its code is gone for good.", confirm: "Delete plug-in", danger: true }))) return;
            await api(team, `/code/${data.id}`, { method: "DELETE" });
            onDeleted();
          }}
        >
          Delete plug-in
        </button>
      </div>
    </div>
  );
}

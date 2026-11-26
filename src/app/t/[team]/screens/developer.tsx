"use client";

import { useEffect, useRef, useState } from "react";
import { Badge, Loading, Shell, useView } from "@/components/ui";
import { api, when } from "@/lib/client";
import { TEMPLATES, type Lang } from "./developer-templates";

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

const LANG_LABEL: Record<Lang, string> = { javascript: "JavaScript", python: "Python" };
const LANG_SHORT: Record<Lang, string> = { javascript: "JS", python: "PY" };
const STATUS: Record<string, { label: string; dot: string }> = {
  running: { label: "Running", dot: "bg-green-500" },
  starting: { label: "Starting", dot: "bg-amber-400" },
  stopped: { label: "Idle: starts with the next question", dot: "bg-gray-300" },
  failed: { label: "Cannot start", dot: "bg-red-500" },
};
const NEW = "__new__";

/** Where teams write their own plug-ins in JavaScript or Python, try them, and plug them into any institution. */
export default function Developer({ team }: { team: string }) {
  const { data, error, refresh } = useView<Overview>(team, "/code", 5000);
  const [chosen, setChosen] = useState<string | null>(null);
  if (!data) return <Loading error={error} />;
  const selected = chosen && (chosen === NEW || data.plugins.some((p) => p.id === chosen)) ? chosen : (data.plugins[0]?.id ?? NEW);

  return (
    <Shell team={team} title="Developer console" subtitle="Write your own plug-ins" color="#0f172a">
      {!data.enabled ? (
        <div className="card p-5 text-sm text-gray-700">Running your own code is switched off on this server. You can still plug in an API you run yourself, from any institution&apos;s Plug-ins tab.</div>
      ) : (
        <div className="grid gap-5 lg:grid-cols-[17rem_minmax(0,1fr)]">
          <aside className="space-y-3">
            <button type="button" onClick={() => setChosen(NEW)} className={`btn w-full justify-center ${selected === NEW ? "btn-dark" : ""}`}>
              + New plug-in
            </button>
            <div className="card divide-y divide-gray-100 overflow-hidden">
              {data.plugins.length === 0 && <p className="p-4 text-sm text-gray-500">No plug-ins yet. Make your first one.</p>}
              {data.plugins.map((p) => (
                <button key={p.id} type="button" onClick={() => setChosen(p.id)} className={`block w-full px-4 py-3 text-left hover:bg-gray-50 ${selected === p.id ? "bg-slate-50 shadow-[inset_3px_0_0_#0f172a]" : ""}`}>
                  <span className="flex items-center gap-2">
                    <span className={`h-2 w-2 shrink-0 rounded-full ${STATUS[p.status]?.dot ?? "bg-gray-300"}`} />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-gray-900">{p.name}</span>
                    <Badge tone={p.language === "python" ? "blue" : "amber"}>{LANG_SHORT[p.language]}</Badge>
                  </span>
                  <span className="mt-0.5 block pl-4 text-xs text-gray-500">{p.places ? `Plugged in at ${p.places} place${p.places === 1 ? "" : "s"}` : "Not plugged in yet"}</span>
                </button>
              ))}
            </div>
            <HowItWorks />
          </aside>

          <div className="min-w-0">
            {selected === NEW ? (
              <NewPlugin
                team={team}
                languages={data.languages}
                onMade={(id) => {
                  setChosen(id);
                  refresh();
                }}
              />
            ) : (
              <Editor key={selected} team={team} id={selected} institutions={data.institutions} onChange={refresh} onDeleted={() => (setChosen(null), refresh())} />
            )}
          </div>
        </div>
      )}
    </Shell>
  );
}

function HowItWorks() {
  return (
    <div className="card p-4 text-xs leading-relaxed text-gray-600">
      <div className="mb-1 font-semibold text-gray-900">How it works</div>
      <ol className="list-decimal space-y-1 pl-4">
        <li>Write a function <code>decide(point, data, ctx)</code> in JavaScript or Python.</li>
        <li>Save. The sandbox runs it for you: no server of your own needed.</li>
        <li>Try it with the example an institution would send.</li>
        <li>Plug it into a network, a bank or the switch, at the step you choose. From then on that step asks your code.</li>
      </ol>
    </div>
  );
}

function NewPlugin({ team, languages, onMade }: { team: string; languages: Record<Lang, boolean>; onMade: (id: string) => void }) {
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
    <form onSubmit={create} className="card p-5">
      <h2 className="text-lg font-semibold text-gray-900">New plug-in</h2>
      <p className="mt-1 text-sm text-gray-600">Write the code here and the sandbox runs it. You can then plug it into any step of any network, bank or the national switch.</p>

      <label className="mt-5 block text-sm">
        <span className="font-medium text-gray-700">Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t.label} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
      </label>

      <fieldset className="mt-4">
        <legend className="text-sm font-medium text-gray-700">Language</legend>
        <div className="mt-1 flex flex-wrap gap-2">
          {(["javascript", "python"] as Lang[]).map((l) => (
            <label key={l} className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm ${lang === l ? "border-slate-900 bg-slate-50 font-medium" : "border-gray-300"} ${languages[l] ? "" : "cursor-not-allowed opacity-50"}`}>
              <input type="radio" name="lang" className="sr-only" checked={lang === l} disabled={!languages[l]} onChange={() => setLang(l)} />
              {LANG_LABEL[l]} <span className="font-mono text-xs text-gray-500">{l === "python" ? ".py" : ".mjs"}</span>
            </label>
          ))}
        </div>
        {!languages.python && <p className="mt-1 text-xs text-gray-500">Python is not installed on this server.</p>}
      </fieldset>

      <fieldset className="mt-4">
        <legend className="text-sm font-medium text-gray-700">Start from</legend>
        <div className="mt-1 grid gap-2 md:grid-cols-3">
          {TEMPLATES.map((x) => (
            <label key={x.id} className={`cursor-pointer rounded-lg border p-3 text-sm ${template === x.id ? "border-slate-900 bg-slate-50" : "border-gray-300 hover:border-gray-400"}`}>
              <input type="radio" name="template" className="sr-only" checked={template === x.id} onChange={() => setTemplate(x.id)} />
              <span className="block font-medium text-gray-900">{x.label}</span>
              <span className="mt-0.5 block text-xs text-gray-600">{x.about}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button className="btn btn-dark" disabled={busy}>
          {busy ? "Creating…" : "Create plug-in"}
        </button>
        {msg && <span className="text-sm text-red-700">{msg}</span>}
      </div>
    </form>
  );
}

function Editor({ team, id, institutions, onChange, onDeleted }: { team: string; id: string; institutions: Institution[]; onChange: () => void; onDeleted: () => void }) {
  const { data, error, refresh } = useView<Detail>(team, `/code/${id}`, 2500);
  const [draft, setDraft] = useState<string | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [copied, setCopied] = useState(false);
  if (!data || data.id !== id) return <Loading error={error} />;
  // The first load fills the editor. After that, what is typed here is kept until it is saved.
  if (draft === null) {
    setDraft(data.source);
    setName(data.name);
    return null;
  }
  const dirty = draft !== data.source || (name ?? "") !== data.name;
  const save = async () => {
    setSaving(true);
    setNote(null);
    try {
      const r = await api<{ started: { ok: boolean; error?: string } }>(team, `/code/${id}`, { method: "PUT", body: { name, source: draft } });
      setNote(r.started.ok ? { ok: true, text: "Saved and running." } : { ok: false, text: r.started.error ?? "Saved, but it could not start." });
      await refresh();
      onChange();
    } catch (e) {
      setNote({ ok: false, text: (e as Error).message });
    } finally {
      setSaving(false);
    }
  };
  const del = async () => {
    if (!confirm(`Delete "${data.name}"? It is unplugged everywhere and its code is gone for good.`)) return;
    await api(team, `/code/${id}`, { method: "DELETE" });
    onDeleted();
  };
  const st = STATUS[data.run.status] ?? STATUS.stopped;

  return (
    <div className="space-y-4">
      <section className="card overflow-hidden">
        <div className="flex flex-wrap items-center gap-3 border-b border-gray-100 px-4 py-3">
          <input value={name ?? ""} onChange={(e) => setName(e.target.value)} aria-label="Plug-in name" className="min-w-0 flex-1 rounded-md border border-transparent px-2 py-1 text-base font-semibold text-gray-900 hover:border-gray-200 focus:border-gray-300" />
          <Badge tone={data.language === "python" ? "blue" : "amber"}>{LANG_LABEL[data.language]}</Badge>
          <span className="flex items-center gap-1.5 text-xs text-gray-600">
            <span className={`h-2 w-2 rounded-full ${st.dot}`} />
            {st.label}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2 border-b border-gray-100 bg-gray-50 px-4 py-2 text-xs text-gray-600">
          <span>Address</span>
          <code className="rounded bg-white px-1.5 py-0.5 font-mono text-gray-900 ring-1 ring-gray-200">{data.address}</code>
          <button
            type="button"
            className="underline"
            onClick={() => {
              void navigator.clipboard?.writeText(data.address);
              setCopied(true);
            }}
          >
            {copied ? "Copied" : "Copy"}
          </button>
          <span className="text-gray-400">· also works in any institution&apos;s Plug-ins tab</span>
        </div>
        {data.run.error && <div className="border-b border-red-100 bg-red-50 px-4 py-2 font-mono text-xs text-red-800">{data.run.error}</div>}
        <CodeArea value={draft} onChange={setDraft} indent={data.language === "python" ? 4 : 2} onSave={() => dirty && !saving && void save()} />
        <div className="flex flex-wrap items-center gap-2 border-t border-gray-100 px-4 py-3">
          <button type="button" className="btn btn-dark" disabled={!dirty || saving} onClick={save}>
            {saving ? "Saving…" : dirty ? "Save and run" : "Saved"}
          </button>
          <span className="text-xs text-gray-500">⌘S / Ctrl+S</span>
          {note && <span className={`text-sm ${note.ok ? "text-green-700" : "text-red-700"}`}>{note.text}</span>}
          <span className="ml-auto flex gap-2">
            <button type="button" className="btn" onClick={() => void api(team, `/code/${id}`, { body: { action: "restart" } }).then(refresh)}>
              Restart
            </button>
            <button type="button" className="btn btn-danger" onClick={del}>
              Delete
            </button>
          </span>
        </div>
      </section>

      <div className="grid gap-4 xl:grid-cols-2">
        <PlugIn team={team} id={id} institutions={institutions} places={data.places} onChange={() => (refresh(), onChange())} />
        <TryIt team={team} id={id} institutions={institutions} dirty={dirty} onDone={refresh} />
      </div>

      <Output team={team} id={id} run={data.run} calls={data.calls} onChange={refresh} />
    </div>
  );
}

/** A plain code editor: monospace, line numbers, Tab indents, Cmd/Ctrl+S saves. */
function CodeArea({ value, onChange, indent, onSave }: { value: string; onChange: (v: string) => void; indent: number; onSave: () => void }) {
  const gutter = useRef<HTMLPreElement>(null);
  const lines = value.split("\n").length;
  return (
    <div className="flex h-[30rem] bg-slate-950 font-mono text-[13px] leading-5 text-slate-100">
      <pre ref={gutter} aria-hidden className="w-12 shrink-0 select-none overflow-hidden py-3 pr-3 text-right text-slate-500">
        {Array.from({ length: lines }, (_, i) => i + 1).join("\n")}
      </pre>
      <textarea
        value={value}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        aria-label="Code"
        wrap="off"
        onScroll={(e) => gutter.current && (gutter.current.scrollTop = e.currentTarget.scrollTop)}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
            e.preventDefault();
            onSave();
          } else if (e.key === "Tab" && !e.metaKey && !e.ctrlKey && !e.altKey) {
            e.preventDefault();
            const el = e.currentTarget;
            const { selectionStart: a, selectionEnd: b } = el;
            const pad = " ".repeat(indent);
            const next = value.slice(0, a) + pad + value.slice(b);
            onChange(next);
            requestAnimationFrame(() => el.setSelectionRange(a + indent, a + indent));
          }
        }}
        className="min-w-0 flex-1 resize-none bg-transparent py-3 pr-4 outline-none"
      />
    </div>
  );
}

function InstitutionSelect({ institutions, value, onChange }: { institutions: Institution[]; value: string; onChange: (v: string) => void }) {
  const groups = [...new Set(institutions.map((i) => i.group))];
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm">
      {groups.map((g) => (
        <optgroup key={g} label={g}>
          {institutions
            .filter((i) => i.group === g)
            .map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
        </optgroup>
      ))}
    </select>
  );
}

function PointSelect({ points, value, onChange }: { points: Institution["points"]; value: string; onChange: (v: string) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm">
      {points.map((p) => (
        <option key={p.point} value={p.point}>
          {p.point === "events" ? "Events (after things happen)" : p.point}: {p.when.charAt(0).toLowerCase() + p.when.slice(1)}
        </option>
      ))}
    </select>
  );
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
    <section className="card p-4">
      <h3 className="font-semibold text-gray-900">Plug it in</h3>
      <p className="mt-0.5 text-sm text-gray-600">Choose an institution and the step where it should ask your code.</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="font-medium text-gray-700">Institution</span>
          <InstitutionSelect institutions={institutions} value={inst.id} onChange={setInstitution} />
        </label>
        <label className="block text-sm">
          <span className="font-medium text-gray-700">If your code fails or is slow</span>
          <select value={ifDown} onChange={(e) => setIfDown(e.target.value)} className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm">
            <option value="carry_on">Carry on as if it allowed</option>
            <option value="refuse">Refuse, to be safe</option>
          </select>
        </label>
        <label className="block text-sm sm:col-span-2">
          <span className="font-medium text-gray-700">Step</span>
          <PointSelect points={inst.points} value={p.point} onChange={setPoint} />
          <span className="mt-1 block text-xs text-gray-500">{p.answers.length ? `Answers accepted here: ${p.answers.join(", ")}` : "For information only: the answer is ignored."}</span>
        </label>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button type="button" className="btn btn-dark" onClick={go}>
          Plug in
        </button>
        {msg && <span className={`text-sm ${msg.ok ? "text-green-700" : "text-red-700"}`}>{msg.text}</span>}
      </div>
      <div className="mt-4 border-t border-gray-100 pt-3">
        <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">Plugged in at</div>
        {places.length === 0 ? (
          <p className="mt-1 text-sm text-gray-500">Nowhere yet.</p>
        ) : (
          <ul className="mt-1 divide-y divide-gray-100 text-sm">
            {places.map((x) => (
              <li key={x.id} className="flex items-center justify-between gap-3 py-2">
                <span className="min-w-0">
                  <span className="font-medium text-gray-900">{x.institutionName}</span> · <span className="font-mono text-xs">{x.point}</span>
                  <span className="block text-xs text-gray-500">
                    {x.calls} question(s) so far · if it fails: {x.ifDown === "refuse" ? "refuse" : "carry on"}
                  </span>
                </span>
                <button type="button" className="btn !px-2.5 !py-1 !text-xs" onClick={() => void api(team, `/code/${id}`, { body: { action: "unplug", integration: x.id } }).then(onChange)}>
                  Unplug
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
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
    <section className="card p-4">
      <h3 className="font-semibold text-gray-900">Try it</h3>
      <p className="mt-0.5 text-sm text-gray-600">Sends your code the example a network sends at a step. Nothing happens for real.</p>
      <label className="mt-3 block text-sm">
        <span className="font-medium text-gray-700">Step</span>
        <PointSelect points={mtn.points} value={point} onChange={setPoint} />
      </label>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button type="button" className="btn btn-dark" disabled={busy} onClick={run}>
          {busy ? "Asking…" : "Send a test"}
        </button>
        {dirty && <span className="text-xs text-amber-700">Unsaved changes: the saved version answers.</span>}
      </div>
      {result && (
        <div className="mt-3 space-y-2">
          <div className={`rounded-lg px-3 py-2 text-sm ${result.ok ? (result.problem ? "bg-amber-50 text-amber-900" : "bg-green-50 text-green-900") : "bg-red-50 text-red-800"}`}>
            {result.ok ? (
              <>
                Answered in {result.ms} ms: <code className="break-all font-mono text-xs">{JSON.stringify(result.answer)}</code>
                {result.problem && <span className="mt-1 block text-xs">{result.problem}</span>}
              </>
            ) : (
              result.error
            )}
          </div>
          {result.sent !== null && (
            <details className="text-xs">
              <summary className="cursor-pointer text-gray-600">What was sent as data</summary>
              <pre className="mt-1 max-h-56 overflow-auto rounded-lg bg-slate-950 p-3 text-slate-100">{JSON.stringify(result.sent, null, 2)}</pre>
            </details>
          )}
        </div>
      )}
    </section>
  );
}

function Output({ team, id, run, calls, onChange }: { team: string; id: string; run: Detail["run"]; calls: Detail["calls"]; onChange: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const count = run.logs.length;
  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [count]);
  return (
    <section className="card overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-gray-100 px-4 py-3">
        <h3 className="mr-auto font-semibold text-gray-900">Output</h3>
        <button type="button" className="btn !px-2.5 !py-1 !text-xs" onClick={() => void api(team, `/code/${id}`, { body: { action: "clear_logs" } }).then(onChange)}>
          Clear
        </button>
        <button
          type="button"
          className="btn !px-2.5 !py-1 !text-xs"
          onClick={() => confirm("Empty what this plug-in has kept in ctx.store?") && void api(team, `/code/${id}`, { body: { action: "clear_store" } }).then(onChange)}
        >
          Empty store
        </button>
      </div>
      <div ref={box} className="max-h-72 min-h-24 overflow-auto bg-slate-950 px-4 py-3 font-mono text-xs leading-5">
        {count === 0 ? (
          <span className="text-slate-500">console.log() / print() output and errors appear here.</span>
        ) : (
          run.logs.map((l, i) => (
            <div key={i} className={l.kind === "err" ? "whitespace-pre-wrap text-red-300" : l.kind === "info" ? "text-slate-500" : "whitespace-pre-wrap text-slate-100"}>
              <span className="mr-2 text-slate-600">{when(l.at, false)}</span>
              {l.text}
            </div>
          ))
        )}
      </div>
      <div className="px-4 py-3">
        <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">Questions from institutions</div>
        {calls.length === 0 ? (
          <p className="mt-1 text-sm text-gray-500">None yet. Once it is plugged in, every question asked and the answer given shows here.</p>
        ) : (
          <ul className="mt-1 divide-y divide-gray-100 text-sm">
            {calls.map((c, i) => (
              <li key={i} className="flex flex-wrap items-baseline gap-x-3 py-1.5">
                <span className="w-24 shrink-0 text-xs text-gray-500">{when(c.at)}</span>
                <span className="text-xs text-gray-700">
                  {c.institutionName} · <span className="font-mono">{c.point}</span>
                </span>
                <Badge tone={c.decision === "allow" || c.decision === "sent" ? "green" : c.decision === "error" || c.decision === "reject" ? "red" : "amber"}>{c.decision}</Badge>
                <span className="min-w-0 flex-1 truncate text-xs text-gray-600">{c.message}</span>
                <span className="text-xs text-gray-400">{c.ms} ms</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

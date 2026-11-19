"use client";

import Link from "next/link";
import { useState } from "react";
import { ActionButton, ActionForm, Badge, Section, Table } from "@/components/ui";
import { when } from "@/lib/client";

export interface Plugin {
  id: string;
  point: string;
  when: string;
  name: string;
  url: string;
  enabled: boolean;
  failOpen: boolean;
  timeoutMs: number;
  calls: number;
}
export interface PluginPoint {
  id: string;
  when: string;
  answers: string[];
  sample: unknown;
}
export interface PluginCall {
  id: number;
  at: string;
  api: string;
  point: string;
  request: string;
  decision: string;
  message: string | null;
  ms: number;
}
export interface PluginView {
  plugins: Plugin[];
  pluginPoints: PluginPoint[];
  pluginEvents: Record<string, string>;
  pluginCalls: PluginCall[];
}

const TONE: Record<string, "green" | "red" | "amber" | "gray"> = { allow: "green", sent: "green", warn: "amber", delay: "amber", reject: "red", error: "red" };
const MEANS: Record<string, string> = {
  allow: "go ahead",
  reject: "stop it and show the message",
  warn: "show the message first and let the customer decide",
  delay: "pause it for some minutes",
};

/**
 * Where an institution plugs an outside company's API into one of its own steps. From then on the
 * institution asks that API every time the step happens, and does what it answers.
 */
export function Plugins({ team, path, institution, view, onChange }: { team: string; path: string; institution: string; view: PluginView; onChange: () => void }) {
  const [tested, setTested] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<number | null>(null);
  const pointOptions = view.pluginPoints.map((p) => [p.id, p.when] as const);

  return (
    <>
      <Section
        title="Plug in an API"
        hint={
          <>
            A team builds an API and puts it online. Enter its address here and choose the step it should be asked at. From then on {institution} sends it the details every time that step happens, and does what it answers. Nothing changes for anyone
            until an API is plugged in. The{" "}
            <Link className="underline" href={`/t/${team}/docs#plugins`}>
              API reference
            </Link>{" "}
            shows what is sent at each step and how to answer.
          </>
        }
      >
        <ActionForm
          team={team}
          path={path}
          action="plugin_add"
          submit="Plug in"
          onDone={onChange}
          fields={[
            { name: "name", label: "Name", placeholder: "Weak PIN checker" },
            { name: "point", label: "Ask it when…", type: "select", options: pointOptions },
            { name: "url", label: "The API's address", placeholder: "https://my-api.example.com/check", hint: "Must be reachable from this sandbox. Requests are sent as POST with a JSON body." },
            {
              name: "ifDown",
              label: "If the API does not answer",
              type: "select",
              options: [
                ["carry_on", "Carry on as normal"],
                ["refuse", "Refuse, to be safe"],
              ],
            },
          ]}
        />
      </Section>

      <Section title="APIs plugged in">
        <Table
          rows={view.plugins}
          empty={`Nothing is plugged into ${institution} yet.`}
          cols={[
            {
              label: "API",
              cell: (p) => (
                <>
                  <span className="font-medium text-gray-900">{p.name}</span>
                  <div className="break-all font-mono text-[11px] text-gray-500">{p.url}</div>
                  {tested[p.id] && <div className="mt-1 text-xs text-gray-700">{tested[p.id]}</div>}
                </>
              ),
            },
            { label: "Asked when", cell: (p) => <span className="text-gray-700">{p.when}</span> },
            { label: "If no answer", cell: (p) => (p.failOpen ? "Carry on" : "Refuse") },
            { label: "Times asked", right: true, cell: (p) => p.calls },
            { label: "", cell: (p) => <Badge tone={p.enabled ? "green" : "gray"}>{p.enabled ? "on" : "off"}</Badge> },
            {
              label: "",
              cell: (p) => (
                <span className="flex flex-wrap gap-1">
                  <ActionButton team={team} path={path} body={{ action: "plugin_test", id: p.id }} onDone={(r) => { setTested((t) => ({ ...t, [p.id]: (r as { message: string }).message })); onChange(); }}>
                    Send a test
                  </ActionButton>
                  <ActionButton team={team} path={path} body={{ action: "plugin_switch", id: p.id, on: !p.enabled }} onDone={onChange}>
                    {p.enabled ? "Switch off" : "Switch on"}
                  </ActionButton>
                  <ActionButton team={team} path={path} body={{ action: "plugin_remove", id: p.id }} confirmText={`Unplug "${p.name}"?`} onDone={onChange} danger>
                    Unplug
                  </ActionButton>
                </span>
              ),
            },
          ]}
        />
      </Section>

      <Section title="What was asked and answered" hint="The most recent first. Click a row to see exactly what was sent.">
        <Table
          rows={view.pluginCalls}
          empty="No API has been asked anything yet."
          onRow={(c) => setOpen(open === c.id ? null : c.id)}
          cols={[
            { label: "When", cell: (c) => <span className="whitespace-nowrap text-gray-500">{when(c.at)}</span> },
            { label: "API", cell: (c) => c.api },
            { label: "Step", cell: (c) => <span className="font-mono text-[11px]">{c.point}</span> },
            { label: "Answer", cell: (c) => <Badge tone={TONE[c.decision] ?? "gray"}>{c.decision}</Badge> },
            {
              label: "Message",
              cell: (c) => (
                <>
                  {c.message}
                  {open === c.id && <pre className="mt-2 max-w-xl overflow-x-auto whitespace-pre-wrap rounded bg-gray-50 p-2 text-[11px] text-gray-700">{pretty(c.request)}</pre>}
                </>
              ),
            },
            { label: "Took", right: true, cell: (c) => `${c.ms} ms` },
          ]}
        />
      </Section>

      <Section title="The steps an API can be plugged into">
        <Table
          rows={view.pluginPoints}
          empty=""
          cols={[
            { label: "Step", cell: (p) => <span className="font-mono text-[11px]">{p.id}</span> },
            { label: "Asked when", cell: (p) => p.when },
            { label: "The API can answer", cell: (p) => (p.answers.length ? p.answers.map((a) => `${a} (${MEANS[a]})`).join(" · ") : "nothing: it is only told") },
          ]}
        />
      </Section>
    </>
  );
}

function pretty(json: string) {
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
}

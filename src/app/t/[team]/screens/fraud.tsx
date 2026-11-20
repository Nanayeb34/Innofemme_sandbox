"use client";

import Link from "next/link";
import { Fragment, useState } from "react";
import { ActionButton, ActionForm, Badge, Loading, Section, Shell, Stat, Stats, Table, useView } from "@/components/ui";
import { ghs, when } from "@/lib/client";

interface TrailStep {
  what: string;
  result: string;
  point?: string;
  by?: string;
  answer?: string;
  message?: string;
}
interface RunHead {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  status: string;
  kinds: string[];
  against: string;
  planned: number;
  done: number;
  note: string | null;
  fraud: { total: number; stopped: number; contained: number; through: number };
  ordinary: { total: number; fine: number; slowed: number; blocked: number };
  couldNotBePlayed: number;
  atRisk: number;
  lost: number;
}
interface Incident {
  id: number;
  at: string;
  kind: string;
  scenario: string;
  who: string | null;
  outcome: string;
  stoppedAt: string | null;
  stoppedBy: string | null;
  answer: string | null;
  atRisk: number;
  lost: number;
  summary: string;
  trail: TrailStep[];
}
interface FraudView {
  kinds: { id: string; about: string }[];
  apps: { id: string; name: string; url: string; kinds: string[] }[];
  pluggedIn: number;
  notReady: string | null;
  running: boolean;
  reactions: Record<string, number>;
  latest?: RunHead & {
    byKind: { kind: string; total: number; stopped: number; contained: number; through: number }[];
    stops: { step: string; by: string; answer: string; fraud: number; ordinary: number }[];
    incidents: Incident[];
  };
  runs: RunHead[];
}

const OUTCOME: Record<string, [string, "green" | "red" | "amber" | "gray" | "blue"]> = {
  stopped: ["Stopped", "green"],
  contained: ["Held before cash-out", "blue"],
  through: ["Got through", "red"],
  fine: ["Went through", "green"],
  slowed: ["Slowed", "amber"],
  blocked: ["Wrongly stopped", "red"],
  void: ["Not played", "gray"],
};
const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : "–");
const label = (kind: string) => kind.replace(/_/g, " ");

/**
 * Where a team tests what it has built. Fraud incidents of a chosen kind are played through the
 * sandbox, the team's service is asked at each step, and this page shows how many it stopped.
 */
export default function Fraud({ team }: { team: string }) {
  const path = "/s/fraud";
  const { data, error, refresh } = useView<FraudView>(team, path, 2000);
  const [open, setOpen] = useState<number | null>(null);
  const [show, setShow] = useState<"all" | "fraud" | "ordinary">("fraud");
  if (!data) return <Loading error={error} />;
  const r = data.latest;
  const all = data.kinds.length;

  return (
    <Shell team={team} title="Fraud console" subtitle="Send fraud incidents at what you have built, and see how many it stops" color="#7f1d1d">
      <Section
        title="Send fraud incidents"
        hint={
          <>
            Each incident is played live, step by step: the fraudster gets a line, reaches the victim, the money leaves, moves on and is withdrawn. At every step your service is asked, exactly as it would be for real activity, and what it answers decides whether the
            incident goes on. Ordinary activity is played alongside, to show whether honest customers are being stopped too. Your service is never told which requests were fraud.
          </>
        }
      >
        {data.notReady ? (
          <p className="text-sm text-amber-800">
            {data.notReady}{" "}
            <Link className="underline" href={`/t/${team}`}>
              Go to your team&apos;s home page
            </Link>
            .
          </p>
        ) : (
          <ActionForm
            team={team}
            path={path}
            action="run"
            submit={data.running ? "Running…" : "Send incidents"}
            disabled={data.running ? "A run is in progress." : undefined}
            onDone={refresh}
            keep={["kinds", "incidents", "app"]}
            fields={[
              { name: "kinds", label: "Kind of fraud", type: "select", options: [["all", `Every kind (${all})`], ...data.kinds.map((k) => [k.id, `${label(k.id)}: ${k.about}`] as const)] },
              { name: "incidents", label: "How many incidents", type: "number", initial: "20" },
              {
                name: "app",
                label: "Send incidents to",
                type: "select",
                options: [["", `The APIs plugged into the institutions (${data.pluggedIn} plugged in)`], ...data.apps.map((a) => [a.id, `The application "${a.name}"`] as const)],
                hint: "An API plugged into a network, a bank or the switch is asked at its own step. A connected application is asked at every step instead.",
              },
              { name: "ordinary", label: "Pieces of ordinary activity", type: "number", optional: true, placeholder: "Same as the number of incidents" },
            ]}
          />
        )}
        {!data.notReady && !data.pluggedIn && !data.apps.length && (
          <p className="mt-3 text-sm text-gray-600">
            Nothing is plugged in and no application is connected, so a run now will show every incident getting through. Plug an API in from a network&apos;s, a bank&apos;s or the switch&apos;s <b>Plug-ins</b> tab, or connect an application below.
          </p>
        )}
      </Section>

      <Section
        title="Fraud API results"
        hint={r ? `${r.against} · ${r.kinds.length === all ? "every kind of fraud" : r.kinds.map(label).join(", ")} · started ${when(r.startedAt)}` : "Nothing has been run yet."}
        right={
          data.running && (
            <ActionButton team={team} path={path} body={{ action: "stop" }} onDone={refresh} danger>
              Stop
            </ActionButton>
          )
        }
      >
        {!r ? (
          <p className="text-sm text-gray-500">Send some incidents above. The results appear here.</p>
        ) : (
          <>
            {(data.running || r.status !== "finished") && (
              <p className="mb-3 text-sm text-gray-700">
                {data.running ? `Running: ${r.done} of ${r.planned} played so far.` : r.status === "interrupted" ? "This run was cut short when the sandbox restarted." : `This run was stopped after ${r.done} of ${r.planned}.`} {r.note}
              </p>
            )}
            <Stats>
              <Stat label="Fraud incidents stopped" value={`${r.fraud.stopped + r.fraud.contained} of ${r.fraud.total}`} sub={pct(r.fraud.stopped + r.fraud.contained, r.fraud.total)} tone={r.fraud.stopped + r.fraud.contained > 0 ? "good" : undefined} />
              <Stat label="Before any money moved" value={r.fraud.stopped} sub="the victim lost nothing" />
              <Stat label="Held before cash-out" value={r.fraud.contained} sub="the money can be given back" />
              <Stat label="Got through" value={r.fraud.through} sub="withdrawn as cash" tone={r.fraud.through ? "bad" : undefined} />
              <Stat label="Money kept from fraudsters" value={ghs(r.atRisk - r.lost)} sub={`of ${ghs(r.atRisk)} at risk`} />
              <Stat label="Honest activity wrongly stopped" value={`${r.ordinary.blocked} of ${r.ordinary.total}`} sub={`${r.ordinary.slowed} more slowed by a warning`} tone={r.ordinary.blocked ? "bad" : undefined} />
            </Stats>

            <div className="grid gap-6 lg:grid-cols-2">
              <div>
                <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">By kind of fraud</h3>
                <Table
                  rows={r.byKind}
                  empty="No incident has finished yet."
                  cols={[
                    { label: "Kind", cell: (k) => <span className="capitalize">{label(k.kind)}</span> },
                    { label: "Played", right: true, cell: (k) => k.total },
                    { label: "Stopped", right: true, cell: (k) => k.stopped },
                    { label: "Held", right: true, cell: (k) => k.contained },
                    { label: "Got through", right: true, cell: (k) => k.through },
                    { label: "", right: true, cell: (k) => <span className="text-gray-500">{pct(k.stopped + k.contained, k.total)}</span> },
                  ]}
                />
              </div>
              <div>
                <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">Where they were stopped, and by what</h3>
                <Table
                  rows={r.stops}
                  empty="Nothing was stopped by a plugged-in API or a connected application."
                  cols={[
                    { label: "Step", cell: (s) => <span className="font-mono text-[11px]">{s.step}</span> },
                    { label: "By", cell: (s) => s.by },
                    { label: "It answered", cell: (s) => <Badge tone={s.answer === "reject" ? "red" : "amber"}>{s.answer}</Badge> },
                    { label: "Fraud", right: true, cell: (s) => s.fraud },
                    { label: "Honest", right: true, cell: (s) => s.ordinary },
                  ]}
                />
              </div>
            </div>

            <div className="mb-1 mt-5 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">Each one, step by step (click a row)</h3>
              <span className="flex gap-1 text-xs">
                {(["fraud", "ordinary", "all"] as const).map((s) => (
                  <button key={s} onClick={() => setShow(s)} className={`rounded px-2 py-1 ${show === s ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-700"}`}>
                    {s === "fraud" ? "Fraud" : s === "ordinary" ? "Honest activity" : "Both"}
                  </button>
                ))}
              </span>
            </div>
            <div className="-mx-4 overflow-x-auto px-4">
              <table className="w-full min-w-[640px] text-left text-sm">
                <thead>
                  <tr className="border-b border-gray-200 text-[11px] uppercase tracking-wide text-gray-500">
                    <th className="px-2 py-2 font-medium">What</th>
                    <th className="px-2 py-2 font-medium">Victim or customer</th>
                    <th className="px-2 py-2 font-medium">Outcome</th>
                    <th className="px-2 py-2 font-medium">What happened</th>
                    <th className="px-2 py-2 text-right font-medium">At risk</th>
                    <th className="px-2 py-2 text-right font-medium">Lost</th>
                  </tr>
                </thead>
                <tbody>
                  {r.incidents
                    .filter((i) => show === "all" || i.kind === show)
                    .map((i) => (
                      <Fragment key={i.id}>
                        <tr className="cursor-pointer border-b border-gray-100 align-top hover:bg-gray-50" onClick={() => setOpen(open === i.id ? null : i.id)}>
                          <td className="px-2 py-2">
                            <span className={i.kind === "fraud" ? "capitalize" : ""}>{i.kind === "fraud" ? label(i.scenario) : i.scenario}</span>
                          </td>
                          <td className="px-2 py-2 text-gray-700">{i.who}</td>
                          <td className="px-2 py-2">
                            <Badge tone={OUTCOME[i.outcome]?.[1] ?? "gray"}>{OUTCOME[i.outcome]?.[0] ?? i.outcome}</Badge>
                          </td>
                          <td className="px-2 py-2 text-gray-700">
                            {i.summary}
                            {i.stoppedBy && (
                              <span className="block text-xs text-gray-500">
                                {i.stoppedBy} answered &quot;{i.answer}&quot; at <span className="font-mono">{i.stoppedAt}</span>
                              </span>
                            )}
                          </td>
                          <td className="px-2 py-2 text-right">{i.kind === "fraud" ? ghs(i.atRisk) : ""}</td>
                          <td className="px-2 py-2 text-right">{i.kind === "fraud" ? ghs(i.lost) : ""}</td>
                        </tr>
                        {open === i.id && (
                          <tr className="border-b border-gray-100 bg-gray-50">
                            <td colSpan={6} className="px-4 py-3">
                              <ol className="list-decimal space-y-1 pl-5 text-sm text-gray-800">
                                {i.trail.map((t, n) => (
                                  <li key={n}>
                                    {t.what}: <b>{t.result}</b>
                                    {t.by && (
                                      <span className="text-xs text-gray-600">
                                        {" "}
                                        · {t.by} answered &quot;{t.answer}&quot; at <span className="font-mono">{t.point}</span>
                                        {t.message ? `: “${t.message}”` : ""}
                                      </span>
                                    )}
                                  </li>
                                ))}
                              </ol>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    ))}
                </tbody>
              </table>
            </div>
            {!!r.couldNotBePlayed && <p className="mt-2 text-xs text-gray-500">{r.couldNotBePlayed} could not be played for a reason unrelated to your service (for example a daily limit was reached) and are left out of the figures.</p>}
            <p className="mt-3 text-xs text-gray-500">
              How the simulated people react: a victim who sees a warning label on the fraudster&apos;s text ignores it {pct(data.reactions.labelOnText, 1)} of the time, hangs up on a call shown with a warning {pct(data.reactions.labelOnCall, 1)} of the time, cancels a payment
              they are warned about {pct(data.reactions.warningAtPayment, 1)} of the time, and does not retry a paused payment {pct(data.reactions.afterPause, 1)} of the time. A general notice before the menu stops {pct(data.reactions.noticeAtMenu, 1)}. Fraudsters ignore
              warnings and wait out pauses. An honest customer gives up after a warning {pct(data.reactions.ordinaryPutOff, 1)} of the time.
            </p>
          </>
        )}
      </Section>

      <Section
        title="Applications connected to the Fraud API"
        hint={
          <>
            For a product that is its own application, not an API plugged into an institution. Connect it here (or let it connect itself, see the{" "}
            <Link className="underline" href={`/t/${team}/docs#fraud`}>
              API reference
            </Link>
            ) with the kinds of fraud it is built to stop. Chosen above, it is sent every step of each incident, in the same format a plugged-in API receives, and answers allow, warn, delay or reject.
          </>
        }
      >
        <ActionForm
          team={team}
          path={path}
          action="connect_app"
          submit="Connect"
          onDone={refresh}
          fields={[
            { name: "name", label: "Application", placeholder: "My team's application" },
            { name: "url", label: "Its address", placeholder: "https://my-app.example.com/fraud", hint: "Must be reachable from this sandbox. Requests are sent as POST with a JSON body." },
            { name: "kinds", label: "Built to stop", type: "select", options: [["all", "Every kind of fraud"], ...data.kinds.map((k) => [k.id, label(k.id)] as const)] },
          ]}
        />
        <div className="mt-4">
          <Table
            rows={data.apps}
            empty="No application is connected."
            cols={[
              { label: "Application", cell: (a) => <span className="font-medium text-gray-900">{a.name}</span> },
              { label: "Address", cell: (a) => <span className="break-all font-mono text-[11px] text-gray-600">{a.url}</span> },
              { label: "Built to stop", cell: (a) => (a.kinds.length === all ? "Every kind" : a.kinds.map(label).join(", ")) },
              {
                label: "",
                cell: (a) => (
                  <ActionButton team={team} path={path} body={{ action: "disconnect_app", id: a.id }} confirmText={`Disconnect "${a.name}"?`} onDone={refresh} danger>
                    Disconnect
                  </ActionButton>
                ),
              },
            ]}
          />
        </div>
      </Section>

      <Section title="Earlier runs">
        <Table
          rows={data.runs}
          empty="No runs yet."
          cols={[
            { label: "Started", cell: (x) => <span className="whitespace-nowrap text-gray-500">{when(x.startedAt)}</span> },
            { label: "Sent to", cell: (x) => x.against },
            { label: "Kinds", cell: (x) => (x.kinds.length === all ? "Every kind" : x.kinds.map(label).join(", ")) },
            { label: "Fraud stopped", right: true, cell: (x) => `${x.fraud.stopped + x.fraud.contained} of ${x.fraud.total} (${pct(x.fraud.stopped + x.fraud.contained, x.fraud.total)})` },
            { label: "Honest wrongly stopped", right: true, cell: (x) => `${x.ordinary.blocked} of ${x.ordinary.total}` },
            { label: "", cell: (x) => (x.status === "finished" ? "" : <Badge tone="gray">{x.status}</Badge>) },
          ]}
        />
      </Section>
    </Shell>
  );
}

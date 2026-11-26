import * as code from "@/engine/coderun";
import { EVENTS, POINTS, SAMPLES, SWITCH, addIntegration, pointsFor, removeIntegration, type Integration } from "@/engine/integrations";
import { BANKS, SimError, TELCOS, TELCO_INFO } from "@/engine/util";
import { withLock, type World } from "@/engine/world";

/** The Developer console's view of a team's own plug-ins, and what it does with them. */

/** Every institution a plug-in can be plugged into, with its steps. */
export const institutions = () =>
  [
    ...TELCOS.map((t) => ({ id: t as string, name: `${TELCO_INFO[t].name} (${TELCO_INFO[t].wallet})`, group: "Networks" })),
    ...BANKS.map((b) => ({ id: b.id, name: b.name, group: "Banks" })),
    { id: SWITCH, name: "National switch (GhIPSS)", group: "Switch" },
  ].map((i) => ({ ...i, points: pointsFor(i.id).map(([point, p]) => ({ point, when: p.when, answers: p.answers })) }));

const nameOf = (institution: string) => institutions().find((i) => i.id === institution)?.name ?? institution;

/** Where in this world a plug-in is plugged in. */
export function placesOf(w: World, id: string) {
  const rows = w.db.prepare("SELECT * FROM integrations WHERE url = ? ORDER BY created_at").all(code.codeAddress(id)) as unknown as Integration[];
  return rows.map((i) => ({ id: i.id, institution: i.institution, institutionName: nameOf(i.institution), point: i.point, when: POINTS[i.point]?.when ?? i.point, enabled: !!i.enabled, calls: i.calls, ifDown: i.fail_open ? "carry_on" : "refuse", timeoutMs: i.timeout_ms }));
}

/** The last questions the institutions asked this plug-in in this world, and what it answered. */
function callsOf(w: World, id: string) {
  return (
    w.db
      .prepare("SELECT c.at, c.institution, c.point, c.decision, c.message, c.ms FROM integration_calls c JOIN integrations i ON i.id = c.integration_id WHERE i.url = ? ORDER BY c.id DESC LIMIT 25")
      .all(code.codeAddress(id)) as { at: number; institution: string; point: string; decision: string; message: string | null; ms: number }[]
  ).map((c) => ({ ...c, at: new Date(c.at).toISOString(), institutionName: nameOf(c.institution) }));
}

export function overview(w: World) {
  const team = w.id;
  return {
    enabled: code.codeEnabled(),
    languages: { javascript: true, python: !!code.pythonCommand() },
    institutions: institutions(),
    events: EVENTS,
    plugins: code.listCode(team).map((m) => ({ ...m, address: code.codeAddress(m.id), status: code.codeStatus(team, m.id).status, places: placesOf(w, m.id).length })),
  };
}

export function detail(w: World, id: string) {
  const team = w.id;
  return { ...code.getCode(team, id), address: code.codeAddress(id), run: code.codeStatus(team, id), places: placesOf(w, id), calls: callsOf(w, id) };
}

/** Sends the plug-in the example an institution would send at a step, without anything happening for real. */
export async function tryIt(w: World, id: string, point: string, institution: string) {
  if (!POINTS[point]) throw new SimError("Choose a step to try");
  const data = point === "events" ? SAMPLES.events : SAMPLES[point];
  const started = Date.now();
  try {
    const answer = await code.askCode(w.id, id, { point, institution: institution || "mtn", world: w.id, at: new Date().toISOString(), data }, 5000);
    const allowed = POINTS[point].answers;
    const decision = (answer as { decision?: string } | null)?.decision;
    const problem = point !== "events" && !allowed.includes(decision as never) ? `At this step an institution accepts only: ${allowed.join(", ")}. It would treat this answer as a failure.` : undefined;
    return { ok: true, sent: data, answer, ms: Date.now() - started, problem };
  } catch (e) {
    return { ok: false, sent: data, error: (e as Error).message, ms: Date.now() - started };
  }
}

export const plug = (w: World, id: string, b: { institution?: unknown; point?: unknown; ifDown?: unknown; timeoutMs?: unknown }) =>
  withLock(w, () => {
    const meta = code.getCode(w.id, id);
    const institution = String(b.institution ?? "");
    if (!institutions().some((i) => i.id === institution)) throw new SimError("Choose where to plug it in");
    const point = String(b.point ?? "");
    if (placesOf(w, id).some((p) => p.institution === institution && p.point === point)) throw new SimError("It is already plugged in there");
    return addIntegration(w, institution, { point, name: meta.name, url: code.codeAddress(id), failOpen: b.ifDown !== "refuse", timeoutMs: b.timeoutMs || 2000 });
  });

export const unplug = (w: World, id: string, integration: unknown) =>
  withLock(w, () => {
    const place = placesOf(w, id).find((p) => p.id === integration);
    if (!place) throw new SimError("It is not plugged in there");
    removeIntegration(w, place.institution, place.id);
  });

/** Deletes a plug-in, unplugging it everywhere in this world first. */
export const remove = (w: World, id: string) =>
  withLock(w, () => {
    for (const p of placesOf(w, id)) removeIntegration(w, p.institution, p.id);
    code.deleteCode(w.id, id);
  });

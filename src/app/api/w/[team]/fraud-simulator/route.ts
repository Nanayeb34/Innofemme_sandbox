import { FRAUD_KINDS, connectApp, disconnectApp, isRunning, listApps, readiness, startRun, stopRun } from "@/engine/fraudsim";
import { POINTS } from "@/engine/integrations";
import { withLock } from "@/engine/world";
import { HttpError, authWorld, body, handle, publicOrigin } from "@/server/http";

type Ctx = RouteContext<"/api/w/[team]/fraud-simulator">;

/**
 * The Fraud API: starts the fraud simulator, and lets a standalone application connect itself to it.
 * It reports what can be run and whether a run is going. It does not report results: how many
 * incidents were stopped is shown only in the team's console, under "Fraud API results".
 */
export const GET = handle(async (req: Request, ctx: Ctx) => {
  const { team } = await ctx.params;
  const w = await authWorld(req, team);
  const last = w.db.prepare("SELECT id, started_at, finished_at, status, planned, ordinary, target FROM fraud_runs ORDER BY started_at DESC LIMIT 1").get() as
    | { id: string; started_at: number; finished_at: number | null; status: string; planned: number; ordinary: number; target: string }
    | undefined;
  return {
    kinds: Object.entries(FRAUD_KINDS).map(([id, about]) => ({ id, about })),
    applications: listApps(w),
    ready: !readiness(w),
    notReadyBecause: readiness(w) ?? null,
    running: isRunning(w),
    lastRun: last ? { run: last.id, startedAt: new Date(last.started_at).toISOString(), finishedAt: last.finished_at ? new Date(last.finished_at).toISOString() : null, status: isRunning(w) ? "running" : last.status === "running" ? "interrupted" : last.status, incidents: last.planned, ordinary: last.ordinary } : null,
    results: `Shown in the team console, under "Fraud API results": ${publicOrigin(req)}/t/${team}/fraud`,
    whatAnApplicationIsSent: { steps: Object.keys(POINTS).filter((p) => p !== "events"), format: "The same as a plugged-in API receives at each step. See the API reference, section 7." },
  };
});

/**
 * POST { action: "run", kinds, incidents, ordinary?, application?, seed? }   start a run (the default action)
 * POST { action: "connect", name, url, kinds }                               connect a standalone application
 * POST { action: "disconnect", id }                                          remove it
 * POST { action: "stop" }                                                    stop the run in progress
 */
export const POST = handle(async (req: Request, ctx: Ctx) => {
  const { team } = await ctx.params;
  const w = await authWorld(req, team);
  const b = await body(req);
  const action = String(b.action ?? "run");
  const seeResults = `The results appear in the team console, under "Fraud API results": ${publicOrigin(req)}/t/${team}/fraud`;
  return withLock(w, () => {
    if (action === "run") return { ok: true, ...startRun(w, { kinds: b.kinds ?? b.kind, incidents: b.incidents, ordinary: b.ordinary, app: b.application ?? b.app, seed: b.seed }), results: seeResults };
    if (action === "connect") return { ok: true, application: connectApp(w, b), next: 'Start a run against it with { "action": "run", "application": "<its id or name>" }.' };
    if (action === "disconnect") return (disconnectApp(w, b.id), { ok: true });
    if (action === "stop") return (stopRun(w), { ok: true, message: "Stopping after the incident in progress." });
    throw new HttpError(400, "Unknown action. Use run, connect, disconnect or stop.");
  });
});

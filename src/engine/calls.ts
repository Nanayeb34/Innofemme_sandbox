import { count } from "./db";
import { consult } from "./integrations";
import { sendSms } from "./notify";
import { getSim } from "./telco";
import { SimError, TELCO_INFO, clock, isTelco, newId, normalizeMsisdn, type Telco } from "./util";
import type { CallSignal, World } from "./world";

/**
 * Voice calls between phones. The network side is simulated here: who can call whom, ringing,
 * busy, unanswered, and the call record each telco keeps. The audio travels directly between the
 * two browsers (WebRTC); this module only passes their connection details back and forth.
 */

export interface CallRow {
  id: string;
  from_msisdn: string;
  to_msisdn: string;
  from_telco: Telco;
  to_telco: Telco | null;
  status: "ringing" | "active" | "ended" | "missed" | "declined" | "busy" | "failed";
  reason: string | null;
  started_at: number;
  answered_at: number | null;
  ended_at: number | null;
}

export const CARE_LINE = "100";
/** A call centre's end of the line: "100:mtn". Phones are addressed by their number. */
export const careEndpoint = (telco: Telco) => `${CARE_LINE}:${telco}`;
const careOf = (endpoint: string): Telco | undefined => {
  const [line, telco] = endpoint.split(":");
  return line === CARE_LINE && telco && isTelco(telco) ? telco : undefined;
};
/** Accepts a phone number in any form, or a call centre's endpoint. */
const endpointOf = (input: string) => (careOf(String(input)) ? String(input) : normalizeMsisdn(input));
const isCallee = (c: CallRow, endpoint: string) => (c.to_msisdn === CARE_LINE ? careOf(endpoint) === c.from_telco : c.to_msisdn === endpoint);
const isParty = (c: CallRow, endpoint: string) => c.from_msisdn === endpoint || isCallee(c, endpoint);

const RING_MS = 30_000;
/** Callers wait longer in the customer care queue. */
const CARE_RING_MS = 90_000;
/** A phone that has stopped checking in for this long has gone away (tab closed, signal lost). */
const GONE_MS = 15_000;
const MAX_SDP = 20_000;
const MAX_CANDIDATES = 80;

const getCall = (w: World, id: string) => w.db.prepare("SELECT * FROM calls WHERE id = ?").get(id) as CallRow | undefined;
const live = (c: CallRow) => c.status === "ringing" || c.status === "active";
const liveCallOf = (w: World, msisdn: string) =>
  w.db.prepare("SELECT * FROM calls WHERE status IN ('ringing','active') AND (from_msisdn = ? OR to_msisdn = ?) ORDER BY started_at DESC, rowid DESC LIMIT 1").get(msisdn, msisdn) as CallRow | undefined;

function finish(w: World, c: CallRow, status: CallRow["status"], reason: string) {
  w.db.prepare("UPDATE calls SET status = ?, reason = ?, ended_at = ? WHERE id = ? AND status IN ('ringing','active')").run(status, reason, w.now, c.id);
  w.calls.delete(c.id);
}

/** Closes calls nobody answered in time, and calls where one phone has gone away. */
function expire(w: World) {
  const rows = w.db.prepare("SELECT * FROM calls WHERE status IN ('ringing','active')").all() as unknown as CallRow[];
  for (const c of rows) {
    const s = w.calls.get(c.id);
    if (!s) finish(w, c, c.status === "ringing" ? "missed" : "ended", "Connection lost");
    else if (c.status === "ringing" && w.now - c.started_at > (c.to_msisdn === CARE_LINE ? CARE_RING_MS : RING_MS)) finish(w, c, "missed", c.to_msisdn === CARE_LINE ? "All customer care agents are busy. Please try again later." : "No answer");
    else if (w.now - s.seen.caller > GONE_MS) finish(w, c, c.status === "ringing" ? "missed" : "ended", "Caller's connection was lost");
    else if (c.status === "active" && w.now - s.seen.callee > GONE_MS) finish(w, c, "ended", "The other phone's connection was lost");
  }
}

function record(w: World, c: Pick<CallRow, "from_msisdn" | "to_msisdn" | "from_telco" | "to_telco" | "status" | "reason">): string {
  const id = newId("call");
  const done = c.status === "ringing" ? null : w.now;
  w.db
    .prepare("INSERT INTO calls(id, from_msisdn, to_msisdn, from_telco, to_telco, status, reason, started_at, ended_at) VALUES(?,?,?,?,?,?,?,?,?)")
    .run(id, c.from_msisdn, c.to_msisdn, c.from_telco, c.to_telco, c.status, c.reason, w.now, done);
  return id;
}

/** Places a call. The caller's phone sends its side of the audio connection (the offer) with it. */
export function startCall(w: World, req: { from: string; to: string; device: string; offer: string }): { id: string } {
  const from = getSim(w, normalizeMsisdn(req.from));
  if (!from || from.status !== "active") throw new SimError("No network service. This SIM is not active.");
  const dialled = normalizeMsisdn(req.to);
  if (dialled === CARE_LINE) return callCare(w, from.msisdn, from.telco, req);
  if (!/^0\d{9}$/.test(dialled)) throw new SimError(/^\d{3,5}$/.test(dialled) ? `Short number ${dialled} is not in service yet.` : "The number you have dialled is not valid.");
  if (dialled === from.msisdn) throw new SimError("You cannot call your own number.");
  if (typeof req.offer !== "string" || !req.offer || req.offer.length > MAX_SDP) throw new SimError("The call could not be set up on this phone.");
  expire(w);
  if (liveCallOf(w, from.msisdn)) throw new SimError("You are already on a call.");

  const to = getSim(w, dialled);
  const base = { from_msisdn: from.msisdn, to_msisdn: dialled, from_telco: from.telco, to_telco: to?.telco ?? null };
  // The network's recorded announcements. Each refused attempt still leaves a call record.
  const refuse = (status: CallRow["status"], reason: string): never => {
    record(w, { ...base, status, reason });
    throw new SimError(reason);
  };
  if (!to || to.status === "in_stock" || to.status === "deactivated") refuse("failed", "The number you have dialled is not in service.");
  if (to!.status === "blocked") refuse("failed", "The number you are calling is switched off.");
  if (liveCallOf(w, dialled)) refuse("busy", "The number you are calling is busy.");
  if (w.now - (w.presence.get(dialled) ?? 0) > GONE_MS) {
    // Nobody has that phone open: it behaves as switched off, and the network tells its owner later.
    sendSms(w, dialled, TELCO_INFO[to!.telco].name, `You missed a call from ${from.msisdn} at ${clock(w.now)} while your phone was off.`);
    refuse("missed", "The number you are calling cannot be reached. Their phone is switched off.");
  }

  // The called person's network may have plugged in an API that screens calls before they ring.
  const d = consult(w, to!.telco, "call.connect", {
    from: from.msisdn,
    fromNetwork: from.telco,
    callerSimRegisteredAt: from.registered_at ? new Date(from.registered_at).toISOString() : null,
    to: dialled,
    toNetwork: to!.telco,
    callsBetweenThemBefore: count(w.db, "SELECT COUNT(*) AS n FROM calls WHERE answered_at IS NOT NULL AND ((from_msisdn = ? AND to_msisdn = ?) OR (from_msisdn = ? AND to_msisdn = ?))", from.msisdn, dialled, dialled, from.msisdn),
    numbersTheCallerHasRungToday: count(w.db, "SELECT COUNT(DISTINCT to_msisdn) AS n FROM calls WHERE from_msisdn = ? AND started_at >= ?", from.msisdn, w.now - (w.now % 86_400_000)),
  });
  if (d.decision === "reject") refuse("failed", "The number you are calling is not available.");

  const id = record(w, { ...base, status: "ringing", reason: null });
  w.calls.set(id, { offer: req.offer, candidates: { caller: [], callee: [] }, seen: { caller: w.now, callee: w.now }, callerDevice: req.device, warning: d.decision === "warn" ? (d.message ?? "Possible scam call") : undefined });
  return { id };
}

/** A call to customer care joins the queue for the caller's own network. Any agent who is on line can take it. */
function callCare(w: World, from: string, telco: Telco, req: { device: string; offer: string }): { id: string } {
  if (typeof req.offer !== "string" || !req.offer || req.offer.length > MAX_SDP) throw new SimError("The call could not be set up on this phone.");
  expire(w);
  if (liveCallOf(w, from)) throw new SimError("You are already on a call.");
  const base = { from_msisdn: from, to_msisdn: CARE_LINE, from_telco: telco, to_telco: telco };
  if (w.now - (w.presence.get(careEndpoint(telco)) ?? 0) > GONE_MS) {
    const reason = `${TELCO_INFO[telco].name} customer care is closed. No agent is on line right now.`;
    record(w, { ...base, status: "failed", reason });
    throw new SimError(reason);
  }
  const id = record(w, { ...base, status: "ringing", reason: null });
  w.calls.set(id, { offer: req.offer, candidates: { caller: [], callee: [] }, seen: { caller: w.now, callee: w.now }, callerDevice: req.device });
  return { id };
}

/** The call a care agent's screen should show: the one it is on, else the caller who has waited longest. */
function careCall(w: World, telco: Telco, device: string): CallRow | undefined {
  const rows = w.db.prepare("SELECT * FROM calls WHERE status IN ('ringing','active') AND to_msisdn = ? AND from_telco = ? ORDER BY started_at, rowid").all(CARE_LINE, telco) as unknown as CallRow[];
  return rows.find((c) => w.calls.get(c.id)?.calleeDevice === device) ?? rows.find((c) => c.status === "ringing" && !w.calls.get(c.id)?.calleeDevice);
}

/** How many callers are waiting for a customer care agent. */
export function careQueue(w: World, telco: Telco): number {
  expire(w);
  return Number((w.db.prepare("SELECT COUNT(*) AS n FROM calls WHERE status = 'ringing' AND to_msisdn = ? AND from_telco = ?").get(CARE_LINE, telco) as { n: number }).n);
}

export interface CallState {
  id: string;
  role: "caller" | "callee";
  peer: string;
  peerNetwork: string;
  status: CallRow["status"];
  reason: string | null;
  startedAt: number;
  answeredAt: number | null;
  /** For the phone being called: the caller's side of the audio connection. */
  offer?: string;
  /** For the caller: the other phone's reply, once it has answered. */
  answer?: string;
  /** For the called phone: a label its network put on this call. */
  warning?: string;
  /** The other phone's network paths, beyond the `have` already received. */
  candidates: unknown[];
}

/**
 * A phone checks in about once a second: it reports that it is on, hands over any new network
 * paths, and learns of an incoming call or of changes to the call it is on.
 */
export function pollCall(w: World, req: { msisdn: string; device: string; callId?: string; have?: number; candidates?: unknown[] }): { call: CallState | null; elsewhere?: boolean } {
  const msisdn = endpointOf(req.msisdn);
  const care = careOf(msisdn);
  w.presence.set(msisdn, w.now);
  expire(w);
  const c = (req.callId ? getCall(w, req.callId) : undefined) ?? (care ? careCall(w, care, req.device) : liveCallOf(w, msisdn));
  if (!c || !isParty(c, msisdn)) return { call: null };
  const role = c.from_msisdn === msisdn ? "caller" : "callee";
  const s = w.calls.get(c.id);

  if (live(c) && s) {
    // A call belongs to the phone that placed it and, once answered, to the phone that answered.
    const mine = role === "caller" ? s.callerDevice === req.device : !s.calleeDevice || s.calleeDevice === req.device;
    if (!mine) return { call: null, elsewhere: true };
    if (role === "caller" || s.calleeDevice) s.seen[role] = w.now;
    if (Array.isArray(req.candidates) && s.candidates[role].length < MAX_CANDIDATES) s.candidates[role].push(...req.candidates.slice(0, MAX_CANDIDATES - s.candidates[role].length));
  } else if (!req.callId) {
    return { call: null };
  }

  const other = role === "caller" ? "callee" : "caller";
  const peer = role === "caller" ? c.to_msisdn : c.from_msisdn;
  const peerTelco = role === "caller" ? c.to_telco : c.from_telco;
  return {
    call: {
      id: c.id,
      role,
      peer,
      peerNetwork: peerTelco ? (peer === CARE_LINE ? `${TELCO_INFO[peerTelco].name} customer care` : TELCO_INFO[peerTelco].name) : "",
      status: c.status,
      reason: c.reason,
      startedAt: c.started_at,
      answeredAt: c.answered_at,
      warning: s && role === "callee" ? s.warning : undefined,
      offer: s && role === "callee" ? s.offer : undefined,
      answer: s && role === "caller" ? s.answer : undefined,
      candidates: s ? s.candidates[other].slice(Math.max(0, Number(req.have ?? 0))) : [],
    },
  };
}

/** The called phone picks up, sending its side of the audio connection (the answer). */
export function answerCall(w: World, req: { callId: string; msisdn: string; device: string; answer: string }) {
  expire(w);
  const c = getCall(w, req.callId);
  const s = c ? w.calls.get(c.id) : undefined;
  if (!c || !s || c.status !== "ringing" || !isCallee(c, endpointOf(req.msisdn))) throw new SimError("This call is no longer ringing.");
  if (typeof req.answer !== "string" || !req.answer || req.answer.length > MAX_SDP) throw new SimError("The call could not be answered on this phone.");
  s.answer = req.answer;
  s.calleeDevice = req.device;
  s.seen.callee = w.now;
  w.db.prepare("UPDATE calls SET status = 'active', answered_at = ? WHERE id = ?").run(w.now, c.id);
}

/** Either phone ends the call: hanging up, declining, or giving up before it is answered. */
export function endCall(w: World, req: { callId: string; msisdn: string; reason?: string }) {
  const c = getCall(w, req.callId);
  const msisdn = endpointOf(req.msisdn);
  if (!c || !live(c) || !isParty(c, msisdn)) return;
  if (c.status === "active") finish(w, c, "ended", req.reason ?? "Call ended");
  else if (isCallee(c, msisdn)) finish(w, c, "declined", "Call declined");
  else finish(w, c, "missed", "Caller hung up before it was answered");
}

export function callSeconds(c: Pick<CallRow, "answered_at" | "ended_at">) {
  return c.answered_at && c.ended_at ? Math.max(0, Math.round((c.ended_at - c.answered_at) / 1000)) : 0;
}

/** A phone's call log. */
export function callLog(w: World, msisdn: string, limit = 30) {
  const rows = w.db.prepare("SELECT * FROM calls WHERE from_msisdn = ? OR to_msisdn = ? ORDER BY started_at DESC, rowid DESC LIMIT ?").all(msisdn, msisdn, limit) as unknown as CallRow[];
  return rows.map((c) => {
    const out = c.from_msisdn === msisdn;
    return {
      id: c.id,
      at: new Date(c.started_at).toISOString(),
      number: out ? c.to_msisdn : c.from_msisdn,
      direction: out ? ("outgoing" as const) : c.answered_at || c.status === "declined" ? ("incoming" as const) : ("missed" as const),
      status: c.status,
      reason: c.reason,
      seconds: callSeconds(c),
    };
  });
}

export type { CallSignal };

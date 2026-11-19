import { getConfig } from "./config/store";
import { getSim } from "./telco";
import { ussd, type UssdReply } from "./ussd";
import { SimError, TELCOS, TELCO_INFO, need, newId, type Telco } from "./util";
import { audit, type World } from "./world";

/**
 * USSD services run by outside providers. The NCA allocates a short code to a provider; each
 * network then switches the code on for its own subscribers. When a subscriber dials it, the
 * network forwards every step of the session to the provider's application and shows what it sends back.
 */

export interface UssdCode {
  code: string;
  owner: string;
  url: string;
  status: "allocated" | "revoked";
  created_at: number;
}

const getCode = (w: World, code: string) => w.db.prepare("SELECT * FROM ussd_codes WHERE code = ?").get(code) as UssdCode | undefined;
const reserved = (w: World) => new Set<string>(["*400#", "*402*1#", "*124#", "*156#", "*127#", "*703#", ...TELCOS.map((t) => getConfig(w.db, `telco.${t}`).menu.shortcode)]);

export function allocateCode(w: World, input: { code?: string; owner?: string; url?: string }): UssdCode {
  const code = String(need(input.code?.trim(), "Short code"));
  if (!/^\*\d{3,4}(\*\d{1,4})?#$/.test(code)) throw new SimError("A short code looks like *714# or *714*20#");
  if (reserved(w).has(code)) throw new SimError(`${code} is already used by the networks themselves`);
  if (getCode(w, code)?.status === "allocated") throw new SimError(`${code} is already allocated`);
  const owner = String(need(input.owner?.trim(), "Service provider")).slice(0, 60);
  const url = String(need(input.url?.trim(), "The provider's application address"));
  if (!/^https?:\/\//.test(url)) throw new SimError("The application address must start with http:// or https://");
  w.db.prepare("INSERT INTO ussd_codes(code, owner, url, status, created_at) VALUES(?,?,?, 'allocated', ?) ON CONFLICT(code) DO UPDATE SET owner = excluded.owner, url = excluded.url, status = 'allocated', created_at = excluded.created_at").run(code, owner, url, w.now);
  audit(w, "nca", "short_code", `Allocated ${code} to ${owner}`);
  return getCode(w, code)!;
}

export function revokeCode(w: World, code: string) {
  const c = getCode(w, code);
  if (!c || c.status !== "allocated") throw new SimError("Short code not found");
  w.db.prepare("UPDATE ussd_codes SET status = 'revoked' WHERE code = ?").run(code);
  w.db.prepare("DELETE FROM ussd_activations WHERE code = ?").run(code);
  audit(w, "nca", "short_code", `Withdrew ${code} from ${c.owner}`);
}

/** A network switches an allocated code on or off for its own subscribers. */
export function setActivation(w: World, telco: Telco, code: string, on: boolean) {
  const c = getCode(w, code);
  if (!c || c.status !== "allocated") throw new SimError("The NCA has not allocated that short code");
  if (on) w.db.prepare("INSERT OR IGNORE INTO ussd_activations(code, telco) VALUES(?,?)").run(code, telco);
  else w.db.prepare("DELETE FROM ussd_activations WHERE code = ? AND telco = ?").run(code, telco);
  audit(w, telco, "short_code", `${on ? "Switched on" : "Switched off"} ${code} (${c.owner}) on this network`);
}

export function listCodes(w: World) {
  const rows = w.db.prepare("SELECT * FROM ussd_codes WHERE status = 'allocated' ORDER BY created_at").all() as unknown as UssdCode[];
  const on = w.db.prepare("SELECT code, telco FROM ussd_activations").all() as { code: string; telco: string }[];
  return rows.map((c) => ({ code: c.code, owner: c.owner, url: c.url, allocatedAt: new Date(c.created_at).toISOString(), networks: on.filter((a) => a.code === c.code).map((a) => a.telco) }));
}

const TIMEOUT_MS = 3000;

interface External {
  code: string;
  url: string;
  inputs: string[];
}

/** One step of a provider's session: send what the subscriber typed, show what the application answers. */
async function forward(w: World, session: { id: string; msisdn: string; telco: string }, ext: External, input: string, newSession: boolean): Promise<{ text: string; end: boolean }> {
  try {
    const res = await fetch(ext.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: session.id, serviceCode: ext.code, msisdn: session.msisdn, network: session.telco, newSession, input, text: ext.inputs.join("*") }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const raw = (await res.text()).trim();
    if (!res.ok || !raw) throw new Error(`status ${res.status}`);
    // Either {"message": "...", "continueSession": true} or plain text starting with CON (more to come) or END.
    if (raw.startsWith("{")) {
      const j = JSON.parse(raw) as { message?: string; continueSession?: boolean };
      return { text: String(j.message ?? ""), end: j.continueSession === false };
    }
    if (/^END\b/i.test(raw)) return { text: raw.replace(/^END\s*/i, ""), end: true };
    return { text: raw.replace(/^CON\s*/i, ""), end: false };
  } catch {
    return { text: "The service is not responding. Please try again later.", end: true };
  }
}

/**
 * What a phone's dialler calls. A provider's short code is forwarded to the provider's application;
 * everything else is handled by the network's own menus.
 */
export async function dial(w: World, args: { sessionId?: string; msisdn: string; input: string }): Promise<UssdReply> {
  const existing = args.sessionId ? w.ussd.get(args.sessionId) : undefined;
  const sim = getSim(w, args.msisdn);
  const limit = (text: string, telco: string) => {
    const max = getConfig(w.db, `telco.${telco}`).menu.screenCharLimit;
    return text.length > max ? text.slice(0, max - 1) + "…" : text;
  };

  if (existing?.pending?.kind === "external") {
    const ext = existing.pending.data as External;
    existing.lastAt = Date.now();
    ext.inputs.push(args.input.trim());
    const r = await forward(w, existing, ext, args.input.trim(), false);
    if (r.end) w.ussd.delete(existing.id);
    return { sessionId: existing.id, text: limit(r.text, existing.telco), end: r.end };
  }

  const code = !existing ? getCode(w, args.input.trim()) : undefined;
  if (code?.status === "allocated" && sim?.status === "active") {
    const active = w.db.prepare("SELECT 1 FROM ussd_activations WHERE code = ? AND telco = ?").get(code.code, sim.telco);
    if (!active) return { sessionId: "", text: `${code.code} is not available on ${TELCO_INFO[sim.telco].name}.`, end: true };
    const ext: External = { code: code.code, url: code.url, inputs: [] };
    const session = { id: newId("ussd"), msisdn: sim.msisdn, telco: sim.telco, node: "", vars: {}, startedAt: Date.now(), lastAt: Date.now(), pending: { kind: "external", data: ext } };
    const r = await forward(w, session, ext, "", true);
    if (!r.end) w.ussd.set(session.id, session);
    return { sessionId: session.id, text: limit(r.text, sim.telco), end: r.end };
  }

  return ussd(w, args);
}

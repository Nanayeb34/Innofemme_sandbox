import type { WalletRow } from "./ledger";
import { logSms, sendSms, smsParts } from "./notify";
import { getSim } from "./telco";
import { SimError, TELCO_INFO, need, normalizeMsisdn, type Telco } from "./util";
import type { World } from "./world";

/**
 * Text messages people and businesses send. (The texts a network sends about its own services are
 * in notify.ts.) A phone that is not open still receives its messages: they wait in its inbox.
 */

export const MAX_SMS_PARTS = 3;
const MAX_LENGTH = MAX_SMS_PARTS * 160;

export interface SendResult {
  delivered: boolean;
  parts: number;
  to: string;
  /** Why it was not delivered, when it was not. */
  reason?: string;
}

function textOf(input: unknown): string {
  const text = String(need(typeof input === "string" ? input.trim() : "", "Message"));
  if (text.length > MAX_LENGTH) throw new SimError(`Message is too long. The limit is ${MAX_LENGTH} characters (${MAX_SMS_PARTS} messages).`);
  return text;
}

/** Why a number cannot receive a text right now, if it cannot. */
function undeliverable(w: World, to: string): string | undefined {
  const sim = getSim(w, to);
  if (!sim || sim.status === "in_stock" || sim.status === "deactivated") return "Number not in service";
  if (sim.status === "blocked") return "The number is blocked and cannot receive messages";
}

function deliver(w: World, to: string, sender: string, text: string, meta: { kind: "person" | "app"; fromTelco: Telco }): SendResult {
  const reason = undeliverable(w, to);
  if (reason) logSms(w, to, sender, text, meta, reason);
  else sendSms(w, to, sender, text, meta);
  return { delivered: !reason, parts: smsParts(text), to, reason };
}

/** One person texts another, on any network. */
export function sendText(w: World, req: { from: string; to?: string; text?: unknown }): SendResult {
  const from = getSim(w, normalizeMsisdn(req.from));
  if (!from || from.status !== "active") throw new SimError("No network service. This SIM is not active.");
  const to = normalizeMsisdn(String(need(req.to, "Number to send to")));
  if (!/^0\d{9}$/.test(to)) throw new SimError("That is not a valid mobile number.");
  return deliver(w, to, from.msisdn, textOf(req.text), { kind: "person", fromTelco: from.telco });
}

/** The name a business's texts arrive under: its registered name, letters and digits only, at most 11 characters. */
export const senderIdOf = (merchant: Pick<WalletRow, "display_name">) => merchant.display_name.replace(/[^A-Za-z0-9]/g, "").slice(0, 11) || "INFO";

/**
 * A business texts a customer from its own software. The message arrives under the business's
 * registered sender name, which the customer cannot reply to.
 */
export function sendAppSms(w: World, merchant: WalletRow, req: { to?: string; text?: unknown }): SendResult & { senderId: string } {
  if (merchant.owner_type !== "merchant") throw new SimError("Only an onboarded merchant can send messages from an app");
  if (merchant.status !== "active") throw new SimError("This merchant's wallet is not active");
  const to = normalizeMsisdn(String(need(req.to, "Number to send to")));
  if (!/^0\d{9}$/.test(to)) throw new SimError("That is not a valid mobile number.");
  const senderId = senderIdOf(merchant);
  return { ...deliver(w, to, senderId, textOf(req.text), { kind: "app", fromTelco: merchant.telco }), senderId };
}

const isNumber = (s: string) => /^0\d{9}$/.test(s);

interface Message {
  id: string;
  at: number;
  out: boolean;
  body: string;
  failed: string | null;
}

/**
 * Everything one phone has sent and received, oldest first, with who it was with.
 * Read from the networks' message log, whose single sequence gives the true order.
 */
function messagesOf(w: World, msisdn: string): (Message & { with: string })[] {
  const rows = w.db
    .prepare("SELECT id, at, kind, sender, to_msisdn, body, status, reason FROM sms_log WHERE (to_msisdn = ? AND status = 'delivered') OR (kind = 'person' AND sender = ?) ORDER BY id DESC LIMIT 400")
    .all(msisdn, msisdn) as { id: number; at: number; kind: string; sender: string; to_msisdn: string; body: string; status: string; reason: string | null }[];
  const out: (Message & { with: string })[] = [];
  for (const m of rows.reverse()) {
    const sent = m.kind === "person" && m.sender === msisdn;
    if (sent) out.push({ id: `out${m.id}`, at: m.at, out: true, body: m.body, failed: m.status === "failed" ? (m.reason ?? "Not delivered") : null, with: m.to_msisdn });
    // A text to your own number shows on both sides of the conversation.
    if (m.to_msisdn === msisdn && m.status === "delivered") out.push({ id: `in${m.id}`, at: m.at, out: false, body: m.body, failed: null, with: m.sender });
  }
  return out;
}

/** A phone's conversations, most recent first. */
export function conversations(w: World, msisdn: string) {
  const byOther = new Map<string, { with: string; canReply: boolean; lastBody: string; lastAt: number; lastOut: boolean; count: number }>();
  for (const m of messagesOf(w, msisdn)) {
    const c = byOther.get(m.with);
    byOther.set(m.with, { with: m.with, canReply: isNumber(m.with), lastBody: m.body, lastAt: m.at, lastOut: m.out, count: (c?.count ?? 0) + 1 });
  }
  return [...byOther.values()].sort((a, b) => b.lastAt - a.lastAt).map((c) => ({ ...c, lastAt: new Date(c.lastAt).toISOString() }));
}

/** One conversation: the texts between this phone and one number or sender name. */
export function thread(w: World, msisdn: string, other: string) {
  const who = isNumber(normalizeMsisdn(other)) ? normalizeMsisdn(other) : other;
  return {
    with: who,
    canReply: isNumber(who),
    messages: messagesOf(w, msisdn)
      .filter((m) => m.with === who)
      .slice(-80)
      .map(({ id, at, out, body, failed }) => ({ id, at: new Date(at).toISOString(), out, body, failed })),
  };
}

/** A network's message records: every text sent from it or to it. */
export function smsRecords(w: World, telco: Telco, limit = 200) {
  const rows = w.db.prepare("SELECT * FROM sms_log WHERE from_telco = ? OR to_telco = ? ORDER BY id DESC LIMIT ?").all(telco, telco, limit) as {
    id: number; at: number; kind: string; sender: string; from_telco: string | null; to_msisdn: string; to_telco: string | null; body: string; parts: number; status: string; reason: string | null;
  }[];
  const name = (t: string | null) => (t && t in TELCO_INFO ? TELCO_INFO[t as Telco].name : "");
  return rows.map((r) => ({ id: r.id, at: new Date(r.at).toISOString(), kind: r.kind, from: r.sender, fromNetwork: name(r.from_telco), to: r.to_msisdn, toNetwork: name(r.to_telco), body: r.body, parts: r.parts, status: r.status, reason: r.reason }));
}

/** What one business has sent from its app. */
export function appSmsSent(w: World, merchant: WalletRow, limit = 100) {
  return (w.db.prepare("SELECT id, at, to_msisdn, body, parts, status, reason FROM sms_log WHERE kind = 'app' AND sender = ? AND from_telco = ? ORDER BY id DESC LIMIT ?").all(senderIdOf(merchant), merchant.telco, limit) as {
    id: number; at: number; to_msisdn: string; body: string; parts: number; status: string; reason: string | null;
  }[]).map((r) => ({ id: r.id, at: new Date(r.at).toISOString(), to: r.to_msisdn, text: r.body, parts: r.parts, status: r.status, reason: r.reason ?? undefined }));
}

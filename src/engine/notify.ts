import { getConfig } from "./config/store";
import type { NotificationEvent } from "./config/schemas";
import type { World } from "./world";
import { notifications as standard } from "./config/defaults";
import { TELCO_INFO, type Telco } from "./util";

export function render(template: string, vars: Record<string, string | number | undefined>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) => (vars[k] === undefined ? "" : String(vars[k])));
}

/** Sends the telco's SMS for an event to one of its subscribers, if that notification is switched on. */
export function notify(w: World, telco: Telco, event: NotificationEvent, msisdn: string, vars: Record<string, string | number | undefined>) {
  // An event the telco has not customised (for example one added after its world was created) uses the standard wording.
  const n = getConfig(w.db, `telco.${telco}`).notifications[event] ?? standard(telco)[event];
  if (!n.enabled) return;
  sendSms(w, msisdn, TELCO_INFO[telco].wallet.replace(/\s/g, ""), render(n.template, vars));
}

/** How many 160-character messages a text is sent as. */
export const smsParts = (body: string) => Math.max(1, Math.ceil(body.length / 160));

export interface SmsMeta {
  kind: "person" | "network" | "app";
  fromTelco?: string | null;
}

/** Records a text in the networks' message log, whether or not it could be delivered. */
export function logSms(w: World, to: string, sender: string, body: string, meta: SmsMeta, failure?: string) {
  const sim = w.db.prepare("SELECT telco FROM sims WHERE msisdn = ?").get(to) as { telco: string } | undefined;
  w.db
    .prepare("INSERT INTO sms_log(at, kind, sender, from_telco, to_msisdn, to_telco, body, parts, status, reason) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run(w.now, meta.kind, sender, meta.fromTelco ?? sim?.telco ?? null, to, sim?.telco ?? null, body, smsParts(body), failure ? "failed" : "delivered", failure ?? null);
}

/** Puts a text in a phone's inbox and on the networks' message log. Texts from the network itself are the default. */
export function sendSms(w: World, msisdn: string, sender: string, body: string, meta: SmsMeta = { kind: "network" }) {
  w.db.prepare("INSERT INTO sms(msisdn, sender, body, at) VALUES(?,?,?,?)").run(msisdn, sender, body, w.now);
  logSms(w, msisdn, sender, body, meta);
}

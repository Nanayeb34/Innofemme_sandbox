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

export function sendSms(w: World, msisdn: string, sender: string, body: string) {
  w.db.prepare("INSERT INTO sms(msisdn, sender, body, at) VALUES(?,?,?,?)").run(msisdn, sender, body, w.now);
}

import { getConfig } from "./config/store";
import type { NotificationEvent } from "./config/schemas";
import type { World } from "./world";
import { TELCO_INFO, telcoOf } from "./util";

export function render(template: string, vars: Record<string, string | number | undefined>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) => (vars[k] === undefined ? "" : String(vars[k])));
}

export function notificationEnabled(w: World, event: NotificationEvent): boolean {
  return getConfig(w.db, "notifications").rules.some((r) => r.event === event && r.enabled);
}

/** Sends every enabled notification for an event. Returns true when at least one went out. */
export function notify(w: World, event: NotificationEvent, msisdn: string, vars: Record<string, string | number | undefined>): boolean {
  const rules = getConfig(w.db, "notifications").rules.filter((r) => r.event === event && r.enabled);
  const telco = telcoOf(msisdn);
  const sender = telco ? TELCO_INFO[telco].wallet.replace(/\s/g, "") : "MobileMoney";
  for (const r of rules) sendSms(w, msisdn, sender, render(r.template, vars));
  return rules.length > 0;
}

export function sendSms(w: World, msisdn: string, sender: string, body: string, scenario?: string) {
  w.db
    .prepare("INSERT INTO sms(msisdn, sender, body, at, scenario, is_fraud) VALUES(?,?,?,?,?,?)")
    .run(msisdn, sender, body, w.now, scenario ?? null, scenario ? 1 : 0);
}

export function placeCall(w: World, msisdn: string, caller: string, label: string, script: string, scenario: string) {
  w.db
    .prepare("INSERT INTO calls(msisdn, caller, caller_label, script, at, scenario, is_fraud) VALUES(?,?,?,?,?,?,1)")
    .run(msisdn, caller, label, script, w.now, scenario);
}

export const cedis = (pesewas: number) => (pesewas / 100).toFixed(2);

export const clock = (ms: number) => {
  const d = new Date(ms);
  return `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
};

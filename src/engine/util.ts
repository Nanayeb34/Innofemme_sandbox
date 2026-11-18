import { randomInt, randomUUID } from "node:crypto";

export const TELCOS = ["mtn", "telecel", "at"] as const;
export type Telco = (typeof TELCOS)[number];

export const TELCO_INFO: Record<Telco, { name: string; wallet: string; shortcode: string; prefixes: string[]; color: string; careLine: string }> = {
  mtn: { name: "MTN", wallet: "MTN MoMo", shortcode: "*170#", prefixes: ["024", "025", "053", "054", "055", "059"], color: "#ffcb05", careLine: "100" },
  telecel: { name: "Telecel", wallet: "Telecel Cash", shortcode: "*110#", prefixes: ["020", "050"], color: "#e60000", careLine: "100" },
  at: { name: "AT", wallet: "AT Money", shortcode: "*110#", prefixes: ["026", "027", "056", "057"], color: "#1f3c88", careLine: "100" },
};

export const BANKS = [
  { id: "gcb", name: "GCB Bank", sortCode: "040" },
  { id: "ecobank", name: "Ecobank Ghana", sortCode: "130" },
  { id: "fidelity", name: "Fidelity Bank", sortCode: "240" },
  { id: "calbank", name: "CalBank", sortCode: "140" },
  { id: "absa", name: "Absa Bank Ghana", sortCode: "030" },
  { id: "stanbic", name: "Stanbic Bank", sortCode: "190" },
] as const;
export type BankId = (typeof BANKS)[number]["id"];
export const BANK_IDS = BANKS.map((b) => b.id) as string[];
export const bankName = (id: string) => BANKS.find((b) => b.id === id)?.name ?? id;

/**
 * The bank that holds each telco's e-money float (trust account) in this sandbox.
 * Real issuers spread their float across several partner banks; one each keeps the simulation readable.
 */
export const TRUST_BANK: Record<Telco, BankId> = { mtn: "gcb", telecel: "ecobank", at: "fidelity" };

/** Everyone connected to the national switch. */
export const PARTICIPANTS = [...TELCOS, ...BANK_IDS] as string[];
export const isTelco = (p: string): p is Telco => (TELCOS as readonly string[]).includes(p);
export const participantName = (p: string) => (isTelco(p) ? TELCO_INFO[p].wallet : bankName(p));

export const REGIONS = [
  "Greater Accra", "Ashanti", "Central", "Western", "Western North", "Eastern", "Volta", "Oti", "Northern", "Savannah", "North East", "Upper East", "Upper West", "Bono", "Bono East", "Ahafo",
] as const;

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** GH¢ to pesewas. */
export const ghs = (cedis: number) => Math.round(cedis * 100);
export const cedis = (pesewas: number) => (pesewas / 100).toFixed(2);
export const fmt = (pesewas: number) => `GHS ${cedis(pesewas)}`;

export const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
export const digits = (n: number) => Array.from({ length: n }, () => randomInt(10)).join("");
const ALNUM = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const code = (n: number) => Array.from({ length: n }, () => ALNUM[randomInt(ALNUM.length)]).join("");

export function telcoOf(msisdn: string): Telco | undefined {
  const prefix = msisdn.slice(0, 3);
  return TELCOS.find((t) => TELCO_INFO[t].prefixes.includes(prefix));
}

/** Accepts 0241234567, 233241234567, +233 24 123 4567. Returns local 10-digit form. */
export function normalizeMsisdn(input: string): string {
  const d = String(input ?? "").replace(/\D/g, "");
  if (d.startsWith("233") && d.length === 12) return "0" + d.slice(3);
  if (d.length === 9) return "0" + d;
  return d;
}

export const toIntl = (msisdn: string) => "233" + msisdn.slice(1);

export const clock = (ms: number) => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
};

/** A rule of the simulated system was broken (bad input, failed verification, limit reached). Shown to the user as-is. */
export class SimError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export function need<T>(v: T | undefined | null | "", what: string): T {
  if (v === undefined || v === null || v === "") throw new SimError(`${what} is required`);
  return v as T;
}

export function amountOf(v: unknown, what = "Amount"): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new SimError(`${what} must be more than zero`);
  const p = Math.round(n * 100);
  if (Math.abs(p - n * 100) > 1e-6) throw new SimError(`${what} cannot have more than two decimal places`);
  return p;
}

import { randomUUID } from "node:crypto";

export const TELCOS = ["mtn", "telecel", "at"] as const;
export type Telco = (typeof TELCOS)[number];

export const TELCO_INFO: Record<Telco, { name: string; wallet: string; shortcode: string; prefixes: string[]; color: string }> = {
  mtn: { name: "MTN", wallet: "MTN MoMo", shortcode: "*170#", prefixes: ["024", "054", "055", "059"], color: "#ffcb05" },
  telecel: { name: "Telecel", wallet: "Telecel Cash", shortcode: "*110#", prefixes: ["020", "050"], color: "#e60000" },
  at: { name: "AT", wallet: "AT Money", shortcode: "*110#", prefixes: ["026", "027", "056", "057"], color: "#1f3c88" },
};

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** GH¢ to pesewas. */
export const ghs = (cedis: number) => Math.round(cedis * 100);
export const fmt = (pesewas: number) => `GHS ${(pesewas / 100).toFixed(2)}`;

export const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;

/** Deterministic PRNG (mulberry32) so a seed always produces the same world. */
export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0;
  }
  next(): number {
    let t = (this.s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  /** Poisson-distributed count with the given mean. */
  poisson(mean: number): number {
    if (mean <= 0) return 0;
    if (mean > 30) return Math.max(0, Math.round(mean + Math.sqrt(mean) * this.normal()));
    const L = Math.exp(-mean);
    let k = 0;
    let p = 1;
    do {
      k++;
      p *= this.next();
    } while (p > L);
    return k - 1;
  }
  normal(): number {
    const u = 1 - this.next();
    const v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  /** Log-normal amount in cedis, rounded to a "human" value. */
  amount(medianCedis: number, spread = 0.8): number {
    const raw = medianCedis * Math.exp(spread * this.normal());
    const step = raw < 20 ? 1 : raw < 200 ? 5 : raw < 1000 ? 10 : 50;
    return Math.max(1, Math.round(raw / step) * step);
  }
}

export function telcoOf(msisdn: string): Telco | undefined {
  const prefix = msisdn.slice(0, 3);
  return TELCOS.find((t) => TELCO_INFO[t].prefixes.includes(prefix));
}

/** Accepts 0241234567, 233241234567, +233 24 123 4567. Returns local 10-digit form. */
export function normalizeMsisdn(input: string): string {
  const digits = input.replace(/\D/g, "");
  if (digits.startsWith("233") && digits.length === 12) return "0" + digits.slice(3);
  if (digits.length === 9) return "0" + digits;
  return digits;
}

export const toIntl = (msisdn: string) => "233" + msisdn.slice(1);

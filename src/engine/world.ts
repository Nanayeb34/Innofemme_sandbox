import type { DB } from "./db";
import { getMeta, setMeta } from "./db";
import { Rng } from "./util";

export interface UssdSession {
  id: string;
  msisdn: string;
  telco: string;
  node: string;
  vars: Record<string, string>;
  startedAt: number; // real ms
  lastAt: number; // real ms
  pending?: { kind: "warning" | "otp" | "approvals"; data?: unknown };
}

/** A team's isolated copy of the money system, open in this process. */
export interface World {
  id: string;
  db: DB;
  rng: Rng;
  now: number; // simulated epoch ms
  ussd: Map<string, UssdSession>;
  otps: Map<string, string>; // msisdn -> pending one-time code
  lock: Promise<unknown>;
  cache?: PopulationCache;
}

export interface PopulationCache {
  customers: string[]; // wallet ids of ordinary customers (bots may send from these)
  personas: string[]; // wallet ids played by participants
  agents: string[];
  agentsByTelco: Record<string, string[]>;
  colludingAgents: string[];
  merchants: string[];
  fakeMerchants: string[];
  fraudsters: string[];
  mules: string[];
  minimumMules: string[];
  bankAccounts: { id: string; wallet: string }[];
  payroll: string[]; // bank accounts that pay salaries
}

export function makeWorld(id: string, db: DB): World {
  return {
    id,
    db,
    rng: new Rng((Date.now() ^ hash(id)) >>> 0),
    now: Number(getMeta(db, "sim_now")),
    ussd: new Map(),
    otps: new Map(),
    lock: Promise.resolve(),
  };
}

/** Serialises all work on one world so ticks, USSD and API calls never interleave. */
export function withLock<T>(w: World, fn: () => Promise<T> | T): Promise<T> {
  const run = w.lock.then(fn, fn);
  w.lock = run.catch(() => undefined);
  return run;
}

export function advanceClock(w: World, to: number) {
  w.now = to;
  setMeta(w.db, "sim_now", to);
}

function hash(s: string) {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h;
}

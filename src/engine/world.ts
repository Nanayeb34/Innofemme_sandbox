import type { DB } from "./db";

export interface UssdSession {
  id: string;
  msisdn: string;
  telco: string;
  node: string;
  vars: Record<string, string>;
  startedAt: number;
  lastAt: number;
  pending?: { kind: string; data?: unknown };
}

/** What two phones exchange to set up the audio of a call. Kept in memory only: it is useless once the call ends. */
export interface CallSignal {
  offer: string;
  answer?: string;
  candidates: { caller: unknown[]; callee: unknown[] };
  seen: { caller: number; callee: number };
  callerDevice: string;
  calleeDevice?: string;
}

/** A team's isolated copy of the country's systems, open in this process. */
export interface World {
  id: string;
  db: DB;
  /** Current time. The world runs on the real clock. */
  readonly now: number;
  ussd: Map<string, UssdSession>;
  /** One-time codes waiting to be entered, by purpose. */
  otps: Map<string, string>;
  /** Live calls being set up or in progress, by call id. */
  calls: Map<string, CallSignal>;
  /** When each number's phone screen was last open, to tell "switched off" from "not answering". */
  presence: Map<string, number>;
  lock: Promise<unknown>;
}

export function makeWorld(id: string, db: DB): World {
  return {
    id,
    db,
    get now() {
      return Date.now();
    },
    ussd: new Map(),
    otps: new Map(),
    calls: new Map(),
    presence: new Map(),
    lock: Promise.resolve(),
  };
}

/** Serialises all work on one world so requests never interleave. */
export function withLock<T>(w: World, fn: () => Promise<T> | T): Promise<T> {
  const run = w.lock.then(fn, fn);
  w.lock = run.catch(() => undefined);
  return run;
}

/** Records what an institution did, for the activity log. */
export function audit(w: World, system: string, action: string, summary: string) {
  w.db.prepare("INSERT INTO audit(at, system, action, summary) VALUES(?,?,?,?)").run(w.now, system, action, summary);
}

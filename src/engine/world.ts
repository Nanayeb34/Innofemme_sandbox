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
  /** A label the called person's network puts on the incoming call screen. */
  warning?: string;
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
  /** Set only while simulated history is being written: the moment being written, in place of the real time. */
  clock?: number;
  /** Set by the fraud simulator while it plays a step: told each answer a plugged-in API gave. */
  watch?: (seen: { key: string; institution: string; point: string; decision: string; message?: string; by?: string }) => void;
  /** Set by the fraud simulator while it tests a standalone application: every step asks this one address, and no plugged-in API. */
  direct?: { id: string; name: string; url: string };
  /** Payments an outside API asked to delay: when each may be tried again. */
  cooldowns: Map<string, number>;
  /** Answers from plugged-in APIs for the request being handled now. See integrations.ts. */
  answers: Map<string, unknown>;
  /** True while a request is being handled somewhere that can wait for an outside API. */
  asking: boolean;
  /** Events to tell plugged-in APIs about once the current request has succeeded. */
  outbox: { institution: string; event: string; data: unknown }[];
  /** Whose turn it is: one request at a time works on a world, the rest wait in line. */
  lock: { held: boolean; waiting: (() => void)[] };
}

export function makeWorld(id: string, db: DB): World {
  return {
    id,
    db,
    get now() {
      return this.clock ?? Date.now();
    },
    ussd: new Map(),
    otps: new Map(),
    calls: new Map(),
    presence: new Map(),
    cooldowns: new Map(),
    answers: new Map(),
    asking: false,
    outbox: [],
    lock: { held: false, waiting: [] },
  };
}

function takeTurn(w: World): Promise<void> {
  if (!w.lock.held) {
    w.lock.held = true;
    return Promise.resolve();
  }
  return new Promise((go) => w.lock.waiting.push(go));
}

function endTurn(w: World) {
  // The turn passes straight to whoever has waited longest.
  const next = w.lock.waiting.shift();
  if (next) next();
  else w.lock.held = false;
}

/** Serialises all work on one world so requests never interleave. */
export async function withLock<T>(w: World, fn: () => Promise<T> | T): Promise<T> {
  await takeTurn(w);
  try {
    return await fn();
  } finally {
    endTurn(w);
  }
}

/**
 * For the request whose turn it is, while it waits on something outside the sandbox: lets the others
 * go ahead, then rejoins the line. The caller must have left the world exactly as it found it, with no
 * transaction open, and must not touch the world inside fn.
 */
export async function stepAside<T>(w: World, fn: () => Promise<T>): Promise<T> {
  endTurn(w);
  try {
    return await fn();
  } finally {
    await takeTurn(w);
  }
}

/** Records what an institution did, for the activity log. */
export function audit(w: World, system: string, action: string, summary: string) {
  w.db.prepare("INSERT INTO audit(at, system, action, summary) VALUES(?,?,?,?)").run(w.now, system, action, summary);
}

const remembered = new WeakMap<World, { at: number; values: Map<string, unknown> }>();

/**
 * Keeps the answer to a question that depends only on what is stored, until something stored changes.
 * Many screens ask the same totals every few seconds; a world nobody is changing answers them once.
 * Nothing is kept from inside a transaction, which may yet be undone.
 */
export function remember<T>(w: World, key: string, fn: () => T): T {
  if (w.db.isTransaction) return fn();
  const at = Number((w.db.prepare("SELECT total_changes() AS n").get() as { n: number }).n);
  let kept = remembered.get(w);
  if (!kept || kept.at !== at) remembered.set(w, (kept = { at, values: new Map() }));
  if (kept.values.has(key)) return kept.values.get(key) as T;
  const value = fn();
  kept.values.set(key, value);
  return value;
}

import { randomUUID } from "node:crypto";
import { SimError } from "./util";
import type { Reply } from "./outside";

/**
 * The bridge: a way for the sandbox to reach an API running on a team's own laptop.
 *
 * A laptop has no address the internet can call. So instead of the sandbox calling the laptop, a small
 * program on the laptop (examples/bridge.py, examples/bridge.mjs) calls the sandbox and waits. Whatever
 * the sandbox has for that team's API it hands over on that open call; the program passes it to the API
 * on the laptop and sends the answer back. The team's API is an ordinary API throughout.
 *
 * To the rest of the sandbox a bridge is simply another kind of address: bridge://laptop, typed wherever
 * an http:// address could be. A bridge belongs to one team's world and is opened with that team's key.
 * Nothing here is stored: a bridge exists for as long as its program keeps calling in.
 */

export interface Outgoing {
  id: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string;
}

type Handed = { requests: Outgoing[] } | { replaced: true };

interface Bridge {
  world: string;
  name: string;
  /** Which run of the bridge program holds this name now. A newer one takes over. */
  session: string;
  /** Where the program says it passes requests on to, for showing on the console. */
  to: string;
  since: number;
  lastSeen: number;
  /** Requests waiting for the program's next call. */
  queue: Outgoing[];
  /** The program's call, held open, if it is waiting right now. */
  hand?: (out: Handed) => void;
  /** Requests handed over and not yet answered. */
  waiting: Map<string, { resolve: (r: Reply) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>;
  handled: number;
}

const bridges: Map<string, Bridge> = ((globalThis as unknown as { __bridges?: Map<string, Bridge> }).__bridges ??= new Map());

/** How long a call from the program is held open with nothing to hand over, before it is told to call again. */
const HOLD_MS = 25_000;
/** A program that has not called for this long is taken to have gone. */
const GONE_MS = 10_000;
const FORGET_MS = 60 * 60 * 1000;
const MAX_PER_WORLD = 10;
const MAX_QUEUED = 200;
const MAX_REPLY = 256 * 1024;
const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

const keyOf = (world: string, name: string) => `${world}:${name}`;
const connected = (b: Bridge) => !!b.hand || Date.now() - b.lastSeen < GONE_MS;

/** Reads a bridge address: bridge://name or bridge://name/some/path. */
export function bridgeAddress(url: string): { name: string; path: string } | undefined {
  const m = url.trim().match(/^bridge:\/\/([^/?#]+)(\/[^#]*)?$/i);
  if (!m) return undefined;
  const name = m[1].toLowerCase();
  if (!NAME.test(name)) throw new SimError("A bridge's name is up to 40 lower-case letters, digits and hyphens, for example bridge://laptop");
  return { name, path: m[2] ?? "/" };
}

function nameOf(input: unknown): string {
  const name = String(input ?? "laptop").trim().toLowerCase();
  if (!NAME.test(name)) throw new SimError("Choose a name of up to 40 lower-case letters, digits and hyphens");
  return name;
}

/**
 * The bridge program calling in: "anything for me?" Answered at once if something is waiting, otherwise
 * held open until something arrives or it is time to call again.
 */
export function pollBridge(world: string, input: { name?: unknown; session?: unknown; to?: unknown }, gone?: AbortSignal): Promise<Handed> {
  const name = nameOf(input.name);
  const session = String(input.session ?? "");
  if (!session) throw new SimError("session is required");
  const now = Date.now();
  for (const [k, old] of bridges) if (!old.hand && now - old.lastSeen > FORGET_MS) bridges.delete(k);
  let b = bridges.get(keyOf(world, name));
  if (!b) {
    if ([...bridges.values()].filter((x) => x.world === world).length >= MAX_PER_WORLD) throw new SimError(`A team can have ${MAX_PER_WORLD} bridges at most. Use a name already in use, or wait for an unused one to be forgotten.`);
    b = { world, name, session, to: "", since: now, lastSeen: now, queue: [], waiting: new Map(), handled: 0 };
    bridges.set(keyOf(world, name), b);
  }
  if (b.session !== session) {
    // Another laptop (or a restart) has taken this name: the one that had it is told to stop.
    b.hand?.({ replaced: true });
    b.session = session;
    b.since = now;
  }
  const bridge = b;
  bridge.to = String(input.to ?? "").slice(0, 200);
  bridge.lastSeen = now;
  if (bridge.queue.length) return Promise.resolve({ requests: bridge.queue.splice(0) });
  return new Promise((resolve) => {
    const done = (out: Handed) => {
      clearTimeout(timer);
      gone?.removeEventListener("abort", left);
      if (bridge.hand === done) bridge.hand = undefined;
      bridge.lastSeen = Date.now();
      resolve(out);
    };
    // The program hung up while waiting (it was closed, or the laptop went offline): the bridge is gone until it calls again.
    const left = () => {
      done({ requests: [] });
      bridge.lastSeen = 0;
    };
    const timer = setTimeout(() => done({ requests: [] }), HOLD_MS);
    gone?.addEventListener("abort", left);
    // An earlier call from the same program that is still open is let go.
    bridge.hand?.({ requests: [] });
    bridge.hand = done;
  });
}

/** The bridge program sending back what the API on the laptop answered, or why it could not be asked. */
export function replyBridge(world: string, input: { name?: unknown; session?: unknown; id?: unknown; status?: unknown; body?: unknown; error?: unknown }): { ok: boolean; reason?: string } {
  const name = nameOf(input.name);
  const b = bridges.get(keyOf(world, name));
  if (!b || b.session !== String(input.session ?? "")) return { ok: false, reason: "This bridge has been replaced by another." };
  b.lastSeen = Date.now();
  const asked = b.waiting.get(String(input.id ?? ""));
  if (!asked) return { ok: false, reason: "Too late: the sandbox had stopped waiting for this answer." };
  clearTimeout(asked.timer);
  b.waiting.delete(String(input.id));
  b.handled++;
  if (input.error) asked.reject(new Error(`${String(input.error).slice(0, 200)} (through the bridge "${name}")`));
  else {
    const status = Number(input.status) || 0;
    asked.resolve({ status, ok: status >= 200 && status < 300, body: String(input.body ?? "").slice(0, MAX_REPLY) });
  }
  return { ok: true };
}

/** Sends one request to a team's laptop through its bridge and waits for the answer. */
export function sendThroughBridge(world: string, name: string, path: string, req: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs: number }): Promise<Reply> {
  const b = bridges.get(keyOf(world, name));
  if (!b || !connected(b)) return Promise.reject(new Error(`The bridge "${name}" is not connected: start the bridge program on your laptop`));
  if (b.queue.length + b.waiting.size >= MAX_QUEUED) return Promise.reject(new Error(`The bridge "${name}" has too much waiting to be answered`));
  const out: Outgoing = { id: randomUUID(), method: req.method ?? "POST", path, headers: req.headers ?? {}, body: req.body };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      b.waiting.delete(out.id);
      const at = b.queue.indexOf(out);
      if (at >= 0) b.queue.splice(at, 1);
      reject(new Error(`No answer within ${req.timeoutMs} ms`));
    }, req.timeoutMs);
    b.waiting.set(out.id, { resolve, reject, timer });
    if (b.hand) b.hand({ requests: [out] });
    else b.queue.push(out);
  });
}

/** A team's bridges, for showing which laptops are connected. */
export function listBridges(world: string) {
  return [...bridges.values()]
    .filter((b) => b.world === world)
    .map((b) => ({ name: b.name, address: `bridge://${b.name}`, connected: connected(b), passesTo: b.to, since: new Date(b.since).toISOString(), lastSeen: new Date(b.lastSeen).toISOString(), answered: b.handled }));
}

export const bridgeConnected = (world: string, name: string) => {
  const b = bridges.get(keyOf(world, name));
  return !!b && connected(b);
};

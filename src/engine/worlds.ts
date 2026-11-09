import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { BASE_WORLD, DATA_DIR, SNAPSHOTS_DIR, WORLDS_DIR, getMeta, openDb, setMeta } from "./db";
import { generateWorld } from "./population";
import { runUntil } from "./sim";
import { makeWorld, withLock, type World } from "./world";

export interface Team {
  id: string;
  name: string;
  key: string;
}

interface Registry {
  organiserKey: string;
  teams: Team[];
}

const REGISTRY = path.join(DATA_DIR, "teams.json");
export const ORGANISER_WORLD = "organiser";

interface State {
  worlds: Map<string, World>;
  ticker?: NodeJS.Timeout;
  busy: Set<string>;
}
const g = globalThis as unknown as { __sandbox?: State };
const state: State = (g.__sandbox ??= { worlds: new Map(), busy: new Set() });

export function registry(): Registry {
  if (!fs.existsSync(REGISTRY)) {
    const teamCount = Number(process.env.SANDBOX_TEAMS || 10);
    const reg: Registry = {
      organiserKey: process.env.ORGANISER_KEY || randomBytes(9).toString("base64url"),
      teams: Array.from({ length: teamCount }, (_, i) => ({
        id: `team-${String(i + 1).padStart(2, "0")}`,
        name: `Team ${i + 1}`,
        key: randomBytes(9).toString("base64url"),
      })),
    };
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(REGISTRY, JSON.stringify(reg, null, 2));
  }
  const reg: Registry = JSON.parse(fs.readFileSync(REGISTRY, "utf8"));
  // ORGANISER_KEY, when set, always wins over the key stored at first start.
  return { ...reg, organiserKey: process.env.ORGANISER_KEY || reg.organiserKey };
}

export const worldIds = () => [...registry().teams.map((t) => t.id), ORGANISER_WORLD];
export const teamById = (id: string) => registry().teams.find((t) => t.id === id);

export function ensureBaseWorld() {
  if (fs.existsSync(BASE_WORLD)) return;
  const tmp = BASE_WORLD + ".tmp";
  fs.rmSync(tmp, { force: true });
  const db = openDb(tmp);
  generateWorld(db, Number(process.env.SANDBOX_SEED || 2026));
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  for (const ext of ["-wal", "-shm"]) fs.rmSync(tmp + ext, { force: true });
  fs.renameSync(tmp, BASE_WORLD);
}

const worldFile = (id: string) => {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error("bad world id");
  return path.join(WORLDS_DIR, `${id}.db`);
};

export function getWorld(id: string): World {
  const open = state.worlds.get(id);
  if (open) return open;
  if (!worldIds().includes(id)) throw new Error(`unknown world ${id}`);
  const file = worldFile(id);
  if (!fs.existsSync(file)) {
    ensureBaseWorld();
    fs.mkdirSync(WORLDS_DIR, { recursive: true });
    fs.copyFileSync(BASE_WORLD, file);
  }
  const w = makeWorld(id, openDb(file));
  state.worlds.set(id, w);
  return w;
}

function closeWorld(id: string) {
  const w = state.worlds.get(id);
  if (!w) return;
  w.db.close();
  state.worlds.delete(id);
}

function replaceWorldFile(id: string, source: string) {
  closeWorld(id);
  const file = worldFile(id);
  for (const ext of ["", "-wal", "-shm"]) fs.rmSync(file + ext, { force: true });
  fs.copyFileSync(source, file);
}

export async function resetWorld(id: string) {
  await withLock(getWorld(id), () => {
    ensureBaseWorld();
    replaceWorldFile(id, BASE_WORLD);
  });
  return getWorld(id);
}

export interface Snapshot {
  id: string;
  label: string;
  simTime: number;
  createdAt: number;
}

const snapDir = (id: string) => path.join(SNAPSHOTS_DIR, id);
const snapIndex = (id: string) => path.join(snapDir(id), "index.json");

export function listSnapshots(id: string): Snapshot[] {
  try {
    return JSON.parse(fs.readFileSync(snapIndex(id), "utf8"));
  } catch {
    return [];
  }
}

export async function snapshotWorld(id: string, label: string): Promise<Snapshot> {
  const w = getWorld(id);
  return withLock(w, () => {
    fs.mkdirSync(snapDir(id), { recursive: true });
    const snap: Snapshot = { id: `s${Date.now()}`, label: label.slice(0, 80) || "Snapshot", simTime: w.now, createdAt: Date.now() };
    w.db.exec(`VACUUM INTO '${path.join(snapDir(id), `${snap.id}.db`).replace(/'/g, "''")}'`);
    const all = [snap, ...listSnapshots(id)].slice(0, 20);
    fs.writeFileSync(snapIndex(id), JSON.stringify(all, null, 2));
    return snap;
  });
}

export async function restoreSnapshot(id: string, snapId: string) {
  const snap = listSnapshots(id).find((s) => s.id === snapId);
  if (!snap) throw new Error("snapshot not found");
  await withLock(getWorld(id), () => replaceWorldFile(id, path.join(snapDir(id), `${snap.id}.db`)));
  return getWorld(id);
}

export function setRunning(w: World, running: boolean) {
  setMeta(w.db, "running", running ? 1 : 0);
}
export function setSpeed(w: World, speed: number) {
  setMeta(w.db, "speed", Math.max(1, Math.min(3600, Math.round(speed))));
}
export const isRunning = (w: World) => getMeta(w.db, "running") === "1";
export const speedOf = (w: World) => Number(getMeta(w.db, "speed") ?? 60);

/** Advances every running world in real time: `speed` simulated seconds per real second. */
export function startTicker() {
  if (state.ticker) return;
  const TICK_MS = 1000;
  state.ticker = setInterval(() => {
    for (const id of worldIds()) {
      if (state.busy.has(id)) continue;
      let w: World;
      try {
        w = getWorld(id);
      } catch {
        continue;
      }
      if (!isRunning(w)) continue;
      state.busy.add(id);
      const target = w.now + speedOf(w) * TICK_MS;
      withLock(w, () => runUntil(w, target))
        .catch((e) => console.error(`[sandbox] tick failed for ${id}:`, e))
        .finally(() => state.busy.delete(id));
    }
  }, TICK_MS);
  state.ticker.unref?.();
}

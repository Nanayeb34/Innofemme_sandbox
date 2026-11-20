import fs from "node:fs";
import path from "node:path";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { DATA_DIR, SCHEMA_VERSION, SNAPSHOTS_DIR, WORLDS_DIR, count, getMeta, openDb, setMeta, tx } from "./db";
import { EARLIER_MENUS, defaultTelco, notifications } from "./config/defaults";
import { seedConfig } from "./config/store";
import { seedTrustAccounts } from "./bank";
import { SIM_DEFAULTS, simulate, type SimSummary } from "./simulate";
import { TELCOS } from "./util";
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
}
const g = globalThis as unknown as { __sandbox?: State };
const state: State = (g.__sandbox ??= { worlds: new Map() });

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

/**
 * Who a link lets you be. "team" opens every system. "customer" opens only the phone, and "agent"
 * only the agent screens: these are for the QR codes people scan with their own phones.
 */
export type Role = "team" | "customer" | "agent";
export const PHONE_ROLES = ["customer", "agent"] as const;

/** The key for one role. Phone keys are derived from the team key, so they need no storage and cannot be turned back into it. */
export function roleKey(team: Team, role: Role): string {
  return role === "team" ? team.key : createHmac("sha256", team.key).update(`phone:${role}`).digest("base64url").slice(0, 12);
}

export function roleOfKey(team: Team, key: string | undefined | null): Role | undefined {
  if (!key) return undefined;
  const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
  return (["team", ...PHONE_ROLES] as Role[]).find((r) => same(key, roleKey(team, r)));
}

/** Where each role starts. */
export const roleHome = (teamId: string, role: Role) => (role === "customer" ? `/t/${teamId}/phone` : role === "agent" ? `/t/${teamId}/agent` : `/t/${teamId}`);

export const worldIds = () => [...registry().teams.map((t) => t.id), ORGANISER_WORLD];
export const teamById = (id: string) => registry().teams.find((t) => t.id === id);

const worldFile = (id: string) => {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error("bad world id");
  return path.join(WORLDS_DIR, `${id}.db`);
};

function removeFile(file: string) {
  for (const ext of ["", "-wal", "-shm"]) fs.rmSync(file + ext, { force: true });
}

/**
 * Opens a world file. A new world is an empty country: the institutions exist, with their starting
 * settings and the telcos' trust accounts, but there are no people, SIMs, wallets or money yet.
 */
function open(id: string): World {
  const file = worldFile(id);
  let db = openDb(file);
  const version = getMeta(db, "schema");
  if (version !== undefined && Number(version) !== SCHEMA_VERSION) {
    // Built by an older version of the sandbox: start again from an empty world.
    db.close();
    removeFile(file);
    db = openDb(file);
  }
  // A world from before the message log existed: copy its inboxes in, so conversations keep their history.
  db.exec(`INSERT INTO sms_log(at, kind, sender, from_telco, to_msisdn, to_telco, body, parts, status)
    SELECT s.at, 'network', s.sender, x.telco, s.msisdn, x.telco, s.body, 1, 'delivered' FROM sms s LEFT JOIN sims x ON x.msisdn = s.msisdn
    WHERE NOT EXISTS (SELECT 1 FROM sms_log) ORDER BY s.id`);
  const w = makeWorld(id, db);
  if (getMeta(db, "schema") === undefined) {
    tx(db, () => {
      seedConfig(db);
      seedTrustAccounts(w);
      setMeta(db, "schema", SCHEMA_VERSION);
      setMeta(db, "created_at", Date.now());
      setMeta(db, "menus", MENUS_VERSION);
    });
  }
  upgradeMenus(db);
  return w;
}

const MENUS_VERSION = 2;
/** The same value whatever order its keys were written in. */
const canon = (v: unknown): string => JSON.stringify(v, (_, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as object).sort(([a], [b]) => a.localeCompare(b))) : x));

/**
 * A world made before each network had its own menu still holds the one menu all three shared. Each
 * network that has not changed its menu since gets its own now, with the settings that go with it.
 * A menu a team has edited is left alone.
 */
export function upgradeMenus(db: World["db"]) {
  if (Number(getMeta(db, "menus") ?? 1) >= MENUS_VERSION) return;
  tx(db, () => {
    for (const t of TELCOS) {
      const row = db.prepare("SELECT value FROM config WHERE surface = ?").get(`telco.${t}`) as { value: string } | undefined;
      if (!row) continue;
      const cfg = JSON.parse(row.value) as ReturnType<typeof defaultTelco>;
      const fresh = defaultTelco(t);
      const untouched = canon(cfg.menu) === canon(EARLIER_MENUS[t]);
      if (untouched) {
        cfg.menu = fresh.menu;
        cfg.cashOut = fresh.cashOut;
        cfg.registration = fresh.registration;
        cfg.selfRegistration = fresh.selfRegistration;
        // The two texts that tell a customer where to answer a request name a place on the menu.
        for (const event of ["approval_prompt", "dispute_consent"] as const) {
          if (cfg.notifications[event]?.template.includes("option 4")) cfg.notifications[event] = notifications(t)[event];
        }
      }
      cfg.bundles ??= fresh.bundles;
      cfg.billers ??= fresh.billers;
      cfg.atm ??= fresh.atm;
      db.prepare("UPDATE config SET value = ?, version = version + 1 WHERE surface = ?").run(JSON.stringify(cfg), `telco.${t}`);
      if (untouched) db.prepare("INSERT INTO audit(at, system, action, summary) VALUES(?,?,?,?)").run(Date.now(), t, "settings", `The phone menu was replaced with ${fresh.menu.nodes.main.type === "menu" ? fresh.menu.nodes.main.text : t}'s own`);
    }
    setMeta(db, "menus", MENUS_VERSION);
  });
}

export function getWorld(id: string): World {
  const existing = state.worlds.get(id);
  if (existing) return existing;
  if (!worldIds().includes(id)) throw new Error(`unknown world ${id}`);
  const w = open(id);
  state.worlds.set(id, w);
  return w;
}

function closeWorld(id: string) {
  const w = state.worlds.get(id);
  if (!w) return;
  w.db.close();
  state.worlds.delete(id);
}

/** Wipes a world back to an empty country. */
export async function resetWorld(id: string) {
  await withLock(getWorld(id), () => {
    closeWorld(id);
    removeFile(worldFile(id));
  });
  return getWorld(id);
}

export interface Snapshot {
  id: string;
  label: string;
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
    const snap: Snapshot = { id: `s${Date.now()}`, label: label.slice(0, 80) || "Snapshot", createdAt: Date.now() };
    w.db.exec(`VACUUM INTO '${path.join(snapDir(id), `${snap.id}.db`).replace(/'/g, "''")}'`);
    const all = [snap, ...listSnapshots(id)];
    // A world holding a simulated history is large, so fewer copies of it are kept.
    const keep = fs.statSync(path.join(snapDir(id), `${snap.id}.db`)).size > 30_000_000 ? 4 : 20;
    for (const old of all.slice(keep)) fs.rmSync(path.join(snapDir(id), `${old.id}.db`), { force: true });
    fs.writeFileSync(snapIndex(id), JSON.stringify(all.slice(0, keep), null, 2));
    return snap;
  });
}

export async function restoreSnapshot(id: string, snapId: string) {
  const snap = listSnapshots(id).find((s) => s.id === snapId);
  if (!snap) throw new Error("snapshot not found");
  await withLock(getWorld(id), () => {
    closeWorld(id);
    removeFile(worldFile(id));
    fs.copyFileSync(path.join(snapDir(id), `${snap.id}.db`), worldFile(id));
  });
  return getWorld(id);
}

// ---------- simulated data ----------

const SIM_DIR = path.join(DATA_DIR, "simulated");
/** Bump when the simulation changes what it produces, so stale copies are rebuilt. */
const SIM_VERSION = 2;

/**
 * Builds the simulated country once per day and seed, into a file that team worlds are copied from.
 * The history always ends at the start of the day it was built, so it stays recent.
 */
export function buildSimulated(seed: number = SIM_DEFAULTS.seed): string {
  const file = path.join(SIM_DIR, `v${SIM_VERSION}-${seed}-${new Date().toISOString().slice(0, 10)}.db`);
  if (fs.existsSync(file)) return file;
  fs.mkdirSync(SIM_DIR, { recursive: true });
  for (const old of fs.readdirSync(SIM_DIR)) fs.rmSync(path.join(SIM_DIR, old), { force: true });
  const building = `${file}.building`;
  const db = openDb(building);
  try {
    const w = makeWorld("simulated", db);
    tx(db, () => {
      seedConfig(db);
      seedTrustAccounts(w);
      setMeta(db, "schema", SCHEMA_VERSION);
      setMeta(db, "created_at", Date.now());
      setMeta(db, "menus", MENUS_VERSION);
    });
    simulate(w, { seed });
    db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  } finally {
    db.close();
    removeFile(building);
  }
  return file;
}

const CARRIED = ["integrations", "fraud_apps", "api_clients", "ussd_codes", "ussd_activations", "config", "config_history"];

/** Replaces a world with the simulated country. What was there before is kept as a save point. */
export async function loadSimulated(id: string, seed?: number) {
  const file = buildSimulated(seed);
  if (count(getWorld(id).db, "SELECT COUNT(*) AS n FROM persons")) await snapshotWorld(id, "Before loading simulated data");
  // What the team has set up for itself comes along: plugged-in APIs, connected applications, API partners, short codes and settings.
  const kept: Record<string, Record<string, unknown>[]> = {};
  await withLock(getWorld(id), () => {
    const old = getWorld(id).db;
    for (const table of CARRIED) kept[table] = old.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
    closeWorld(id);
    removeFile(worldFile(id));
    fs.copyFileSync(file, worldFile(id));
  });
  const w = getWorld(id);
  tx(w.db, () => {
    for (const table of CARRIED) {
      for (const row of kept[table]) {
        // A partner's link to a merchant wallet or bank account pointed into the old world.
        if (table === "api_clients") Object.assign(row, { wallet_id: null, account_id: null });
        const cols = Object.keys(row);
        w.db.prepare(`INSERT OR REPLACE INTO ${table}(${cols.join(", ")}) VALUES(${cols.map(() => "?").join(", ")})`).run(...(cols.map((c) => row[c]) as (string | number | null)[]));
      }
    }
  });
  return w;
}

/** What the simulated history in a world contains, if one was loaded. */
export function simulatedSummary(w: World): SimSummary | undefined {
  const raw = getMeta(w.db, "simulated");
  return raw ? (JSON.parse(raw) as SimSummary) : undefined;
}

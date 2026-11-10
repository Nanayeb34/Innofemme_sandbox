import type { DB } from "../db";
import { tx, getMeta } from "../db";
import { DEFAULTS } from "./defaults";
import { SURFACES, type Surface, type SurfaceTypes } from "./schemas";

const cache = new WeakMap<DB, Map<Surface, { version: number; value: unknown }>>();

export function seedConfig(db: DB) {
  const ins = db.prepare("INSERT OR IGNORE INTO config(surface, value, version) VALUES(?, ?, 1)");
  for (const s of Object.keys(DEFAULTS) as Surface[]) ins.run(s, JSON.stringify(DEFAULTS[s]));
}

/** Brings configuration saved by older versions up to the current schemas. */
export function migrateConfig(db: DB) {
  const row = db.prepare("SELECT value FROM config WHERE surface = 'rules'").get() as { value: string } | undefined;
  if (!row) return;
  const rules = JSON.parse(row.value);
  if (rules?.fees?.mtn?.p2p_onnet?.bands) return;
  // Fees moved from a single percentage to amount bands when the telco tariffs were confirmed.
  setConfig(db, "rules", { ...rules, fees: DEFAULTS.rules.fees }, "Applied the confirmed MTN, Telecel and AT fee schedules", "organiser");
}

export function getConfig<S extends Surface>(db: DB, surface: S): SurfaceTypes[S] {
  let m = cache.get(db);
  if (!m) cache.set(db, (m = new Map()));
  const row = db.prepare("SELECT value, version FROM config WHERE surface = ?").get(surface) as { value: string; version: number } | undefined;
  if (!row) return DEFAULTS[surface];
  const hit = m.get(surface);
  if (hit && hit.version === row.version) return hit.value as SurfaceTypes[S];
  const value = JSON.parse(row.value) as SurfaceTypes[S];
  m.set(surface, { version: row.version, value });
  return value;
}

export type ValidationResult = { ok: true; value: unknown } | { ok: false; errors: string[] };

export function validateSurface(surface: Surface, value: unknown): ValidationResult {
  const parsed = SURFACES[surface].schema.safeParse(value);
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    errors: parsed.error.issues.slice(0, 15).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
  };
}

export function setConfig(db: DB, surface: Surface, value: unknown, summary: string, author: string): number {
  const v = validateSurface(surface, value);
  if (!v.ok) throw new ConfigError(v.errors);
  return tx(db, () => {
    const before = db.prepare("SELECT value FROM config WHERE surface = ?").get(surface) as { value: string };
    const after = JSON.stringify(v.value);
    db.prepare("UPDATE config SET value = ?, version = version + 1 WHERE surface = ?").run(after, surface);
    const r = db
      .prepare("INSERT INTO config_history(surface, before, after, summary, author, at_real, at_sim) VALUES(?,?,?,?,?,?,?)")
      .run(surface, before.value, after, summary, author, Date.now(), Number(getMeta(db, "sim_now")));
    return Number(r.lastInsertRowid);
  });
}

export function undoChange(db: DB, historyId: number, author: string): number {
  const row = db.prepare("SELECT * FROM config_history WHERE id = ?").get(historyId) as
    | { surface: Surface; before: string; summary: string; undone_by: number | null }
    | undefined;
  if (!row) throw new ConfigError([`change ${historyId} not found`]);
  if (row.undone_by) throw new ConfigError([`change ${historyId} was already undone`]);
  const newId = setConfig(db, row.surface, JSON.parse(row.before), `Undo: ${row.summary}`, author);
  db.prepare("UPDATE config_history SET undone_by = ? WHERE id = ?").run(newId, historyId);
  return newId;
}

export class ConfigError extends Error {
  constructor(public errors: string[]) {
    super(errors.join("; "));
  }
}

// ---------- JSON Patch (RFC 6902 subset: add, replace, remove) ----------

export type PatchOp = { op: "add" | "replace" | "remove"; path: string; value?: unknown };

export function applyPatch(doc: unknown, ops: PatchOp[]): unknown {
  const root = structuredClone(doc) as Record<string, unknown>;
  for (const op of ops) {
    const parts = op.path
      .split("/")
      .slice(1)
      .map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
    if (parts.length === 0) throw new ConfigError([`invalid path "${op.path}"`]);
    let parent: unknown = root;
    for (const p of parts.slice(0, -1)) {
      parent = (parent as Record<string, unknown>)?.[p];
      if (parent === undefined || parent === null) throw new ConfigError([`path "${op.path}" does not exist`]);
    }
    const last = parts[parts.length - 1];
    if (Array.isArray(parent)) {
      const idx = last === "-" ? parent.length : Number(last);
      if (!Number.isInteger(idx) || idx < 0 || idx > parent.length) throw new ConfigError([`bad array index in "${op.path}"`]);
      if (op.op === "add") parent.splice(idx, 0, op.value);
      else if (op.op === "replace") parent[idx] = op.value;
      else parent.splice(idx, 1);
    } else {
      const obj = parent as Record<string, unknown>;
      if (op.op !== "add" && !(last in obj)) throw new ConfigError([`path "${op.path}" does not exist`]);
      if (op.op === "remove") delete obj[last];
      else obj[last] = op.value;
    }
  }
  return root;
}

/** Compact line diff of two JSON values, for previews. */
export function diffJson(before: unknown, after: unknown, path = ""): string[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  const isObj = (v: unknown) => v !== null && typeof v === "object";
  if (isObj(before) && isObj(after) && Array.isArray(before) === Array.isArray(after)) {
    const keys = new Set([...Object.keys(before as object), ...Object.keys(after as object)]);
    const out: string[] = [];
    for (const k of keys) {
      const b = (before as Record<string, unknown>)[k];
      const a = (after as Record<string, unknown>)[k];
      const p = `${path}/${k}`;
      if (b === undefined) out.push(`+ ${p}: ${JSON.stringify(a)}`);
      else if (a === undefined) out.push(`- ${p}: ${JSON.stringify(b)}`);
      else out.push(...diffJson(b, a, p));
    }
    return out;
  }
  return [`~ ${path}: ${JSON.stringify(before)} → ${JSON.stringify(after)}`];
}

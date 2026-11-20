import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { DATA_DIR } from "@/engine/db";
import type { Conversation } from "./llm";

/**
 * Where the assistant's conversations are kept. Not in a team's world: a world can be wiped, rolled back or
 * replaced with the simulated country, sometimes at the assistant's own hand, and the conversation that
 * asked for it has to survive that. One small database for every team, beside the worlds.
 */

/** Something the assistant wants to do that the user has to agree to first. */
export interface Pending {
  id: string;
  agent: string;
  tool: string;
  input: Record<string, unknown>;
  /** What the user is shown. */
  summary: string;
}

export interface Chat {
  id: string;
  team: string;
  title: string;
  conversation: Conversation | null;
  pending: Pending[];
  createdAt: number;
  updatedAt: number;
}

/** One thing shown in the conversation. See run.ts for the kinds. */
export type ChatEvent = { type: string } & Record<string, unknown>;

const g = globalThis as unknown as { __assistantDb?: DatabaseSync };

function db(): DatabaseSync {
  if (!g.__assistantDb) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const d = new DatabaseSync(path.join(DATA_DIR, "assistant.db"));
    d.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, team TEXT NOT NULL, title TEXT NOT NULL, conversation TEXT, pending TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS chats_team ON chats(team, updated_at);
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_chat ON events(chat_id, id);
      CREATE TABLE IF NOT EXISTS usage (team TEXT NOT NULL, day TEXT NOT NULL, calls INTEGER NOT NULL DEFAULT 0, tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (team, day));`);
    g.__assistantDb = d;
  }
  return g.__assistantDb;
}

type Row = { id: string; team: string; title: string; conversation: string | null; pending: string; created_at: number; updated_at: number };
const toChat = (r: Row): Chat => ({ id: r.id, team: r.team, title: r.title, conversation: r.conversation ? (JSON.parse(r.conversation) as Conversation) : null, pending: JSON.parse(r.pending) as Pending[], createdAt: r.created_at, updatedAt: r.updated_at });

export function newChat(team: string, title: string): Chat {
  const now = Date.now();
  const id = `chat_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  db().prepare("INSERT INTO chats(id, team, title, created_at, updated_at) VALUES(?,?,?,?,?)").run(id, team, title.slice(0, 80), now, now);
  return { id, team, title, conversation: null, pending: [], createdAt: now, updatedAt: now };
}

/** A team's own conversation, or nothing: one team can never open another's. */
export function getChat(team: string, id: string): Chat | undefined {
  const r = db().prepare("SELECT * FROM chats WHERE id = ? AND team = ?").get(id, team) as Row | undefined;
  return r ? toChat(r) : undefined;
}

export function listChats(team: string) {
  return (db().prepare("SELECT id, title, updated_at FROM chats WHERE team = ? ORDER BY updated_at DESC LIMIT 30").all(team) as { id: string; title: string; updated_at: number }[]).map((r) => ({ id: r.id, title: r.title, updatedAt: new Date(r.updated_at).toISOString() }));
}

export function saveChat(c: Chat) {
  db().prepare("UPDATE chats SET conversation = ?, pending = ?, updated_at = ? WHERE id = ?").run(c.conversation ? JSON.stringify(c.conversation) : null, JSON.stringify(c.pending), Date.now(), c.id);
}

export function deleteChat(team: string, id: string) {
  if (!getChat(team, id)) return;
  db().prepare("DELETE FROM events WHERE chat_id = ?").run(id);
  db().prepare("DELETE FROM chats WHERE id = ?").run(id);
}

export function addEvent(chatId: string, e: ChatEvent) {
  db().prepare("INSERT INTO events(chat_id, at, data) VALUES(?,?,?)").run(chatId, Date.now(), JSON.stringify(e));
}

export function chatEvents(chatId: string): ChatEvent[] {
  return (db().prepare("SELECT data FROM events WHERE chat_id = ? ORDER BY id").all(chatId) as { data: string }[]).map((r) => JSON.parse(r.data) as ChatEvent);
}

const today = () => new Date().toISOString().slice(0, 10);

/** How many times the team has called the model today. */
export function usageToday(team: string) {
  const r = db().prepare("SELECT calls, tokens_in, tokens_out FROM usage WHERE team = ? AND day = ?").get(team, today()) as { calls: number; tokens_in: number; tokens_out: number } | undefined;
  return { calls: r?.calls ?? 0, tokensIn: r?.tokens_in ?? 0, tokensOut: r?.tokens_out ?? 0 };
}

export function countUsage(team: string, tokens: { in: number; out: number }) {
  db()
    .prepare("INSERT INTO usage(team, day, calls, tokens_in, tokens_out) VALUES(?,?,1,?,?) ON CONFLICT(team, day) DO UPDATE SET calls = calls + 1, tokens_in = tokens_in + excluded.tokens_in, tokens_out = tokens_out + excluded.tokens_out")
    .run(team, today(), tokens.in, tokens.out);
}

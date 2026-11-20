import { randomBytes } from "node:crypto";
import { authenticate, getClient, recordCall, type ApiClient } from "@/engine/partners";
import { teamById } from "@/engine/worlds";
import { getWorld } from "@/engine/worlds";
import type { World } from "@/engine/world";
import { callOut } from "@/engine/outside";
import { HttpError } from "./http";

/**
 * Authentication for the partner APIs. A partner proves who it is with the client id and key its
 * institution issued: either on every request (HTTP Basic), or once at the token endpoint to get a
 * short-lived bearer token. The team key is not needed: a partner is an outside company.
 */

interface Token {
  team: string;
  institution: string;
  client: string;
  exp: number;
}
const tokens = ((globalThis as unknown as { __partnerTokens?: Map<string, Token> }).__partnerTokens ??= new Map());
const TOKEN_SECONDS = 3600;

function basic(req: Request): [string, string] | undefined {
  const b = req.headers.get("authorization")?.match(/^Basic\s+(.+)$/i)?.[1];
  if (!b) return undefined;
  const text = Buffer.from(b, "base64").toString();
  const i = text.indexOf(":");
  return i < 0 ? undefined : [text.slice(0, i), text.slice(i + 1)];
}

export function partnerWorld(team: string): World {
  if (!teamById(team)) throw new HttpError(404, "Unknown team");
  return getWorld(team);
}

/** Exchanges a client id and key for a bearer token. */
export function issueToken(req: Request, team: string, institution: string) {
  const w = partnerWorld(team);
  const creds = basic(req);
  const client = authenticate(w, institution, creds?.[0], creds?.[1]);
  if (!client) throw new HttpError(401, "Use HTTP Basic authentication with the client id and API key this institution issued");
  const token = randomBytes(24).toString("base64url");
  tokens.set(token, { team, institution, client: client.id, exp: Date.now() + TOKEN_SECONDS * 1000 });
  recordCall(w, client.id);
  return { access_token: token, token_type: "access_token", expires_in: TOKEN_SECONDS };
}

/** The partner making this request, or undefined when it carries no valid partner credentials. */
export function partnerOf(req: Request, team: string, institution: string): { w: World; client: ApiClient } | undefined {
  const w = partnerWorld(team);
  const bearer = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  const t = bearer ? tokens.get(bearer) : undefined;
  let client: ApiClient | undefined;
  if (t && t.team === team && t.institution === institution && t.exp > Date.now()) {
    const c = getClient(w, t.client);
    if (c?.status === "active") client = c;
  } else {
    const creds = basic(req);
    client = authenticate(w, institution, creds?.[0], creds?.[1]);
  }
  if (!client) return undefined;
  recordCall(w, client.id);
  return { w, client };
}

export function requirePartner(req: Request, team: string, institution: string) {
  const p = partnerOf(req, team, institution);
  if (!p) throw new HttpError(401, "API credentials required: the client id and API key this institution issued (HTTP Basic), or a bearer token from its token endpoint.");
  return p;
}

/** Tells a partner the outcome of something it started. Best effort, like the real thing. */
export async function notifyPartner(world: string, url: string | null | undefined, body: unknown, method: "PUT" | "POST" = "PUT") {
  if (!url) return;
  try {
    await callOut(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body), timeoutMs: 3000, world });
  } catch {
    // The partner's server was unreachable. It can still ask for the status.
  }
}

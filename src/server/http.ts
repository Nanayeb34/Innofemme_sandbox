import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { ConfigError } from "@/engine/config/store";
import { getWorld, registry, roleOfKey, teamById, ORGANISER_WORLD, type Role } from "@/engine/worlds";
import { SimError } from "@/engine/util";
import type { World } from "@/engine/world";

export const teamCookie = (team: string) => `momo_${team}`;
export const ORG_COOKIE = "momo_org";

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function presentedKey(req: Request): string | undefined {
  const h = req.headers;
  const bearer = h.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  return h.get("x-team-key") ?? h.get("ocp-apim-subscription-key") ?? bearer ?? undefined;
}

export async function isOrganiser(req?: Request): Promise<boolean> {
  const key = registry().organiserKey;
  const jar = await cookies();
  const c = jar.get(ORG_COOKIE)?.value;
  const h = req?.headers.get("x-organiser-key");
  return (!!c && same(c, key)) || (!!h && same(h, key));
}

/** The role a request holds for a team: from its key (header or cookie), or full access for an organiser. */
export async function requestRole(req: Request, team: string): Promise<Role | undefined> {
  const t = teamById(team);
  if (!t) return undefined;
  const jar = await cookies();
  const roles = [presentedKey(req), jar.get(teamCookie(team))?.value].map((k) => roleOfKey(t, k)).filter(Boolean) as Role[];
  if (roles.includes("team") || (await isOrganiser(req))) return "team";
  return roles[0];
}

/**
 * Resolves the team world a request may act on. Most of the API needs the team key (or organiser access);
 * the phone and agent endpoints also accept the narrower keys carried by the phone QR codes.
 */
export async function authWorld(req: Request, team: string, allowed: Role[] = ["team"]): Promise<World> {
  if (team === ORGANISER_WORLD) {
    if (!(await isOrganiser(req))) throw new HttpError(401, "Organiser access required");
    return getWorld(team);
  }
  if (!teamById(team)) throw new HttpError(404, "Unknown team");
  const role = await requestRole(req, team);
  if (!role) throw new HttpError(401, "Team key required. Scan your team QR code or send the x-team-key header.");
  if (!allowed.includes(role)) throw new HttpError(403, role === "customer" ? "This link only opens the customer phone." : "This link only opens the agent screens.");
  return getWorld(team);
}

export function handle<C>(fn: (req: Request, ctx: C) => Promise<unknown>) {
  return async (req: Request, ctx: C) => {
    try {
      const out = await fn(req, ctx);
      return out instanceof Response ? out : NextResponse.json(out);
    } catch (e) {
      if (e instanceof SimError) return NextResponse.json({ error: e.message }, { status: e.status });
      if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
      if (e instanceof ConfigError) return NextResponse.json({ error: "Invalid configuration", details: e.errors }, { status: 422 });
      console.error(e);
      return NextResponse.json({ error: (e as Error).message ?? "Internal error" }, { status: 500 });
    }
  };
}

export async function body<T = Record<string, unknown>>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new HttpError(400, "Body must be JSON");
  }
}

/** The address visitors use. Behind the HTTPS proxy, req.url is the container's internal address. */
export function publicOrigin(req: Request): string {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, "");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  const proto = req.headers.get("x-forwarded-proto") ?? new URL(req.url).protocol.replace(":", "");
  return host ? `${proto}://${host}` : new URL(req.url).origin;
}

import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { ConfigError } from "@/engine/config/store";
import { getWorld, registry, startTicker, teamById, ORGANISER_WORLD } from "@/engine/worlds";
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

/** Resolves the team world a request may act on: team key (header or cookie) or organiser access. */
export async function authWorld(req: Request, team: string): Promise<World> {
  startTicker();
  if (team === ORGANISER_WORLD) {
    if (!(await isOrganiser(req))) throw new HttpError(401, "Organiser access required");
    return getWorld(team);
  }
  const t = teamById(team);
  if (!t) throw new HttpError(404, "Unknown team");
  const jar = await cookies();
  const candidates = [presentedKey(req), jar.get(teamCookie(team))?.value].filter(Boolean) as string[];
  if (!candidates.some((k) => same(k, t.key)) && !(await isOrganiser(req))) throw new HttpError(401, "Team key required. Scan your team QR code or send the x-team-key header.");
  return getWorld(team);
}

export function handle<C>(fn: (req: Request, ctx: C) => Promise<unknown>) {
  return async (req: Request, ctx: C) => {
    try {
      const out = await fn(req, ctx);
      return out instanceof Response ? out : NextResponse.json(out);
    } catch (e) {
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

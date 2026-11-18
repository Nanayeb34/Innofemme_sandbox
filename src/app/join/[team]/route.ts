import { NextResponse } from "next/server";
import { teamById } from "@/engine/worlds";
import { publicOrigin, teamCookie } from "@/server/http";

/** The QR code target: stores the team key in a cookie, then opens the team's list of systems. */
export async function GET(req: Request, ctx: RouteContext<"/join/[team]">) {
  const { team } = await ctx.params;
  const url = new URL(req.url);
  const t = teamById(team);
  if (!t || url.searchParams.get("k") !== t.key) return new NextResponse("This QR code is not valid. Ask an organiser for your team's code.", { status: 401 });
  const res = NextResponse.redirect(new URL(`/t/${team}`, publicOrigin(req)));
  res.cookies.set(teamCookie(team), t.key, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 14 });
  return res;
}

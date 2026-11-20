import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { roleHome, roleOfKey, teamById } from "@/engine/worlds";
import { isOrganiser, publicOrigin, teamCookie } from "@/server/http";

/**
 * The QR code target. The key in the link says what it opens: the team's systems, only the customer
 * phone, or only the agent screens. It is stored in a cookie, then the browser goes to that starting page.
 */
export async function GET(req: Request, ctx: RouteContext<"/join/[team]">) {
  const { team } = await ctx.params;
  const t = teamById(team);
  const key = new URL(req.url).searchParams.get("k");
  const role = t ? roleOfKey(t, key) : undefined;
  if (!t || !role || !key) return new NextResponse("This QR code is not valid. Ask an organiser for your team's code.", { status: 401 });
  const res = NextResponse.redirect(new URL(roleHome(team, role), publicOrigin(req)));
  // A browser that already holds the team's own key keeps it: scanning a phone code must not lock a teammate out of the consoles.
  const held = roleOfKey(t, (await cookies()).get(teamCookie(team))?.value);
  // An organiser trying out a phone code keeps the consoles too, including after signing out.
  const keep = held === "team" ? undefined : role !== "team" && (await isOrganiser(req)) ? t.key : key;
  if (keep) res.cookies.set(teamCookie(team), keep, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 14 });
  return res;
}

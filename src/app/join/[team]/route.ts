import { NextResponse } from "next/server";
import { roleHome, roleOfKey, teamById } from "@/engine/worlds";
import { consoleCookie, isOrganiser, phoneCookie, publicOrigin } from "@/server/http";

/**
 * The QR code target. The key in the link says what it opens: the team's systems, only the customer
 * phone, or only the agent screens. It is kept by the browser, which then goes to that starting page.
 *
 * The team link and the phone codes are kept under different names. Opening a phone code therefore
 * never takes the consoles away from a device, and opening the team link always gives them to it.
 */
export async function GET(req: Request, ctx: RouteContext<"/join/[team]">) {
  const { team } = await ctx.params;
  const t = teamById(team);
  const key = new URL(req.url).searchParams.get("k");
  const role = t ? roleOfKey(t, key) : undefined;
  if (!t || !role || !key) return new NextResponse("This QR code is not valid. Ask an organiser for your team's code.", { status: 401 });
  const res = NextResponse.redirect(new URL(roleHome(team, role), publicOrigin(req)));
  const keep = { httpOnly: true, sameSite: "lax" as const, path: "/", maxAge: 60 * 60 * 24 * 14 };
  if (role === "team") res.cookies.set(consoleCookie(team), key, keep);
  else {
    res.cookies.set(phoneCookie(team), key, keep);
    // An organiser trying out a phone code keeps the consoles too, including after signing out.
    if (await isOrganiser(req)) res.cookies.set(consoleCookie(team), t.key, keep);
  }
  // Nothing in between may hand an earlier visitor's answer to this one.
  res.headers.set("cache-control", "no-store");
  return res;
}

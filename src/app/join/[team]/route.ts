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
  // Typed keys often pick up spaces or line breaks when copied from a message; a key never contains them.
  const key = new URL(req.url).searchParams.get("k")?.replace(/\s+/g, "") || null;
  const role = t ? roleOfKey(t, key) : undefined;
  if (!t || !role || !key) {
    const why = !t ? `There is no team called "${team}".` : !key ? "The link has no key in it." : `That key does not open ${t.name}. Check each letter: keys are case-sensitive.`;
    return new NextResponse(`${why} Ask a teammate to send the link from "Invite teammates" on your team's home page, or ask an organiser.`, { status: 401, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
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

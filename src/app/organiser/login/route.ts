import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { registry } from "@/engine/worlds";
import { ORG_COOKIE } from "@/server/http";

/** Organiser sign-in form target. */
export async function POST(req: Request) {
  const form = await req.formData();
  const key = String(form.get("key") ?? "").trim();
  const expected = registry().organiserKey;
  const ok = key.length === expected.length && timingSafeEqual(Buffer.from(key), Buffer.from(expected));
  const res = NextResponse.redirect(new URL(ok ? "/organiser" : "/organiser?error=1", req.url), 303);
  if (ok) res.cookies.set(ORG_COOKIE, expected, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 14 });
  return res;
}

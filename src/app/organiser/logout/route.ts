import { NextResponse } from "next/server";
import { ORG_COOKIE, publicOrigin } from "@/server/http";

export async function POST(req: Request) {
  const res = NextResponse.redirect(new URL("/", publicOrigin(req)), 303);
  res.cookies.delete(ORG_COOKIE);
  return res;
}

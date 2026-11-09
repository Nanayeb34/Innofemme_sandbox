import { NextResponse } from "next/server";
import { ORG_COOKIE } from "@/server/http";

export async function POST(req: Request) {
  const res = NextResponse.redirect(new URL("/", req.url), 303);
  res.cookies.delete(ORG_COOKIE);
  return res;
}

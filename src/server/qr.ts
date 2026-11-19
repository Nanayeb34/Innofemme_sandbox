import { headers } from "next/headers";
import QRCode from "qrcode";
import { PHONE_ROLES, roleKey, type Role, type Team } from "@/engine/worlds";

export interface AccessCode {
  role: Role;
  title: string;
  hint: string;
  url: string;
  /** The QR code as an SVG string. */
  qr: string;
}

const LABELS: Record<Role, { title: string; hint: string }> = {
  team: { title: "Team systems", hint: "Every console. For the team's laptops." },
  customer: { title: "Customer phone", hint: "Opens only the phone: dial, call, messages, wallet." },
  agent: { title: "Agent phone", hint: "Opens only the agent screens: mobile money agent and SIM registration." },
};

/** The address visitors use, for links that leave this page (QR codes). */
export async function pageOrigin(): Promise<string> {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, "");
  const h = await headers();
  return `${h.get("x-forwarded-proto") ?? "http"}://${h.get("x-forwarded-host") ?? h.get("host")}`;
}

export async function accessCode(origin: string, team: Team, role: Role, width: number): Promise<AccessCode> {
  const url = `${origin}/join/${team.id}?k=${roleKey(team, role)}`;
  return { role, ...LABELS[role], url, qr: await QRCode.toString(url, { type: "svg", margin: 1, width }) };
}

/** The two codes people scan with their own phones. */
export const phoneCodes = (origin: string, team: Team, width = 150) => Promise.all(PHONE_ROLES.map((r) => accessCode(origin, team, r, width)));

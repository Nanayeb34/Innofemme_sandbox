import { cookies } from "next/headers";
import { teamById } from "@/engine/worlds";
import { isOrganiser, teamCookie } from "./http";

/** Server-side page guard: true when the browser holds this team's key or organiser access. */
export async function canViewTeam(team: string): Promise<boolean> {
  const t = teamById(team);
  if (!t) return false;
  const jar = await cookies();
  return jar.get(teamCookie(team))?.value === t.key || (await isOrganiser());
}

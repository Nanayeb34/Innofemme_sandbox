import { headers } from "next/headers";
import { ORGANISER_WORLD, teamById, type Role } from "@/engine/worlds";
import { isOrganiser, savedRole } from "./http";

/** Server-side page guard: what this browser may open in a team's world, or null for nothing. */
export async function teamRole(team: string): Promise<Role | null> {
  if (team === ORGANISER_WORLD) return (await isOrganiser()) ? "team" : null;
  const t = teamById(team);
  if (!t) return null;
  if (await isOrganiser()) return "team";
  return savedRole(t, (await headers()).get("cookie")) ?? null;
}

/** True when the browser holds the team's own key (or organiser access), which opens every system. */
export const canViewTeam = async (team: string) => (await teamRole(team)) === "team";

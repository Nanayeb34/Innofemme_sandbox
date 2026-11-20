import { redirect } from "next/navigation";
import { roleHome, teamById } from "@/engine/worlds";
import { teamRole } from "@/server/guard";
import { telcoLogos } from "@/server/logos";
import { accessCode, pageOrigin, phoneCodes } from "@/server/qr";
import NoAccess from "./no-access";
import Hub from "./screens/hub";

export default async function HubPage(props: PageProps<"/t/[team]">) {
  const { team } = await props.params;
  const role = await teamRole(team);
  if (!role) return <NoAccess team={team} />;
  // A phone that scanned a customer or agent code goes to its own screen, not the list of systems.
  if (role !== "team") redirect(roleHome(team, role));
  const t = teamById(team);
  const origin = await pageOrigin();
  return <Hub team={team} logos={telcoLogos()} phones={t ? await phoneCodes(origin, t) : []} consoles={t ? { ...(await accessCode(origin, t, "team", 150)), key: t.key } : undefined} />;
}

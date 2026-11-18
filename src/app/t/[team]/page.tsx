import { canViewTeam } from "@/server/guard";
import { telcoLogos } from "@/server/logos";
import NoAccess from "./no-access";
import Hub from "./screens/hub";

export default async function HubPage(props: PageProps<"/t/[team]">) {
  const { team } = await props.params;
  if (!(await canViewTeam(team))) return <NoAccess />;
  return <Hub team={team} logos={telcoLogos()} />;
}

import { canViewTeam } from "@/server/guard";
import { NoAccess } from "../no-access";
import Console from "./console";

export default async function ConsolePage(props: PageProps<"/t/[team]/console">) {
  const { team } = await props.params;
  if (!(await canViewTeam(team))) return <NoAccess />;
  return <Console team={team} />;
}

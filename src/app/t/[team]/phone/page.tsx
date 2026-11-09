import { canViewTeam } from "@/server/guard";
import { NoAccess } from "../no-access";
import Phone from "./phone";

export default async function PhonePage(props: PageProps<"/t/[team]/phone">) {
  const { team } = await props.params;
  if (!(await canViewTeam(team))) return <NoAccess />;
  return <Phone team={team} />;
}

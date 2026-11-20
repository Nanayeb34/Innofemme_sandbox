import { canViewTeam } from "@/server/guard";
import { DocsContent } from "@/app/docs/content";
import NoAccess from "../no-access";

/** The documentation with this team's own address and key filled into every example. The public copy is at /docs. */
export default async function Docs(props: PageProps<"/t/[team]/docs">) {
  const { team } = await props.params;
  if (!(await canViewTeam(team))) return <NoAccess team={team} />;
  return <DocsContent team={team} />;
}

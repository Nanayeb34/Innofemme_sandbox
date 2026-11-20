import Link from "next/link";
import AssistantChat from "@/components/assistant-chat";
import { BrandBar } from "@/components/brand";
import { canViewTeam } from "@/server/guard";
import NoAccess from "../no-access";

/** The assistant, full size. */
export default async function AssistantPage(props: PageProps<"/t/[team]/assistant">) {
  const { team } = await props.params;
  if (!(await canViewTeam(team))) return <NoAccess team={team} />;
  return (
    <div className="flex h-dvh flex-col">
      <BrandBar
        subtitle="Assistant"
        right={
          <Link href={`/t/${team}`} className="ml-auto text-xs text-gray-600 underline">
            ← All systems
          </Link>
        }
      />
      <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col">
        <AssistantChat team={team} tall />
      </div>
    </div>
  );
}

import Link from "next/link";
import AssistantChat from "@/components/assistant-chat";
import { InnofemmeLogo } from "@/components/brand";
import { canViewTeam } from "@/server/guard";
import NoAccess from "../no-access";

/** The assistant, full size: conversations on the left, the conversation in the middle. */
export default async function AssistantPage(props: PageProps<"/t/[team]/assistant">) {
  const { team } = await props.params;
  if (!(await canViewTeam(team))) return <NoAccess team={team} />;
  const name = team === "organiser" ? "Organiser world" : team.replace("team-", "Team ");
  return (
    <div className="flex h-dvh flex-col bg-white">
      <header className="flex shrink-0 items-center gap-3 border-b border-gray-200 px-4 py-2.5">
        <Link href={`/t/${team}`} className="inline-flex items-center gap-2 rounded-lg bg-[#3b1f6e] px-3.5 py-2 text-sm font-semibold text-white shadow-sm hover:bg-[#2e1757]">
          <span aria-hidden>←</span> Back to {name}
        </Link>
        <div className="ml-1 hidden h-6 w-px bg-gray-200 sm:block" />
        <InnofemmeLogo size={30} />
        <div className="leading-tight">
          <div className="text-sm font-semibold text-gray-900">Assistant</div>
          <div className="text-xs text-gray-500">{name} · Mobile money sandbox</div>
        </div>
      </header>
      <AssistantChat team={team} tall />
    </div>
  );
}

import AssistantLauncher from "@/components/assistant-launcher";
import { provider } from "@/server/assistant/llm";
import { teamRole } from "@/server/guard";

/** Every page of a team's area. The assistant is within reach from all of them, for the team itself: not on a customer's or an agent's phone. */
export default async function TeamLayout(props: LayoutProps<"/t/[team]">) {
  const { team } = await props.params;
  const showAssistant = !!provider() && (await teamRole(team)) === "team";
  return (
    <>
      {props.children}
      {showAssistant && <AssistantLauncher team={team} />}
    </>
  );
}

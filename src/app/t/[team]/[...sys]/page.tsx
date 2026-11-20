import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { teamRole } from "@/server/guard";
import { telcoLogos } from "@/server/logos";
import { BANK_IDS, isTelco } from "@/engine/util";
import { roleHome, type Role } from "@/engine/worlds";
import NoAccess from "../no-access";
import TeamKey from "../team-key";
import AgentMenu from "../screens/agent-menu";
import { MomoPoint, SimPoint } from "../screens/agents";
import Bank from "../screens/bank";
import Care from "../screens/care";
import Fraud from "../screens/fraud";
import Nia from "../screens/nia";
import Phone from "../screens/phone";
import { Bog, Nca } from "../screens/regulators";
import Switch from "../screens/switch";
import TelcoConsole from "../screens/telco";

/** What each kind of link may open. The team's own key opens everything. */
function allowed(role: Role, system: string): boolean {
  if (role === "team") return true;
  if (role === "customer") return system === "phone";
  return system === "agent" || system === "momo-agent" || system === "sim-agent";
}

/** One page per institution: /t/{team}/nia, /telco/mtn, /care/mtn, /sim-agent/mtn, /momo-agent/mtn, /agent, /phone, /bank/gcb, /switch, /bog, /nca */
export default async function SystemPage(props: PageProps<"/t/[team]/[...sys]">) {
  const { team, sys } = await props.params;
  const role = await teamRole(team);
  if (!role) return <NoAccess team={team} />;
  const [system, which] = sys;
  if (!allowed(role, system)) {
    return (
      <main className="mx-auto flex max-w-md flex-1 flex-col items-center justify-center px-6 text-center">
        <h1 className="text-xl font-semibold text-gray-900">{role === "customer" ? "This device is set up as a customer phone" : "This device is set up as an agent phone"}</h1>
        <p className="mt-2 text-sm text-gray-600">
          It opened the {role} phone code, which shows only {role === "customer" ? "the phone" : "the agent screens"}. The consoles have their own, different link: your <b>team link</b>. Open the team link on this device, or enter the team key below, and it
          becomes a console. Other devices are not affected.
        </p>
        <TeamKey team={team} label="Enter your team key to use this device for the consoles" />
        <Link href={roleHome(team, role)} className="mt-4 text-sm text-gray-600 underline">
          {role === "customer" ? "Back to the phone" : "Back to the agent screens"}
        </Link>
      </main>
    );
  }
  // Where a phone-only device is sent to switch to the consoles. A device that already has them goes to the home page.
  if (system === "console") redirect(`/t/${team}`);
  if (sys.length === 1) {
    if (system === "nia") return <Nia team={team} />;
    if (system === "fraud") return <Fraud team={team} />;
    if (system === "phone") return <Phone team={team} role={role} />;
    if (system === "agent") return <AgentMenu team={team} role={role} logos={telcoLogos()} />;
    if (system === "switch") return <Switch team={team} />;
    if (system === "bog") return <Bog team={team} />;
    if (system === "nca") return <Nca team={team} />;
  }
  if (sys.length === 2 && isTelco(which)) {
    if (system === "telco") return <TelcoConsole team={team} telco={which} />;
    if (system === "care") return <Care team={team} telco={which} />;
    if (system === "sim-agent") return <SimPoint team={team} telco={which} role={role} />;
    if (system === "momo-agent") return <MomoPoint team={team} telco={which} role={role} />;
  }
  if (sys.length === 2 && system === "bank" && BANK_IDS.includes(which)) return <Bank team={team} bank={which} />;
  notFound();
}

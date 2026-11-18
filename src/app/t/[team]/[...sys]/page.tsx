import { notFound } from "next/navigation";
import { canViewTeam } from "@/server/guard";
import { BANK_IDS, isTelco } from "@/engine/util";
import NoAccess from "../no-access";
import { MomoPoint, SimPoint } from "../screens/agents";
import Bank from "../screens/bank";
import Nia from "../screens/nia";
import Phone from "../screens/phone";
import { Bog, Nca } from "../screens/regulators";
import Switch from "../screens/switch";
import TelcoConsole from "../screens/telco";

/** One page per institution: /t/{team}/nia, /telco/mtn, /sim-agent/mtn, /momo-agent/mtn, /phone, /bank/gcb, /switch, /bog, /nca */
export default async function SystemPage(props: PageProps<"/t/[team]/[...sys]">) {
  const { team, sys } = await props.params;
  if (!(await canViewTeam(team))) return <NoAccess />;
  const [system, which] = sys;
  if (sys.length === 1) {
    if (system === "nia") return <Nia team={team} />;
    if (system === "phone") return <Phone team={team} />;
    if (system === "switch") return <Switch team={team} />;
    if (system === "bog") return <Bog team={team} />;
    if (system === "nca") return <Nca team={team} />;
  }
  if (sys.length === 2 && isTelco(which)) {
    if (system === "telco") return <TelcoConsole team={team} telco={which} />;
    if (system === "sim-agent") return <SimPoint team={team} telco={which} />;
    if (system === "momo-agent") return <MomoPoint team={team} telco={which} />;
  }
  if (sys.length === 2 && system === "bank" && BANK_IDS.includes(which)) return <Bank team={team} bank={which} />;
  notFound();
}

"use client";

import Link from "next/link";
import { InnofemmeLogo } from "@/components/brand";
import { TelcoMark } from "@/components/telco-mark";
import { teamName } from "@/lib/client";

const TELCOS: [string, string, string][] = [["mtn", "MTN", "MTN MoMo"], ["telecel", "Telecel", "Telecel Cash"], ["at", "AT", "AT Money"]];

/** Where the agent QR code lands: choose which kind of agent you are, and on which network. */
export default function AgentMenu({ team, role, logos }: { team: string; role: string; logos: Record<string, string | null> }) {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col px-4 py-5">
      <div className="mb-4 flex items-center gap-3">
        <InnofemmeLogo size={32} />
        <div className="mr-auto leading-tight">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-[#3b1f6e]">{teamName(team)}</div>
          <h1 className="text-lg font-semibold text-gray-900">Agent phone</h1>
        </div>
        {role === "team" && (
          <Link href={`/t/${team}`} className="rounded-full border border-gray-300 bg-white px-3 py-1 text-xs font-medium text-gray-700">
            ← All systems
          </Link>
        )}
      </div>
      <p className="mb-4 text-sm text-gray-600">There are two kinds of agent. Choose the one you are working as, and your network.</p>

      <Kind title="Mobile money agent" detail="Cash-in, cash-out, register customers for mobile money, float and till." />
      <div className="mb-5 grid gap-2">
        {TELCOS.map(([id, , wallet]) => (
          <Link key={id} href={`/t/${team}/momo-agent/${id}`} className="card flex items-center gap-3 p-3 active:bg-gray-50">
            <TelcoMark telco={id} logo={logos[id]} height={30} />
            <span className="font-medium text-gray-900">{wallet} agent</span>
            <span className="ml-auto text-gray-400">›</span>
          </Link>
        ))}
      </div>

      <Kind title="SIM registration agent" detail="Register SIMs with the Ghana Card, replace SIMs, block and unblock, reset wallet PINs." />
      <div className="grid gap-2">
        {TELCOS.map(([id, name]) => (
          <Link key={id} href={`/t/${team}/sim-agent/${id}`} className="card flex items-center gap-3 p-3 active:bg-gray-50">
            <TelcoMark telco={id} logo={logos[id]} height={30} />
            <span className="font-medium text-gray-900">{name} SIM registration</span>
            <span className="ml-auto text-gray-400">›</span>
          </Link>
        ))}
      </div>
    </main>
  );
}

function Kind({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="mb-2">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">{title}</h2>
      <p className="text-xs text-gray-600">{detail}</p>
    </div>
  );
}

import { isOrganiser } from "@/server/http";
import { registry } from "@/engine/worlds";
import { InnofemmeLogo } from "@/components/brand";
import { accessCode, pageOrigin, phoneCodes } from "@/server/qr";

/** Printable cards: one per team, with the code for the team's systems and the two codes for phones. */
export default async function QrCards() {
  if (!(await isOrganiser())) return <main className="p-8 text-center text-sm">Organisers only.</main>;
  const origin = await pageOrigin();
  const cards = await Promise.all(registry().teams.map(async (t) => ({ team: t, systems: await accessCode(origin, t, "team", 200), phones: await phoneCodes(origin, t, 150) })));
  return (
    <main className="mx-auto grid max-w-5xl grid-cols-1 gap-4 p-6">
      {cards.map((c) => (
        <div key={c.team.id} className="card break-inside-avoid p-5">
          <div className="flex items-center gap-3">
            <InnofemmeLogo size={40} />
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wider text-[#3b1f6e]">Innofemme · Mobile Money Fraud Hackathon</div>
              <div className="text-2xl font-bold text-gray-900">{c.team.name}</div>
            </div>
          </div>
          <div className="mt-4 grid gap-4 sm:grid-cols-3 print:grid-cols-3">
            {[c.systems, ...c.phones].map((code) => (
              <div key={code.role} className="flex flex-col items-center rounded-lg border border-gray-200 p-3 text-center">
                <div className="font-semibold text-gray-900">{code.title}</div>
                <div className={`mt-2 ${code.role === "team" ? "w-[200px]" : "w-[150px]"}`} dangerouslySetInnerHTML={{ __html: code.qr }} />
                <p className="mt-2 text-xs text-gray-600">{code.hint}</p>
                <p className="mt-1 break-all font-mono text-[9px] text-gray-400">{code.url}</p>
              </div>
            ))}
          </div>
          <p className="mt-3 text-center text-xs text-gray-500">
            Keep the team systems code within your team. The two phone codes can be shared with anyone playing a customer or an agent. Your world starts empty: begin at NIA.
          </p>
        </div>
      ))}
    </main>
  );
}

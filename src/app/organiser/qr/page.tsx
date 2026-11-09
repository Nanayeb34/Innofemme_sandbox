import { headers } from "next/headers";
import QRCode from "qrcode";
import { isOrganiser } from "@/server/http";
import { registry } from "@/engine/worlds";
import { InnofemmeLogo } from "@/components/brand";

/** Printable cards: one per team, the QR opens that team's sandbox phone. */
export default async function QrCards() {
  if (!(await isOrganiser())) return <main className="p-8 text-center text-sm">Organisers only.</main>;
  const h = await headers();
  const origin = process.env.PUBLIC_URL || `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host")}`;
  const cards = await Promise.all(
    registry().teams.map(async (t) => {
      const url = `${origin}/join/${t.id}?k=${t.key}`;
      return { ...t, url, svg: await QRCode.toString(url, { type: "svg", margin: 1, width: 220 }) };
    }),
  );
  return (
    <main className="mx-auto grid max-w-5xl grid-cols-1 gap-4 p-6 sm:grid-cols-2 print:grid-cols-2">
      {cards.map((c) => (
        <div key={c.id} className="card flex break-inside-avoid flex-col items-center p-5 text-center">
          <InnofemmeLogo size={44} />
          <div className="mt-1 text-[11px] font-semibold uppercase tracking-wider text-[#3b1f6e]">Innofemme · Mobile Money Fraud Hackathon</div>
          <div className="mt-1 text-2xl font-bold text-gray-900">{c.name}</div>
          <div className="mt-3 w-[220px]" dangerouslySetInnerHTML={{ __html: c.svg }} />
          <p className="mt-3 text-sm text-gray-700">Scan with your phone camera to open your team&apos;s phone and console.</p>
          <p className="mt-1 text-xs text-gray-500">MTN *170# · Telecel *110# · AT *110# · Wallet PIN 1234</p>
          <p className="mt-1 text-[10px] font-medium uppercase tracking-wide text-gray-400">Keep this card within your team</p>
          <p className="mt-2 break-all font-mono text-[10px] text-gray-400">{c.url}</p>
        </div>
      ))}
    </main>
  );
}

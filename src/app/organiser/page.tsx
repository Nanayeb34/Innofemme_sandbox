import { headers } from "next/headers";
import QRCode from "qrcode";
import { isOrganiser } from "@/server/http";
import { registry } from "@/engine/worlds";
import { SCENARIOS } from "@/engine/config/schemas";
import { BrandBar, InnofemmeLogo } from "@/components/brand";
import Dashboard from "./dashboard";

export default async function OrganiserPage(props: PageProps<"/organiser">) {
  if (!(await isOrganiser())) {
    const { error } = await props.searchParams;
    return (
      <main className="flex flex-1 items-center justify-center bg-gradient-to-b from-[#f3effa] to-[var(--background)] px-6 py-12">
        <form action="/organiser/login" method="post" className="card w-full max-w-sm p-6 text-center">
          <div className="flex justify-center">
            <InnofemmeLogo size={56} />
          </div>
          <h1 className="mt-3 text-xl font-semibold text-gray-900">Organiser sign-in</h1>
          <p className="mt-1 text-sm text-gray-600">Mobile Money Fraud Hackathon</p>
          <input name="key" type="password" required autoFocus placeholder="Organiser access key" className="mt-5 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" aria-label="Organiser access key" />
          {error && <p className="mt-2 text-xs text-red-600">That key is not valid.</p>}
          <button className="btn btn-dark mt-4 w-full justify-center">Sign in</button>
        </form>
      </main>
    );
  }

  const h = await headers();
  const origin = process.env.PUBLIC_URL || `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host")}`;
  const teams = await Promise.all(
    registry().teams.map(async (t) => {
      const joinUrl = `${origin}/join/${t.id}?k=${t.key}`;
      return { id: t.id, name: t.name, joinUrl, qr: await QRCode.toString(joinUrl, { type: "svg", margin: 1, width: 132 }) };
    }),
  );

  return (
    <>
      <BrandBar
        subtitle="Organiser dashboard"
        right={
          <>
            <a href="/organiser/qr" target="_blank" className="btn">
              Print team QR cards
            </a>
            <form action="/organiser/logout" method="post">
              <button className="btn">Sign out</button>
            </form>
          </>
        }
      />
      <Dashboard scenarios={SCENARIOS} access={teams} />
    </>
  );
}

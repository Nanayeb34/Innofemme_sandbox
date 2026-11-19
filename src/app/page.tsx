import Link from "next/link";
import { InnofemmeLogo } from "@/components/brand";
import { TelcoMark } from "@/components/telco-mark";
import { telcoLogos } from "@/server/logos";
import { cookies } from "next/headers";
import { registry, roleHome, roleOfKey } from "@/engine/worlds";
import { teamCookie } from "@/server/http";

export default async function Home() {
  const logos = telcoLogos();
  // Teams this browser has already joined by scanning their QR card.
  const jar = await cookies();
  const joined = registry()
    .teams.map((t) => ({ ...t, role: roleOfKey(t, jar.get(teamCookie(t.id))?.value) }))
    .filter((t) => t.role);
  return (
    <main className="flex flex-1 flex-col">
      <section className="flex flex-1 items-center bg-gradient-to-b from-[#f3effa] to-[var(--background)]">
        <div className="mx-auto w-full max-w-3xl px-6 py-14 text-center">
          <div className="flex justify-center">
            <InnofemmeLogo size={88} />
          </div>
          <div className="mt-4 text-sm font-bold tracking-[0.2em] text-[#3b1f6e]">INNOFEMME</div>
          <h1 className="mt-2 text-3xl font-semibold text-gray-900 sm:text-4xl">Mobile Money Fraud Hackathon</h1>
          <p className="mt-2 text-gray-600">26–28 November 2026 · KNUST, Kumasi</p>

          <p className="mx-auto mt-6 max-w-xl text-gray-700">
            Build and run Ghana&apos;s mobile money system from the ground up: identity, SIM registration, telcos, agents, banks and the national switch. Every team works in its own copy, from a browser and from code.
          </p>

          <div className="mt-6 flex items-center justify-center gap-3">
            <TelcoMark telco="mtn" logo={logos.mtn} height={44} />
            <TelcoMark telco="telecel" logo={logos.telecel} height={44} />
            <TelcoMark telco="at" logo={logos.at} height={44} />
          </div>

          {joined.length > 0 ? (
            <div className="mx-auto mt-10 max-w-md space-y-3">
              {joined.map((t) => (
                <div key={t.id} className="card p-5">
                  <div className="font-semibold text-gray-900">{t.name}</div>
                  <div className="mt-3 flex justify-center gap-2">
                    <Link href={roleHome(t.id, t.role!)} className="btn btn-dark">
                      {t.role === "team" ? "Open your systems" : t.role === "customer" ? "Open the phone" : "Open the agent screens"}
                    </Link>
                    {t.role === "team" && (
                      <Link href={`/t/${t.id}/phone`} className="btn">
                        Open a phone
                      </Link>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="mx-auto mt-10 flex max-w-md items-center gap-4 rounded-2xl border border-[#d9cdee] bg-white/70 p-5 text-left">
              <svg viewBox="0 0 24 24" aria-hidden="true" className="h-10 w-10 shrink-0 text-[#3b1f6e]" fill="none" stroke="currentColor" strokeWidth="1.6">
                <path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3" />
                <path d="M8 8h3v3H8zM13 13h3v3h-3zM13 8h3M8 13v3h3" />
              </svg>
              <div>
                <div className="font-semibold text-gray-900">Getting started</div>
                <p className="mt-0.5 text-sm text-gray-600">Scan the QR code on your team card with your phone camera. It opens your team&apos;s systems.</p>
              </div>
            </div>
          )}
        </div>
      </section>
      <footer className="border-t border-gray-200 bg-white py-4 text-center text-xs text-gray-500">Innofemme · Accra, Ghana · hackathon@innofemme.org · +233 54 162 5107</footer>
    </main>
  );
}

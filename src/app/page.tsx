import Link from "next/link";
import { InnofemmeLogo } from "@/components/brand";
import { TelcoMark } from "@/components/telco-mark";
import { telcoLogos } from "@/server/logos";

export default function Home() {
  const logos = telcoLogos();
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
            Investigate, redesign and defend mobile money services across networks, banks and the national switch. Every team works in its own environment, from a phone and from code.
          </p>

          <div className="mt-6 flex items-center justify-center gap-3">
            <TelcoMark telco="mtn" logo={logos.mtn} height={44} />
            <TelcoMark telco="telecel" logo={logos.telecel} height={44} />
            <TelcoMark telco="at" logo={logos.at} height={44} />
          </div>

          <div className="mx-auto mt-10 grid max-w-2xl gap-4 text-left sm:grid-cols-2">
            <div className="card p-5">
              <div className="font-semibold text-gray-900">Participants</div>
              <p className="mt-1 text-sm text-gray-600">Scan the QR code on your team card with your phone camera. It opens your team&apos;s phone and console.</p>
            </div>
            <div className="card flex flex-col p-5">
              <div className="font-semibold text-gray-900">Organisers</div>
              <p className="mt-1 flex-1 text-sm text-gray-600">Manage all teams, print team QR cards and follow the leaderboard.</p>
              <Link href="/organiser" className="btn btn-dark mt-3 self-start">
                Organiser sign-in
              </Link>
            </div>
          </div>
        </div>
      </section>
      <footer className="border-t border-gray-200 bg-white py-4 text-center text-xs text-gray-500">Innofemme · Accra, Ghana · hackathon@innofemme.org · +233 54 162 5107</footer>
    </main>
  );
}

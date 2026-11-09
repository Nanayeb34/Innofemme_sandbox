import Image from "next/image";
import Link from "next/link";

export function InnofemmeLogo({ size = 40 }: { size?: number }) {
  return <Image src="/brand/innofemme.png" alt="Innofemme" width={Math.round(size * 1.31)} height={size} priority />;
}

/** Innofemme lock-up used at the top of every non-phone page. */
export function BrandBar({ right, subtitle = "Mobile Money Fraud Hackathon" }: { right?: React.ReactNode; subtitle?: string }) {
  return (
    <header className="border-b border-gray-200 bg-white">
      <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-3">
        <Link href="/" className="flex items-center gap-3">
          <InnofemmeLogo size={36} />
          <div className="leading-tight">
            <div className="text-sm font-bold tracking-wide text-[#3b1f6e]">INNOFEMME</div>
            <div className="text-xs text-gray-500">{subtitle}</div>
          </div>
        </Link>
        <div className="ml-auto flex flex-wrap items-center gap-2">{right}</div>
      </div>
    </header>
  );
}

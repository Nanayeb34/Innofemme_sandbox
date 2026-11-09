/* eslint-disable @next/next/no-img-element -- partner logos are dropped into public/ as-is (SVG or PNG) */

const WORDMARK: Record<string, { label: string; bg: string; fg: string }> = {
  mtn: { label: "MTN", bg: "#ffcb05", fg: "#111827" },
  telecel: { label: "telecel", bg: "#e60000", fg: "#ffffff" },
  at: { label: "AT", bg: "#1f3c88", fg: "#ffffff" },
};

/**
 * A telco's logo. Uses the official file from public/brand/telcos/{telco}.(svg|png) when the
 * server reports one, otherwise a brand-coloured wordmark.
 */
export function TelcoMark({ telco, logo, height = 20 }: { telco: string; logo?: string | null; height?: number }) {
  if (logo) return <img src={logo} alt={WORDMARK[telco]?.label ?? telco} style={{ height }} className="w-auto rounded-sm object-contain" />;
  const w = WORDMARK[telco] ?? { label: telco.toUpperCase(), bg: "#334155", fg: "#fff" };
  return (
    <span className="inline-flex items-center rounded px-1.5 font-extrabold tracking-tight" style={{ background: w.bg, color: w.fg, height, fontSize: height * 0.6 }}>
      {w.label}
    </span>
  );
}

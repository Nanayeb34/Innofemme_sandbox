/**
 * The assistant's own mark: three linked nodes, for the small team of specialists that does the work, around
 * a centre. Still at rest; while the assistant works, the team turns and each node lights up in turn.
 */
export function AssistantGlyph({ size = 32, active = false, className = "" }: { size?: number; active?: boolean; className?: string }) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} className={`shrink-0 ${active ? "glyph-active" : ""} ${className}`} aria-hidden>
      <defs>
        <linearGradient id="glyph-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#4c2a8a" />
          <stop offset="1" stopColor="#2a1450" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill="url(#glyph-bg)" />
      <circle cx="16" cy="16.6" r="9.2" fill="none" stroke="#ffffff" strokeOpacity="0.12" strokeWidth="1" className="glyph-ring" />
      <g className="glyph-team">
        <path d="M16 8.6 L23 20.6 L9 20.6 Z" fill="none" stroke="#d8ccf0" strokeOpacity="0.55" strokeWidth="1.3" strokeLinejoin="round" />
        <circle cx="16" cy="8.6" r="2.7" fill="#ffffff" className="glyph-node" />
        <circle cx="23" cy="20.6" r="2.7" fill="#c4b5fd" className="glyph-node glyph-node-2" />
        <circle cx="9" cy="20.6" r="2.7" fill="#f0abfc" className="glyph-node glyph-node-3" />
      </g>
      <circle cx="16" cy="16.6" r="1.5" fill="#ffffff" fillOpacity="0.9" />
    </svg>
  );
}

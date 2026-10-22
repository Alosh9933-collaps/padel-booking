// The padel racket logo and the court artwork used across the app.

const HOLES: [number, number][] = [];
for (let row = 0; row < 4; row++) {
  const y = 13 + row * 5;
  for (let x = 17; x <= 47; x += 5) {
    const cx = row % 2 ? x + 2.5 : x;
    const dx = (cx - 32) / 13;
    const dy = (y - 22) / 13;
    // Staggered holes, only where they sit comfortably inside the racket face.
    if (dx * dx + dy * dy < 0.8) HOLES.push([cx, y]);
  }
}

export function RacketMark({ size = 40 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden className="racket-mark">
      <g transform="rotate(-35 32 32)">
        <path
          d="M32 3C45 3 51 12 51 22.5C51 33 44 40 36.5 42L35.5 49H28.5L27.5 42C20 40 13 33 13 22.5C13 12 19 3 32 3Z"
          fill="var(--court)"
        />
        <path
          d="M32 7C42.5 7 47 14 47 22.5C47 31 41 37 32 37C23 37 17 31 17 22.5C17 14 21.5 7 32 7Z"
          fill="var(--court-bright)"
        />
        <g fill="var(--navy)">
          {HOLES.map(([x, y]) => (
            <circle key={`${x}-${y}`} cx={x} cy={y} r={1.5} />
          ))}
          <path d="M32 39.5L29.5 44H34.5Z" />
        </g>
        <rect x="28.5" y="48" width="7" height="14" rx="2.5" fill="var(--navy)" />
        <path d="M28.5 52H35.5M28.5 55.5H35.5M28.5 59H35.5" stroke="var(--court-bright)" strokeWidth="0.8" />
      </g>
      <circle cx="50" cy="49" r="8" fill="var(--ball)" stroke="var(--navy)" strokeWidth="1.5" />
      <path
        d="M44 45.5C47.5 47.5 47.5 51.5 44.5 53.5M56 44.5C52.5 46.5 52.5 51 56 53"
        fill="none"
        stroke="var(--navy)"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function Logo({ size = 40, light = false }: { size?: number; light?: boolean }) {
  return (
    <span className={`logo${light ? " logo-light" : ""}`}>
      <RacketMark size={size} />
      <span className="logo-word">
        <strong>PADEL</strong>
        <span>booking</span>
      </span>
    </span>
  );
}

/** Top view of a 10 x 20 m padel court: glass walls, service lines and the net. */
export function CourtArt({
  className,
  surface = "var(--court)",
  showBall = true,
}: {
  className?: string;
  surface?: string;
  showBall?: boolean;
}) {
  return (
    <svg viewBox="0 0 220 120" className={className} aria-hidden>
      <rect x="1" y="1" width="218" height="118" rx="6" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.35)" strokeWidth="1.5" />
      <rect x="10" y="10" width="200" height="100" rx="2" fill={surface} />
      <g fill="none" stroke="#fff" strokeWidth="1.6" opacity="0.92">
        <rect x="10" y="10" width="200" height="100" />
        <line x1="40.5" y1="10" x2="40.5" y2="110" />
        <line x1="179.5" y1="10" x2="179.5" y2="110" />
        <line x1="40.5" y1="60" x2="179.5" y2="60" />
      </g>
      <line x1="110" y1="4" x2="110" y2="116" stroke="var(--navy)" strokeWidth="3" />
      <line x1="110" y1="4" x2="110" y2="116" stroke="#fff" strokeWidth="1" strokeDasharray="2 2" />
      <circle cx="110" cy="4" r="2.6" fill="var(--navy)" />
      <circle cx="110" cy="116" r="2.6" fill="var(--navy)" />
      {showBall && (
        <g>
          <circle cx="150" cy="38" r="5" fill="var(--ball)" stroke="var(--navy)" strokeWidth="0.8" />
          <path d="M146.5 35.5c2 1.2 2 3.8 0 5M153.5 35c-2 1.3-2 4 0 5.4" fill="none" stroke="var(--navy)" strokeWidth="0.7" />
        </g>
      )}
    </svg>
  );
}

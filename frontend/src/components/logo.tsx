/** The dioramic mark from the brand kit: a dimensional "D" whose counter holds
 * an isometric diorama - land, mountain, river, and the pixels feeding into it.
 * Drawn inline (rather than <img src="/brand/logo-mark.svg">) so it needs no
 * network request and can be sized by className like any other icon.
 *
 * The gradient ids are prefixed so they cannot collide with other inline SVGs.
 * Repeated instances reuse the same definitions, which is what we want - every
 * mark paints identically.
 */

const edge = "dioramic-mark-edge";
const land = "dioramic-mark-land";
const water = "dioramic-mark-water";

export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 512 512" className={className} aria-hidden="true">
      <defs>
        <linearGradient id={edge} x1="70" y1="90" x2="440" y2="430" gradientUnits="userSpaceOnUse">
          <stop stopColor="#18BFFF" />
          <stop offset="0.52" stopColor="#4567FF" />
          <stop offset="1" stopColor="#A23BFF" />
        </linearGradient>
        <linearGradient id={land} x1="150" y1="250" x2="360" y2="390" gradientUnits="userSpaceOnUse">
          <stop stopColor="#62E6A8" />
          <stop offset="1" stopColor="#2BB673" />
        </linearGradient>
        <linearGradient id={water} x1="250" y1="270" x2="320" y2="410" gradientUnits="userSpaceOnUse">
          <stop stopColor="#55D9FF" />
          <stop offset="1" stopColor="#1686FF" />
        </linearGradient>
      </defs>

      {/* dimensional D */}
      <path
        d="M92 76h154c111 0 190 74 190 180s-79 180-190 180H92z"
        fill="none"
        stroke={`url(#${edge})`}
        strokeWidth="46"
        strokeLinejoin="round"
      />
      <path
        d="M140 122v268h101c82 0 141-51 141-134s-59-134-141-134z"
        fill="none"
        stroke="#17203A"
        strokeWidth="28"
      />

      {/* isometric ground plane */}
      <path d="M132 310l116-62 136 70-120 67z" fill={`url(#${land})`} />
      <path d="M132 310v49l132 78v-52z" fill="#234B45" />
      <path d="M384 318v48l-120 71v-52z" fill="#173B49" />

      {/* mountain */}
      <path d="M175 294l67-101 38 62 27-35 54 78z" fill="#DCEBFF" />
      <path d="M175 294l67-101 16 48-36 50z" fill="#91A9C7" />
      <path d="M242 193l38 62-22-13-16 48-31-46z" fill="#7188A9" />

      {/* trees */}
      <g fill="#1A9D63">
        <path d="M170 293l18-32 18 32z" />
        <path d="M178 275l10-25 10 25z" />
        <path d="M332 304l18-33 18 33z" />
        <path d="M340 284l10-25 10 25z" />
      </g>

      {/* river */}
      <path
        d="M292 274c-14 31-7 49 13 64 22 17 22 34-4 58l28 17c43-35 40-64 9-88-23-18-25-30-10-54z"
        fill={`url(#${water})`}
      />

      {/* pixels dissolving into the scene */}
      <g fill={`url(#${edge})`}>
        <rect x="55" y="245" width="20" height="20" rx="4" />
        <rect x="30" y="278" width="14" height="14" rx="3" />
        <rect x="67" y="301" width="12" height="12" rx="3" />
        <rect x="42" y="327" width="18" height="18" rx="4" />
      </g>
    </svg>
  );
}

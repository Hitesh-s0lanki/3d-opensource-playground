/** The diorama mark: an isometric display box on an indigo gradient tile.
 * Drawn inline so it always matches the theme and needs no asset request.
 */

export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <defs>
        <linearGradient id="diorama-logo" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#818cf8" />
          <stop offset="0.55" stopColor="#4f46e5" />
          <stop offset="1" stopColor="#4338ca" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill="url(#diorama-logo)" />
      {/* isometric cube: top face lit, front edges outlined */}
      <path
        d="M16 6.6 24.4 11.4v9.2L16 25.4l-8.4-4.8v-9.2Z"
        fill="none"
        stroke="#fff"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path
        d="M7.6 11.4 16 16.2l8.4-4.8M16 16.2v9.2"
        fill="none"
        stroke="#fff"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path d="M16 6.6 24.4 11.4 16 16.2 7.6 11.4Z" fill="#fff" fillOpacity="0.32" />
    </svg>
  );
}

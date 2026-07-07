/**
 * SatSearch brand mark — a crosshair sighting over a tile grid. Reads as
 * "targeting satellite imagery". Colour-neutral: inherits `currentColor`.
 */
export function Mark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" fill="none" className={className} aria-hidden="true">
      <rect x="5.5" y="5.5" width="21" height="21" rx="2" stroke="currentColor" strokeOpacity="0.35" strokeWidth="1.5" />
      <path d="M16 3.5v6M16 22.5v6M3.5 16h6M22.5 16h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="16" cy="16" r="4.5" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="16" cy="16" r="1.5" fill="currentColor" />
    </svg>
  )
}

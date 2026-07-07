import { Cpu } from 'lucide-react'
import type { HealthStatus, Source } from '@shared/types'

export function StatsBar({
  health,
  sources,
  total
}: {
  health: HealthStatus | null
  sources: Source[]
  total: number | null
}) {
  const tiles = sources.reduce((a, s) => a + s.tileCount, 0)
  return (
    <div className="flex items-center justify-between border-t px-4 py-2 text-xs text-[var(--muted-foreground)]">
      <span>
        {sources.length} sources · {tiles.toLocaleString()} tiles
        {total != null && ` · ${total.toLocaleString()} matches`}
      </span>
      <span className="flex items-center gap-1.5">
        <Cpu className="h-3.5 w-3.5" />
        {health ? `${health.device} · ${health.dims}-d · ${health.fingerprint.slice(0, 8)}` : '—'}
      </span>
    </div>
  )
}

import type { ReactNode } from 'react'
import { Cpu, Database, Layers } from 'lucide-react'
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
    <footer className="flex items-center justify-between border-t border-border bg-card/40 px-4 py-2 text-xs text-muted-foreground">
      <div className="flex items-center gap-4">
        <Stat icon={<Layers className="h-3.5 w-3.5" />} label={`${sources.length} sources`} />
        <Stat icon={<Database className="h-3.5 w-3.5" />} label={`${tiles.toLocaleString()} tiles`} />
        {total != null && (
          <span className="tnum text-foreground/80">{total.toLocaleString()} matches</span>
        )}
      </div>

      <div className="flex items-center gap-2 font-mono text-[0.6875rem] tracking-wide">
        <span
          className={`h-1.5 w-1.5 rounded-full ${health?.ready ? 'bg-foreground/70' : 'bg-muted-foreground/40'}`}
        />
        <Cpu className="h-3.5 w-3.5" />
        {health ? (
          <span className="tnum">
            {health.device} · {health.dims}-d · {health.fingerprint.slice(0, 8)}
          </span>
        ) : (
          <span>offline</span>
        )}
      </div>
    </footer>
  )
}

function Stat({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="text-muted-foreground/70">{icon}</span>
      <span className="tnum">{label}</span>
    </span>
  )
}

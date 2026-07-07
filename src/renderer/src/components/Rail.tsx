import { LayoutDashboard, Search, Images, Tag, Layers } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { HealthStatus } from '@shared/types'
import { Mark } from './Mark'
import { cn } from '@/lib/utils'

export type Route = 'dashboard' | 'search' | 'gallery' | 'labels' | 'sources'

const NAV: { route: Route; label: string; icon: LucideIcon }[] = [
  { route: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { route: 'search', label: 'Search', icon: Search },
  { route: 'gallery', label: 'Gallery', icon: Images },
  { route: 'labels', label: 'Labels', icon: Tag },
  { route: 'sources', label: 'Sources', icon: Layers }
]

export function Rail({
  route,
  onNavigate,
  health,
  badges
}: {
  route: Route
  onNavigate: (r: Route) => void
  health: HealthStatus | null
  badges?: Partial<Record<Route, number | string>>
}) {
  return (
    <nav className="flex w-52 shrink-0 flex-col border-r border-border bg-card/40">
      <div className="flex items-center gap-2 px-4 py-3.5">
        <Mark className="h-5 w-5 text-foreground" />
        <span className="text-sm font-semibold tracking-tight">SatSearch</span>
      </div>

      <div className="flex flex-col gap-0.5 px-2 py-1">
        {NAV.map(({ route: r, label, icon: Icon }) => {
          const active = route === r
          const badge = badges?.[r]
          return (
            <button
              key={r}
              onClick={() => onNavigate(r)}
              className={cn(
                'group relative flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium transition-colors',
                active
                  ? 'bg-accent text-foreground'
                  : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
              )}
            >
              <span
                className={cn(
                  'absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-foreground transition-opacity',
                  active ? 'opacity-100' : 'opacity-0'
                )}
              />
              <Icon className="h-4 w-4 shrink-0" />
              <span className="flex-1 text-left">{label}</span>
              {badge != null && badge !== 0 && (
                <span className="tnum rounded bg-muted px-1 text-[0.625rem] text-muted-foreground">
                  {badge}
                </span>
              )}
            </button>
          )
        })}
      </div>

      <div className="mt-auto flex items-center gap-2 border-t border-border px-4 py-3 font-mono text-[0.6875rem] text-muted-foreground/70">
        <span
          className={cn(
            'h-1.5 w-1.5 shrink-0 rounded-full',
            health?.ready ? 'bg-foreground/70' : 'bg-muted-foreground/40'
          )}
        />
        <span className="truncate">
          {health ? `${health.device} · ${health.dims}-d` : 'connecting…'}
        </span>
      </div>
    </nav>
  )
}

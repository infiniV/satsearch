import { useState, type ReactNode } from 'react'
import { Search, Cpu, MapPin, CircleOff, CheckCircle2, XCircle, Ban } from 'lucide-react'
import type { HealthStatus, Job, Source } from '@shared/types'
import type { LabelClass } from '@/hooks/useClasses'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { IngestProgress } from '@/components/IngestProgress'
import { cn } from '@/lib/utils'

export function Dashboard({
  health,
  sources,
  jobs,
  classes,
  onQuickSearch,
  onOpenSource
}: {
  health: HealthStatus | null
  sources: Source[]
  jobs: Job[]
  classes: LabelClass[]
  onQuickSearch: (q: string) => void
  onOpenSource: (id: string) => void
}) {
  const [q, setQ] = useState('')
  const tiles = sources.reduce((a, s) => a + s.tileCount, 0)
  const geo = sources.filter((s) => s.hasGeo).length
  const maxTiles = Math.max(1, ...sources.map((s) => s.tileCount))
  const running = jobs.filter((j) => j.state === 'running')
  const recent = jobs.filter((j) => j.state !== 'running').slice(-5).reverse()
  const labelled = classes.reduce((a, c) => a + c.count, 0)

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-5xl flex-col gap-8 p-6">
        {/* headline + quick search */}
        <section className="space-y-4 pt-2">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              {sources.length ? 'Your corpus, at a glance' : 'Welcome to SatSearch'}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {sources.length
                ? `${tiles.toLocaleString()} embedded tiles across ${sources.length} ${
                    sources.length === 1 ? 'source' : 'sources'
                  } — ${geo} geolocated.`
                : 'Add a source under Sources, then search or browse your satellite tiles semantically.'}
            </p>
          </div>
          <div className="flex max-w-xl items-center gap-2 rounded-lg border border-border bg-card px-2.5 py-2 focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30">
            <Search className="ml-1 h-4 w-4 shrink-0 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && q.trim() && onQuickSearch(q.trim())}
              placeholder="Search every tile — “brick kiln”, “solar farm”…"
              className="h-8 border-0 bg-transparent px-1 shadow-none focus-visible:ring-0"
            />
            <Button className="h-8 shrink-0" disabled={!q.trim()} onClick={() => onQuickSearch(q.trim())}>
              Search
            </Button>
          </div>
        </section>

        {/* index health — horizontal instrument strip */}
        <section className="flex flex-wrap items-center gap-x-8 gap-y-3 rounded-lg border border-border bg-card/40 px-5 py-4">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                'h-2 w-2 rounded-full',
                health?.ready ? 'bg-foreground/70' : 'bg-muted-foreground/40'
              )}
            />
            <span className="text-sm font-medium">{health?.ready ? 'Index ready' : 'Starting…'}</span>
          </div>
          <Metric icon={<Cpu className="h-3.5 w-3.5" />} label="device" value={health?.device ?? '—'} />
          <Metric label="dims" value={health ? `${health.dims}` : '—'} />
          <Metric label="model" value={health ? health.fingerprint.slice(0, 10) : '—'} mono />
          <Metric icon={<MapPin className="h-3.5 w-3.5" />} label="geolocated" value={`${geo}`} />
          <Metric
            icon={<CircleOff className="h-3.5 w-3.5" />}
            label="non-geo"
            value={`${sources.length - geo}`}
          />
        </section>

        {/* asymmetric body: sources + jobs (wide) | labels (narrow) */}
        <div className="grid grid-cols-1 gap-8 lg:grid-cols-[1.7fr_1fr]">
          <div className="space-y-8">
            <section className="space-y-3">
              <SectionHead title="Sources" hint={`${sources.length}`} />
              {sources.length === 0 ? (
                <Empty>No sources yet.</Empty>
              ) : (
                <div className="space-y-2.5">
                  {sources.map((s) => (
                    <button
                      key={s.id}
                      onClick={() => s.tileCount > 0 && onOpenSource(s.id)}
                      className="group block w-full text-left"
                    >
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="flex items-center gap-2 truncate text-sm">
                          <span
                            className={cn(
                              'h-1.5 w-1.5 shrink-0 rounded-full',
                              s.availability === 'available'
                                ? 'bg-foreground/60'
                                : 'bg-destructive/70'
                            )}
                          />
                          <span className="truncate font-medium group-hover:text-foreground">
                            {s.label}
                          </span>
                          <span className="shrink-0 text-xs text-muted-foreground/70">{s.kind}</span>
                        </span>
                        <span className="tnum shrink-0 text-xs text-muted-foreground">
                          {s.tileCount.toLocaleString()}
                        </span>
                      </div>
                      <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-foreground/50 transition-[width] group-hover:bg-foreground/70"
                          style={{ width: `${(s.tileCount / maxTiles) * 100}%` }}
                        />
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </section>

            <section className="space-y-3">
              <SectionHead title="Activity" hint={running.length ? `${running.length} running` : undefined} />
              {running.length > 0 && <IngestProgress jobs={jobs} />}
              {recent.length === 0 && running.length === 0 ? (
                <Empty>No recent jobs.</Empty>
              ) : (
                <div className="space-y-1">
                  {recent.map((j) => (
                    <div
                      key={j.id}
                      className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs"
                    >
                      <JobIcon state={j.state} />
                      <span className="truncate font-medium">{j.kind}</span>
                      <span className="truncate text-muted-foreground">{j.sourceId}</span>
                      <span className="tnum ml-auto shrink-0 text-muted-foreground">
                        {j.done.toLocaleString()} tiles
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>

          <section className="space-y-3">
            <SectionHead title="Labels" hint={`${labelled} tagged`} />
            {classes.length === 0 ? (
              <Empty>No label classes yet.</Empty>
            ) : (
              <div className="space-y-2.5">
                {classes.map((c) => {
                  const max = Math.max(1, ...classes.map((x) => x.count))
                  return (
                    <div key={c.name}>
                      <div className="flex items-baseline justify-between">
                        <span className="truncate text-sm font-medium">{c.name}</span>
                        <span className="tnum text-xs text-muted-foreground">{c.count}</span>
                      </div>
                      <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-foreground/45"
                          style={{ width: `${(c.count / max) * 100}%` }}
                        />
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}

function Metric({
  icon,
  label,
  value,
  mono
}: {
  icon?: ReactNode
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="flex items-center gap-1 text-[0.6875rem] uppercase tracking-wide text-muted-foreground">
        {icon}
        {label}
      </span>
      <span className={cn('text-sm text-foreground/90', mono ? 'font-mono' : 'tnum')}>{value}</span>
    </div>
  )
}

function SectionHead({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex items-baseline gap-2 border-b border-border pb-1.5">
      <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
      {hint && <span className="tnum text-xs text-muted-foreground">{hint}</span>}
    </div>
  )
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="text-sm text-muted-foreground/70">{children}</p>
}

function JobIcon({ state }: { state: Job['state'] }) {
  if (state === 'done') return <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-foreground/60" />
  if (state === 'error') return <XCircle className="h-3.5 w-3.5 shrink-0 text-destructive" />
  return <Ban className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
}

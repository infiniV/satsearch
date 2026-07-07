import { useCallback, useEffect, useRef, useState } from 'react'
import { Toaster, toast } from 'sonner'
import type { HealthStatus, Job, Result, Source } from '@shared/types'
import { HealthGate } from './components/HealthGate'
import { SearchBar } from './components/SearchBar'
import { ResultsGrid } from './components/ResultsGrid'
import { MapView } from './components/MapView'
import { SourcesDialog } from './components/SourcesDialog'
import { LabelPanel, useClasses } from './components/LabelPanel'
import { LayoutGrid, Map as MapIcon } from 'lucide-react'
import { Button } from './components/ui/button'
import { IngestProgress } from './components/IngestProgress'
import { StatsBar } from './components/StatsBar'
import { Badge } from './components/ui/badge'
import { Slider } from './components/ui/slider'

type Query =
  | { kind: 'text'; query: string }
  | { kind: 'image'; imageBytes: ArrayBuffer }
  | { kind: 'ref'; ref: { sourceId: string; name: string } }

export default function App(): React.JSX.Element {
  const [health, setHealth] = useState<HealthStatus | null>(null)
  const [healthError, setHealthError] = useState<string | null>(null)
  const [sources, setSources] = useState<Source[]>([])
  const [jobs, setJobs] = useState<Job[]>([])
  const [results, setResults] = useState<Result[]>([])
  const [total, setTotal] = useState<number | null>(null)
  const [belowWindow, setBelowWindow] = useState(false)
  const [refTile, setRefTile] = useState<{ sourceId: string; name: string } | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [scoreRange, setScoreRange] = useState<[number, number]>([0, 1])
  const [busy, setBusy] = useState(false)
  const [view, setView] = useState<'grid' | 'map'>('grid')
  const [activeClass, setActiveClass] = useState<string | null>(null)
  const [labelState, setLabelState] = useState<Record<string, string>>({})
  const { classes, refresh: refreshClasses } = useClasses()
  const lastQuery = useRef<Query | null>(null)
  const hasGeo = results.some((r) => r.lat != null && r.lon != null)

  // fetch label state (backend keys "sid\0name") -> grid keys "sid name"
  const refreshLabelState = useCallback(async (rows: Result[]) => {
    if (!rows.length) return setLabelState({})
    const keys = rows.map((r) => [r.sourceId, r.name] as [string, string])
    const raw = await window.api.labelState(keys)
    const mapped: Record<string, string> = {}
    for (const [k, v] of Object.entries(raw)) mapped[k.replace('\u0000', ' ')] = v
    setLabelState(mapped)
  }, [])

  async function onLabel(r: Result): Promise<void> {
    if (!activeClass) return
    await window.api.setLabel(r.sourceId, r.name, activeClass)
    setLabelState((s) => ({ ...s, [`${r.sourceId} ${r.name}`]: activeClass }))
    refreshClasses()
  }

  const refreshSources = useCallback(async () => {
    setSources(await window.api.listSources())
  }, [])

  useEffect(() => {
    window.api.health().then(setHealth).catch(() => {})
    const offReady = window.api.onHealthReady((h) => {
      setHealth(h)
      refreshSources()
    })
    const offErr = window.api.onHealthError(setHealthError)
    const offJobs = window.api.onJobs((snap) => setJobs(snap.jobs))
    const offSrc = window.api.onSourcesChanged(refreshSources)
    refreshSources().catch(() => {})
    return () => {
      offReady()
      offErr()
      offJobs()
      offSrc()
    }
  }, [refreshSources])

  const runSearch = useCallback(
    async (q: Query, range: [number, number], sel: Set<string>) => {
      lastQuery.current = q
      setBusy(true)
      try {
        const base = {
          sources: sel.size ? [...sel] : undefined,
          minScore: range[0] > 0 ? range[0] : undefined,
          maxScore: range[1] < 1 ? range[1] : undefined,
          limit: 200
        }
        const params =
          q.kind === 'text'
            ? { ...base, query: q.query }
            : q.kind === 'image'
              ? { ...base, imageBytes: q.imageBytes }
              : { ...base, ref: q.ref }
        const res = await window.api.search(params)
        setResults(res.results)
        setTotal(res.total)
        setBelowWindow(res.belowWindow)
        refreshLabelState(res.results)
      } catch (e) {
        toast.error(String(e))
      } finally {
        setBusy(false)
      }
    },
    [refreshLabelState]
  )

  function onSearch(opts: { query?: string; imageBytes?: ArrayBuffer }): void {
    setRefTile(null)
    const q: Query = opts.imageBytes
      ? { kind: 'image', imageBytes: opts.imageBytes }
      : { kind: 'text', query: opts.query ?? '' }
    runSearch(q, scoreRange, selected)
  }

  function onFindSimilar(r: Result): void {
    const ref = { sourceId: r.sourceId, name: r.name }
    setRefTile(ref)
    runSearch({ kind: 'ref', ref }, scoreRange, selected)
  }

  function reRun(range: [number, number], sel: Set<string>): void {
    if (lastQuery.current) runSearch(lastQuery.current, range, sel)
  }

  function toggleSource(id: string): void {
    const next = new Set(selected)
    next.has(id) ? next.delete(id) : next.add(id)
    setSelected(next)
    reRun(scoreRange, next)
  }

  return (
    <div className="flex h-screen flex-col">
      <HealthGate health={health} error={healthError} />
      <Toaster position="top-right" />

      <header className="flex items-center justify-between gap-3 border-b px-4 py-3">
        <h1 className="text-sm font-semibold tracking-tight">satsearch</h1>
        <div className="flex items-center gap-2">
          <LabelPanel
            classes={classes}
            activeClass={activeClass}
            onSetActive={setActiveClass}
            onClassesChanged={refreshClasses}
          />
          <SourcesDialog sources={sources} onChanged={refreshSources} />
        </div>
      </header>

      <div className="flex flex-1 flex-col gap-3 overflow-hidden p-4">
        <SearchBar onSearch={onSearch} refTile={refTile} onClearRef={() => setRefTile(null)} busy={busy} />
        <IngestProgress jobs={jobs} />

        <div className="flex flex-wrap items-center gap-2">
          {sources.map((s) => (
            <button key={s.id} onClick={() => toggleSource(s.id)}>
              <Badge
                className={selected.size && !selected.has(s.id) ? 'opacity-40' : ''}
              >
                {s.label}
              </Badge>
            </button>
          ))}
          <div className="ml-auto flex items-center gap-1 rounded-md border p-0.5">
            <Button
              size="icon"
              variant={view === 'grid' ? 'secondary' : 'ghost'}
              className="h-7 w-7"
              onClick={() => setView('grid')}
              title="Grid view"
            >
              <LayoutGrid className="h-4 w-4" />
            </Button>
            <Button
              size="icon"
              variant={view === 'map' ? 'secondary' : 'ghost'}
              className="h-7 w-7"
              onClick={() => setView('map')}
              disabled={!hasGeo}
              title={hasGeo ? 'Map view' : 'No geolocated results'}
            >
              <MapIcon className="h-4 w-4" />
            </Button>
          </div>
          <div className="flex w-64 items-center gap-2">
            <span className="text-xs text-[var(--muted-foreground)]">score</span>
            <Slider
              min={0}
              max={1}
              step={0.01}
              value={scoreRange}
              onValueChange={(v) => setScoreRange([v[0], v[1]] as [number, number])}
              onValueCommit={(v) => reRun([v[0], v[1]] as [number, number], selected)}
            />
            <span className="w-16 text-right text-xs tabular-nums text-[var(--muted-foreground)]">
              {scoreRange[0].toFixed(2)}–{scoreRange[1].toFixed(2)}
            </span>
          </div>
        </div>

        <div className="flex-1 overflow-hidden">
          {view === 'map' && hasGeo ? (
            <MapView results={results} onSelect={onFindSimilar} />
          ) : (
            <div className="h-full overflow-y-auto">
              <ResultsGrid
                results={results}
                belowWindow={belowWindow}
                onFindSimilar={onFindSimilar}
                activeClass={activeClass}
                labelState={labelState}
                onLabel={onLabel}
              />
            </div>
          )}
        </div>
      </div>

      <StatsBar health={health} sources={sources} total={total} />
    </div>
  )
}

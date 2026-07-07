import { type RefObject } from 'react'
import { LayoutGrid, Map as MapIcon, Loader2 } from 'lucide-react'
import type { DetailTile, Job, Source } from '@shared/types'
import { type SearchApi, SEARCH_PAGE } from '@/hooks/useSearch'
import { SearchBar } from '@/components/SearchBar'
import { ResultsGrid } from '@/components/ResultsGrid'
import { MapView } from '@/components/MapView'
import { IngestProgress } from '@/components/IngestProgress'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import { cn } from '@/lib/utils'

export function SearchView({
  search,
  sources,
  jobs,
  activeClass,
  onOpen,
  onLabel,
  searchInputRef
}: {
  search: SearchApi
  sources: Source[]
  jobs: Job[]
  activeClass: string | null
  onOpen: (t: DetailTile) => void
  onLabel: (t: DetailTile) => void
  searchInputRef: RefObject<HTMLInputElement | null>
}) {
  return (
    <div className="flex h-full flex-col gap-3 p-4">
      <SearchBar
        onSearch={search.search}
        refTile={search.refTile}
        onClearRef={search.clearRef}
        busy={search.busy}
        inputRef={searchInputRef}
      />
      <IngestProgress jobs={jobs} />

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {sources.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            {sources.map((s) => {
              const active = search.selected.has(s.id)
              const dimmed = search.selected.size > 0 && !active
              return (
                <button
                  key={s.id}
                  onClick={() => search.toggleSource(s.id)}
                  className={cn(
                    'rounded-md border px-2.5 py-1 text-xs font-medium transition-colors',
                    active
                      ? 'border-foreground/25 bg-accent text-foreground'
                      : dimmed
                        ? 'border-border text-muted-foreground/50 hover:text-muted-foreground'
                        : 'border-border-strong text-foreground/80 hover:bg-accent'
                  )}
                >
                  {s.label}
                </button>
              )
            })}
          </div>
        )}

        <div className="ml-auto flex items-center gap-3">
          <div className="flex items-center gap-0.5 rounded-md border border-border p-0.5">
            <Button
              size="icon-sm"
              variant={search.view === 'grid' ? 'secondary' : 'ghost'}
              onClick={() => search.setView('grid')}
              title="Grid view"
            >
              <LayoutGrid />
            </Button>
            <Button
              size="icon-sm"
              variant={search.view === 'map' ? 'secondary' : 'ghost'}
              onClick={() => search.setView('map')}
              disabled={!search.hasGeo}
              title={search.hasGeo ? 'Map view' : 'No geolocated results'}
            >
              <MapIcon />
            </Button>
          </div>

          <div className="flex w-60 items-center gap-2.5">
            <span className="text-[0.6875rem] uppercase tracking-wide text-muted-foreground">
              score
            </span>
            <Slider
              min={0}
              max={1}
              step={0.01}
              value={search.scoreRange}
              onValueChange={(v) => search.setScoreRange([v[0], v[1]] as [number, number])}
              onValueCommit={(v) => search.reRun([v[0], v[1]] as [number, number], search.selected)}
            />
            <span className="tnum w-[4.5rem] text-right text-xs text-muted-foreground">
              {search.scoreRange[0].toFixed(2)}–{search.scoreRange[1].toFixed(2)}
            </span>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {search.view === 'map' && search.hasGeo ? (
          <MapView results={search.results} onSelect={onOpen} />
        ) : (
          <div className="h-full overflow-y-auto pr-1">
            <ResultsGrid
              results={search.results}
              belowWindow={search.belowWindow}
              hasRun={search.hasRun}
              onOpen={onOpen}
              onFindSimilar={(t) => search.findSimilar(t)}
              activeClass={activeClass}
              labelState={search.labelState}
              onLabel={onLabel}
            />
            {search.hasMore && (
              <div className="flex justify-center py-4">
                <Button variant="outline" onClick={search.loadMore} disabled={search.loadingMore}>
                  {search.loadingMore && <Loader2 className="h-4 w-4 animate-spin" />}
                  Load {SEARCH_PAGE} more ({search.results.length.toLocaleString()} loaded)
                </Button>
              </div>
            )}
            {!search.hasMore &&
              search.searchDepthCap != null &&
              search.results.length >= search.searchDepthCap &&
              (search.total ?? 0) > search.results.length && (
                <p className="py-4 text-center text-xs text-muted-foreground">
                  Showing the top {search.searchDepthCap.toLocaleString()} matches — raise search
                  depth in Settings for more.
                </p>
              )}
          </div>
        )}
      </div>
    </div>
  )
}

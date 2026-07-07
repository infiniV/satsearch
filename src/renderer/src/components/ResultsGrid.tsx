import { TileCard } from './TileCard'
import type { DetailTile, Result } from '@shared/types'

export function ResultsGrid({
  results,
  belowWindow,
  hasRun,
  onOpen,
  onFindSimilar,
  activeClass,
  labelState,
  onLabel
}: {
  results: Result[]
  belowWindow: boolean
  hasRun: boolean
  onOpen: (t: DetailTile) => void
  onFindSimilar: (r: DetailTile) => void
  activeClass?: string | null
  labelState?: Record<string, string>
  onLabel?: (r: DetailTile) => void
}) {
  if (belowWindow) {
    return (
      <EmptyCanvas
        title="Nothing under that ceiling"
        subtitle="No matches fall below the current max score — raise the max or refine the query."
      />
    )
  }
  if (results.length === 0) {
    return hasRun ? (
      <EmptyCanvas
        title="No matches"
        subtitle="Nothing scored inside the current filters. Widen the score range, clear source filters, or try another description."
      />
    ) : (
      <EmptyCanvas
        title="Describe what you're looking for"
        subtitle="Semantic search runs over every embedded tile. Try “brick kiln”, “circular water tank”, or drop an image to search by similarity."
      />
    )
  }
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(164px,1fr))] gap-3">
      {results.map((r, i) => (
        <TileCard
          key={`${r.sourceId}/${r.name}`}
          tile={r}
          index={i}
          showScore
          label={labelState?.[`${r.sourceId} ${r.name}`]}
          activeClass={activeClass}
          onOpen={onOpen}
          onLabel={onLabel}
          onFindSimilar={onFindSimilar}
        />
      ))}
    </div>
  )
}

export function EmptyCanvas({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="canvas flex h-full items-center justify-center rounded-lg border border-border">
      <div className="max-w-sm space-y-2 px-6">
        <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
        <p className="text-sm leading-relaxed text-muted-foreground">{subtitle}</p>
      </div>
    </div>
  )
}

import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowDownAZ, ArrowUpZA, Loader2 } from 'lucide-react'
import type { DetailTile, GalleryTile, Source, TileSort } from '@shared/types'
import { TileCard } from '@/components/TileCard'
import { EmptyCanvas } from '@/components/ResultsGrid'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

const PAGE = 120

export function GalleryView({
  sources,
  activeClass,
  initialSource,
  onOpen,
  onFindSimilar,
  onLabel
}: {
  sources: Source[]
  activeClass: string | null
  initialSource?: string | null
  onOpen: (t: DetailTile) => void
  onFindSimilar: (t: DetailTile) => void
  onLabel: (t: DetailTile) => void
}) {
  const embedded = sources.filter((s) => s.tileCount > 0)
  const [sourceId, setSourceId] = useState<string | null>(
    initialSource && sources.some((s) => s.id === initialSource && s.tileCount > 0)
      ? initialSource
      : null
  )
  const [sort, setSort] = useState<TileSort>('name')
  const [tiles, setTiles] = useState<GalleryTile[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const doneRef = useRef(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)

  // default to the first embedded source; keep a valid selection as sources change
  useEffect(() => {
    if ((!sourceId || !embedded.some((s) => s.id === sourceId)) && embedded.length) {
      setSourceId(embedded[0].id)
    }
    if (!embedded.length) setSourceId(null)
  }, [embedded, sourceId])

  const loadPage = useCallback(
    async (sid: string, offset: number, srt: TileSort, replace: boolean) => {
      setLoading(true)
      try {
        const res = await window.api.browseTiles(sid, offset, PAGE, srt)
        setTotal(res.total)
        setTiles((prev) => (replace ? res.tiles : [...prev, ...res.tiles]))
        doneRef.current = offset + res.tiles.length >= res.total
      } finally {
        setLoading(false)
      }
    },
    []
  )

  // (re)load from the top whenever the source or sort changes
  useEffect(() => {
    if (!sourceId) {
      setTiles([])
      setTotal(0)
      return
    }
    doneRef.current = false
    setTiles([])
    loadPage(sourceId, 0, sort, true)
  }, [sourceId, sort, loadPage])

  // infinite scroll: load the next page when the sentinel enters the viewport
  useEffect(() => {
    const root = scrollRef.current
    const sentinel = sentinelRef.current
    if (!root || !sentinel || !sourceId) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && !loading && !doneRef.current) {
          loadPage(sourceId, tiles.length, sort, false)
        }
      },
      { root, rootMargin: '600px' }
    )
    io.observe(sentinel)
    return () => io.disconnect()
  }, [sourceId, sort, tiles.length, loading, loadPage])

  if (!embedded.length) {
    return (
      <div className="p-4">
        <EmptyCanvas
          title="No embedded sources yet"
          subtitle="Add a source and let it finish embedding — the whole corpus becomes browsable here."
        />
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 pb-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {embedded.map((s) => {
            const active = s.id === sourceId
            return (
              <button
                key={s.id}
                onClick={() => setSourceId(s.id)}
                className={cn(
                  'flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors',
                  active
                    ? 'border-foreground/25 bg-accent text-foreground'
                    : 'border-border-strong text-foreground/80 hover:bg-accent'
                )}
              >
                {s.label}
                <span className="tnum text-[0.625rem] text-muted-foreground">
                  {s.tileCount.toLocaleString()}
                </span>
              </button>
            )
          })}
        </div>

        <div className="ml-auto flex items-center gap-2">
          <span className="tnum text-xs text-muted-foreground">
            {tiles.length.toLocaleString()} / {total.toLocaleString()}
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setSort((s) => (s === 'name' ? 'name-desc' : 'name'))}
            title="Toggle sort order"
          >
            {sort === 'name' ? <ArrowDownAZ /> : <ArrowUpZA />}
            {sort === 'name' ? 'A–Z' : 'Z–A'}
          </Button>
        </div>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto pr-1">
        {tiles.length === 0 && !loading ? (
          <EmptyCanvas title="Empty source" subtitle="This source has no embedded tiles." />
        ) : (
          <>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3">
              {tiles.map((t, i) => (
                <TileCard
                  key={`${t.sourceId}/${t.name}`}
                  tile={t}
                  index={i % PAGE}
                  onOpen={onOpen}
                  onFindSimilar={onFindSimilar}
                  onLabel={onLabel}
                  activeClass={activeClass}
                />
              ))}
            </div>
            <div ref={sentinelRef} className="flex h-12 items-center justify-center">
              {loading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

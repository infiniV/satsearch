import { useEffect, useState } from 'react'
import {
  X,
  Sparkles,
  Tag,
  Copy,
  FolderOpen,
  ExternalLink,
  ImageOff,
  Loader2
} from 'lucide-react'
import { toast } from 'sonner'
import type { DetailTile, Result, Source, TileMeta } from '@shared/types'
import { Button } from './ui/button'
import { Badge } from './ui/badge'
import { cn } from '@/lib/utils'

export function DetailPanel({
  tile,
  sources,
  activeClass,
  onClose,
  onFindSimilar,
  onOpenTile,
  onLabel
}: {
  tile: DetailTile | null
  sources: Source[]
  activeClass: string | null
  onClose: () => void
  onFindSimilar: (t: DetailTile) => void
  onOpenTile: (t: DetailTile) => void
  onLabel: (t: DetailTile) => Promise<void> | void
}) {
  const [meta, setMeta] = useState<TileMeta | null>(null)
  const [label, setLabel] = useState<string | null>(null)
  const [neighbors, setNeighbors] = useState<Result[] | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!tile) return
    let live = true
    setMeta(null)
    setLabel(null)
    setNeighbors(null)
    setFailed(false)

    window.api.tileMeta(tile.thumbUrl).then((m) => live && setMeta(m)).catch(() => {})
    window.api
      .labelState([[tile.sourceId, tile.name]])
      .then((raw) => {
        if (!live) return
        const v = Object.values(raw)[0]
        setLabel(v ?? null)
      })
      .catch(() => {})
    window.api
      .search({ ref: { sourceId: tile.sourceId, name: tile.name }, limit: 12 })
      .then((res) => live && setNeighbors(res.results))
      .catch(() => live && setNeighbors([]))

    return () => {
      live = false
    }
  }, [tile])

  if (!tile) return null

  const source = sources.find((s) => s.id === tile.sourceId)
  const base = tile.name.split('/').pop() ?? tile.name

  async function copyPath(): Promise<void> {
    if (!meta) return
    await navigator.clipboard.writeText(meta.path)
    toast.success('Path copied')
  }

  async function tag(): Promise<void> {
    if (!activeClass || !tile) return
    await onLabel(tile)
    setLabel(activeClass)
  }

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <button
        type="button"
        aria-label="Close detail"
        onClick={onClose}
        className="absolute inset-0 bg-background/50 backdrop-blur-[1px] animate-in fade-in"
      />
      <aside className="relative flex h-full w-[420px] max-w-[92vw] flex-col border-l border-border-strong bg-popover shadow-lg animate-in slide-in-from-right-4 fade-in duration-200">
        <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium" title={tile.name}>
              {base}
            </p>
            <p className="truncate text-xs text-muted-foreground">{source?.label ?? tile.sourceId}</p>
          </div>
          <Button size="icon-sm" variant="ghost" onClick={onClose} title="Close (Esc)">
            <X />
          </Button>
        </header>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
          <div className="relative aspect-square w-full overflow-hidden rounded-lg border border-border bg-muted">
            {failed ? (
              <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-muted-foreground/70">
                <ImageOff className="h-6 w-6" />
                <span className="text-xs">preview unavailable</span>
              </div>
            ) : (
              <img
                src={tile.thumbUrl}
                alt={base}
                onError={() => setFailed(true)}
                className="h-full w-full object-contain"
              />
            )}
            {label && (
              <Badge variant="solid" className="absolute left-2 top-2 shadow-sm">
                <Tag className="h-3 w-3" />
                {label}
              </Badge>
            )}
          </div>

          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={() => onFindSimilar(tile)}>
              <Sparkles className="h-4 w-4" /> Find similar
            </Button>
            {activeClass && (
              <Button size="sm" variant="outline" onClick={tag}>
                <Tag className="h-4 w-4" /> Tag “{activeClass}”
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={copyPath} disabled={!meta}>
              <Copy className="h-4 w-4" /> Copy path
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => window.api.revealTile(tile.thumbUrl)}
              title="Show in file manager"
            >
              <FolderOpen className="h-4 w-4" /> Reveal
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => window.api.openTile(tile.thumbUrl)}
              title="Open in default viewer"
            >
              <ExternalLink className="h-4 w-4" /> Open
            </Button>
          </div>

          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
            {tile.score != null && <Row k="score" v={`${(tile.score * 100).toFixed(1)}%`} />}
            <Row k="source" v={source?.label ?? tile.sourceId} />
            {tile.z != null && <Row k="tile" v={`z${tile.z} · x${tile.x} · y${tile.y}`} />}
            {tile.lat != null && tile.lon != null && (
              <Row k="lat / lon" v={`${tile.lat.toFixed(5)}, ${tile.lon.toFixed(5)}`} />
            )}
            <Row
              k="dimensions"
              v={meta?.width ? `${meta.width} × ${meta.height} · ${meta.format ?? ''}` : '—'}
            />
            <Row k="size" v={meta ? formatBytes(meta.bytes) : '—'} />
            <Row k="modified" v={meta ? new Date(meta.mtime).toLocaleString() : '—'} />
          </dl>

          <div className="space-y-2">
            <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
              <Sparkles className="h-3.5 w-3.5" /> More like this
            </div>
            {neighbors == null ? (
              <div className="flex h-16 items-center justify-center">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
            ) : neighbors.length === 0 ? (
              <p className="text-xs text-muted-foreground/70">No neighbors found.</p>
            ) : (
              <div className="grid grid-cols-4 gap-1.5">
                {neighbors.map((n) => (
                  <button
                    key={`${n.sourceId}/${n.name}`}
                    onClick={() => onOpenTile(n)}
                    className={cn(
                      'aspect-square overflow-hidden rounded-md border border-border bg-muted outline-none',
                      'transition-colors hover:border-border-strong focus-visible:ring-2 focus-visible:ring-ring/60'
                    )}
                    title={n.name}
                  >
                    <img
                      src={n.thumbUrl}
                      alt={n.name}
                      loading="lazy"
                      className="h-full w-full object-cover"
                    />
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </aside>
    </div>
  )
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt className="text-muted-foreground">{k}</dt>
      <dd className="tnum truncate text-right font-mono text-foreground/90">{v}</dd>
    </>
  )
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

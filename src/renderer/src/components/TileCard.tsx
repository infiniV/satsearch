import { useState } from 'react'
import { Sparkles, Tag, ImageOff } from 'lucide-react'
import { Card } from './ui/card'
import { Button } from './ui/button'
import { Badge } from './ui/badge'
import type { DetailTile } from '@shared/types'

export interface TileCardProps {
  tile: DetailTile
  index?: number
  label?: string
  activeClass?: string | null
  showScore?: boolean
  onOpen: (t: DetailTile) => void
  onFindSimilar?: (t: DetailTile) => void
  onLabel?: (t: DetailTile) => void
}

/** One tile in a grid — search result or browsed corpus tile. Clicking the image
 *  opens the detail slide-over; hover surfaces the filename and per-tile actions. */
export function TileCard({
  tile,
  index = 0,
  label,
  activeClass,
  showScore = false,
  onOpen,
  onFindSimilar,
  onLabel
}: TileCardProps) {
  const [failed, setFailed] = useState(false)
  const base = tile.name.split('/').pop() ?? tile.name

  return (
    <Card
      className="group relative overflow-hidden border-border transition-colors hover:border-border-strong animate-rise"
      style={{ animationDelay: `${Math.min(index, 24) * 18}ms` }}
    >
      <button
        type="button"
        onClick={() => onOpen(tile)}
        className="relative block aspect-square w-full bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        title={tile.name}
      >
        {failed ? (
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-2 text-center text-muted-foreground/70">
            <ImageOff className="h-5 w-5" />
            <span className="line-clamp-2 break-all text-[0.6875rem] leading-tight">{base}</span>
          </div>
        ) : (
          <img
            src={tile.thumbUrl}
            alt={base}
            loading="lazy"
            onError={() => setFailed(true)}
            className="h-full w-full object-cover"
          />
        )}

        {label && (
          <Badge variant="solid" className="absolute left-2 top-2 shadow-sm">
            <Tag className="h-3 w-3" />
            {label}
          </Badge>
        )}

        <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent p-2 pt-6 opacity-0 transition-opacity group-hover:opacity-100">
          <p className="truncate text-left text-[0.6875rem] font-medium text-white/90">{base}</p>
        </div>
      </button>

      <div className="flex items-center justify-between gap-2 px-2.5 py-2">
        {showScore && tile.score != null ? (
          <span className="tnum text-xs text-muted-foreground">
            {(Math.round(tile.score * 1000) / 10).toFixed(1)}%
          </span>
        ) : (
          <span className="truncate font-mono text-[0.6875rem] text-muted-foreground/70">
            {tile.z != null ? `z${tile.z} · ${tile.x}/${tile.y}` : base}
          </span>
        )}
        <div className="flex items-center opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          {activeClass && onLabel && (
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={() => onLabel(tile)}
              title={`Tag as “${activeClass}”`}
            >
              <Tag />
            </Button>
          )}
          {onFindSimilar && (
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={() => onFindSimilar(tile)}
              title="Find similar tiles"
            >
              <Sparkles />
            </Button>
          )}
        </div>
      </div>
    </Card>
  )
}

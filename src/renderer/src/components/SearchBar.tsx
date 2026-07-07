import { useRef, useState, type RefObject } from 'react'
import { Search, ImageIcon, X, Sparkles } from 'lucide-react'
import { Input } from './ui/input'
import { Button } from './ui/button'

export function SearchBar({
  onSearch,
  refTile,
  onClearRef,
  busy,
  inputRef
}: {
  onSearch: (opts: { query?: string; imageBytes?: ArrayBuffer }) => void
  refTile: { sourceId: string; name: string } | null
  onClearRef: () => void
  busy: boolean
  inputRef?: RefObject<HTMLInputElement | null>
}) {
  const [text, setText] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)

  async function handleFile(file: File): Promise<void> {
    const buf = await file.arrayBuffer()
    onSearch({ imageBytes: buf })
  }

  return (
    <div
      className={`relative flex items-center gap-2 rounded-lg border bg-card px-2.5 py-2 shadow-xs transition-[border-color,box-shadow] focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30 ${
        dragging ? 'border-foreground/40 ring-2 ring-foreground/10' : 'border-border'
      }`}
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        const f = e.dataTransfer.files[0]
        if (f) handleFile(f)
      }}
    >
      <Search className="ml-1 h-4 w-4 shrink-0 text-muted-foreground" />

      <Input
        ref={inputRef}
        placeholder="Describe a tile — “brick kiln”, “circular water tank”, “solar farm”…"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && text.trim()) onSearch({ query: text.trim() })
        }}
        className="h-8 border-0 bg-transparent px-1 text-sm shadow-none focus-visible:ring-0"
      />

      {refTile && (
        <span className="flex shrink-0 items-center gap-1.5 rounded-md border border-border-strong bg-secondary py-1 pl-2 pr-1 text-xs font-medium text-secondary-foreground">
          <Sparkles className="h-3 w-3 text-muted-foreground" />
          <span className="max-w-[10rem] truncate">{refTile.name.split('/').pop()}</span>
          <button
            onClick={onClearRef}
            className="rounded-sm p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title="Clear reference"
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      )}

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) handleFile(f)
        }}
      />

      <Button
        variant="outline"
        size="icon"
        className="h-8 w-8 shrink-0"
        title="Search by image"
        onClick={() => fileRef.current?.click()}
      >
        <ImageIcon className="h-4 w-4" />
      </Button>

      <Button
        className="h-8 shrink-0"
        disabled={busy || !text.trim()}
        onClick={() => text.trim() && onSearch({ query: text.trim() })}
      >
        Search
        <kbd className="kbd ml-0.5 border-primary-foreground/20 bg-primary-foreground/10 text-primary-foreground/80">
          ↵
        </kbd>
      </Button>

      {dragging && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-lg bg-background/85 text-sm font-medium text-foreground">
          Drop an image to search by similarity
        </div>
      )}
    </div>
  )
}

import { useRef, useState } from 'react'
import { Search, ImageIcon, X } from 'lucide-react'
import { Input } from './ui/input'
import { Button } from './ui/button'
import { Badge } from './ui/badge'

export function SearchBar({
  onSearch,
  refTile,
  onClearRef,
  busy
}: {
  onSearch: (opts: { query?: string; imageBytes?: ArrayBuffer }) => void
  refTile: { sourceId: string; name: string } | null
  onClearRef: () => void
  busy: boolean
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
      className={`flex items-center gap-2 rounded-lg border p-2 ${dragging ? 'ring-2 ring-[var(--ring)]' : ''}`}
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
      <Search className="ml-1 h-4 w-4 text-[var(--muted-foreground)]" />
      <Input
        placeholder="Search tiles — e.g. “brick kiln”, “circular water tank”…"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && text.trim()) onSearch({ query: text.trim() })
        }}
        className="border-0 shadow-none focus-visible:ring-0"
      />
      {refTile && (
        <Badge className="gap-1">
          find similar: {refTile.name}
          <button onClick={onClearRef}>
            <X className="h-3 w-3" />
          </button>
        </Badge>
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
      <Button variant="outline" size="icon" title="Search by image" onClick={() => fileRef.current?.click()}>
        <ImageIcon className="h-4 w-4" />
      </Button>
      <Button disabled={busy || !text.trim()} onClick={() => text.trim() && onSearch({ query: text.trim() })}>
        Search
      </Button>
    </div>
  )
}

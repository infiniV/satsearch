import { useState } from 'react'
import { FolderPlus, Trash2, Download, Layers, Link2 } from 'lucide-react'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogTrigger } from './ui/dialog'
import { Button } from './ui/button'
import { Badge } from './ui/badge'
import type { Source } from '@shared/types'

export function SourcesDialog({
  sources,
  onChanged
}: {
  sources: Source[]
  onChanged: () => void
}) {
  const [busy, setBusy] = useState(false)

  async function addFolder(): Promise<void> {
    setBusy(true)
    try {
      await window.api.pickAndAddSource()
      onChanged()
    } finally {
      setBusy(false)
    }
  }

  async function importSatimg(): Promise<void> {
    setBusy(true)
    try {
      await window.api.importSatimg('google/siglip2-so400m-patch16-256')
      onChanged()
    } finally {
      setBusy(false)
    }
  }

  async function del(id: string): Promise<void> {
    await window.api.deleteSource(id)
    onChanged()
  }

  async function relink(id: string): Promise<void> {
    const r = await window.api.relinkSource(id)
    if (r) {
      toast.success('Source relinked')
      onChanged()
    }
  }

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Layers className="h-4 w-4" /> Sources ({sources.length})
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Sources</DialogTitle>
          <DialogDescription>
            Add an XYZ tile pyramid or a plain image folder, or import a satImg city (embeds its images if they aren't already embedded).
          </DialogDescription>
        </DialogHeader>
        <div className="flex gap-2">
          <Button onClick={addFolder} disabled={busy}>
            <FolderPlus className="h-4 w-4" /> Add folder
          </Button>
          <Button variant="secondary" onClick={importSatimg} disabled={busy}>
            <Download className="h-4 w-4" /> Import satImg city…
          </Button>
        </div>
        <div className="mt-2 max-h-72 space-y-2 overflow-y-auto">
          {sources.length === 0 && (
            <p className="text-sm text-[var(--muted-foreground)]">No sources yet.</p>
          )}
          {sources.map((s) => (
            <div key={s.id} className="flex items-center justify-between rounded-md border p-2">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{s.label}</div>
                <div className="flex items-center gap-1.5 text-xs text-[var(--muted-foreground)]">
                  <Badge>{s.kind}</Badge>
                  <span>{s.tileCount.toLocaleString()} tiles</span>
                  {s.availability !== 'available' && <Badge>{s.availability}</Badge>}
                </div>
              </div>
              <div className="flex">
                {s.availability === 'unavailable' && (
                  <Button variant="ghost" size="icon" onClick={() => relink(s.id)} title="Relink moved folder">
                    <Link2 className="h-4 w-4" />
                  </Button>
                )}
                <Button variant="ghost" size="icon" onClick={() => del(s.id)} title="Delete">
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}

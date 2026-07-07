import { useState } from 'react'
import { FolderPlus, Trash2, Download, Layers, Link2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger
} from './ui/dialog'
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
          <Layers className="h-4 w-4" /> Sources
          <span className="tnum rounded bg-muted px-1 text-[0.6875rem] text-muted-foreground">
            {sources.length}
          </span>
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Sources</DialogTitle>
          <DialogDescription>
            Add an XYZ tile pyramid or a plain image folder, or import a satImg city — it embeds
            images that aren’t already embedded.
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-2">
          <Button onClick={addFolder} disabled={busy} className="flex-1">
            <FolderPlus className="h-4 w-4" /> Add folder
          </Button>
          <Button variant="secondary" onClick={importSatimg} disabled={busy} className="flex-1">
            <Download className="h-4 w-4" /> Import satImg city
          </Button>
        </div>

        <div className="-mx-1 max-h-72 space-y-1.5 overflow-y-auto px-1">
          {sources.length === 0 && (
            <div className="rounded-md border border-dashed border-border-strong px-4 py-8 text-center text-sm text-muted-foreground">
              No sources yet — add a folder to begin.
            </div>
          )}
          {sources.map((s) => (
            <div
              key={s.id}
              className="flex items-center justify-between gap-2 rounded-md border border-border bg-card px-3 py-2.5 transition-colors hover:border-border-strong"
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{s.label}</div>
                <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Badge variant="outline">{s.kind}</Badge>
                  <span className="tnum">{s.tileCount.toLocaleString()} tiles</span>
                  {s.availability !== 'available' && (
                    <Badge variant="outline" className="border-destructive/40 text-destructive">
                      {s.availability}
                    </Badge>
                  )}
                </div>
              </div>
              <div className="flex shrink-0 items-center">
                {s.availability === 'unavailable' && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => relink(s.id)}
                    title="Relink moved folder"
                  >
                    <Link2 />
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => del(s.id)}
                  title="Delete source"
                >
                  <Trash2 />
                </Button>
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}

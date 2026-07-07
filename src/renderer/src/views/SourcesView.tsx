import { useRef, useState } from 'react'
import { FolderPlus, Trash2, Download, Link2, RefreshCw, Images } from 'lucide-react'
import { toast } from 'sonner'
import type { ImportPreview, Source } from '@shared/types'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ImportPreviewDialog } from '@/components/ImportPreviewDialog'

export function SourcesView({
  sources,
  onChanged,
  onBrowse
}: {
  sources: Source[]
  onChanged: () => void
  onBrowse: (sourceId: string) => void
}) {
  const [busy, setBusy] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [scanning, setScanning] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const tokenRef = useRef<string | null>(null)

  // Pick → scan → confirm. The picked path lives in the main process, keyed by token;
  // cancelling releases it, confirming consumes it and starts the embed job.
  async function beginImport(mode: 'folder' | 'satimg'): Promise<void> {
    setBusy(true)
    try {
      const picked = await window.api.pickSource(mode)
      if (!picked) return
      tokenRef.current = picked.token
      setPreview(null)
      setScanning(true)
      setImportOpen(true)
      try {
        setPreview(await window.api.scanSource(picked.token))
      } catch {
        toast.error('Could not read that folder')
        void closeImport()
      } finally {
        setScanning(false)
      }
    } finally {
      setBusy(false)
    }
  }

  async function closeImport(): Promise<void> {
    const t = tokenRef.current
    tokenRef.current = null
    setImportOpen(false)
    setPreview(null)
    if (t) await window.api.cancelPick(t).catch(() => {})
  }

  async function confirmImport(): Promise<void> {
    const t = tokenRef.current
    if (!t) return
    setConfirming(true)
    try {
      const r = await window.api.confirmAddSource(t)
      tokenRef.current = null
      setImportOpen(false)
      setPreview(null)
      toast.success(
        r.kind === 'satimg' ? 'satImg import started' : 'Source added — embedding started'
      )
      onChanged()
    } catch {
      toast.error('Import failed')
    } finally {
      setConfirming(false)
    }
  }

  async function del(s: Source): Promise<void> {
    await window.api.deleteSource(s.id)
    toast.success(`Removed “${s.label}”`)
    onChanged()
  }

  async function relink(id: string): Promise<void> {
    const r = await window.api.relinkSource(id)
    if (r) {
      toast.success('Source relinked')
      onChanged()
    }
  }

  async function reembed(id: string): Promise<void> {
    await window.api.reembedSource(id)
    toast.success('Re-embed started')
    onChanged()
  }

  return (
    <div className="mx-auto flex h-full w-full max-w-4xl flex-col gap-6 overflow-y-auto p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-lg font-semibold tracking-tight">Sources</h1>
          <p className="text-sm text-muted-foreground">
            Add an XYZ tile pyramid or a plain image folder, or import a satImg city — it embeds
            imagery that isn’t already embedded.
          </p>
        </div>
        <div className="flex gap-2">
          <Button onClick={() => beginImport('folder')} disabled={busy}>
            <FolderPlus className="h-4 w-4" /> Add folder
          </Button>
          <Button variant="secondary" onClick={() => beginImport('satimg')} disabled={busy}>
            <Download className="h-4 w-4" /> Import satImg
          </Button>
        </div>
      </header>

      {sources.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border-strong px-4 py-16 text-center text-sm text-muted-foreground">
          No sources yet — add a folder to begin.
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {sources.map((s) => (
            <div
              key={s.id}
              className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card px-4 py-3 transition-colors hover:border-border-strong"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">{s.label}</span>
                  <Badge variant="outline">{s.kind}</Badge>
                  {s.availability !== 'available' && (
                    <Badge variant="outline" className="border-destructive/40 text-destructive">
                      {s.availability}
                    </Badge>
                  )}
                </div>
                <div className="mt-1 flex items-center gap-3 font-mono text-[0.6875rem] text-muted-foreground">
                  <span className="tnum">{s.tileCount.toLocaleString()} tiles</span>
                  {s.hasGeo && s.minZoom != null && (
                    <span className="tnum">
                      z{s.minZoom}–{s.maxZoom}
                    </span>
                  )}
                  <span className="truncate">{s.rootPath}</span>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-0.5">
                {s.tileCount > 0 && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => onBrowse(s.id)}
                    title="Browse in Gallery"
                  >
                    <Images />
                  </Button>
                )}
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
                  onClick={() => reembed(s.id)}
                  title="Re-embed with the active model"
                  disabled={s.availability !== 'available'}
                >
                  <RefreshCw />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => del(s)}
                  title="Delete source"
                >
                  <Trash2 />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <ImportPreviewDialog
        open={importOpen}
        onOpenChange={(o) => {
          if (!o) void closeImport()
        }}
        preview={preview}
        scanning={scanning}
        confirming={confirming}
        onConfirm={confirmImport}
      />
    </div>
  )
}

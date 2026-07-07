import { Clock, HardDrive, Images, Layers, Loader2 } from 'lucide-react'
import type { ImportPreview } from '@shared/types'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'

const KIND_LABEL: Record<ImportPreview['kind'], string> = {
  xyz: 'XYZ pyramid',
  plain: 'Image folder',
  'satimg-import': 'satImg city'
}

function formatBytes(n: number): string {
  if (n <= 0) return '0 B'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function formatDuration(secs: number | null): string {
  if (secs == null) return '—'
  if (secs < 1) return '<1 s'
  if (secs < 60) return `${Math.round(secs)} s`
  const m = Math.round(secs / 60)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  return `${h} h ${m % 60} min`
}

function Stat({
  icon,
  label,
  value,
  hint
}: {
  icon: React.ReactNode
  label: string
  value: string
  hint?: string
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-0.5 rounded-md border border-border bg-card px-3 py-2">
      <div className="flex items-center gap-1.5 text-[0.625rem] font-medium uppercase tracking-wide text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className="tnum font-mono text-sm font-semibold leading-tight">{value}</div>
      {hint && <div className="text-[0.625rem] leading-tight text-muted-foreground">{hint}</div>}
    </div>
  )
}

function Structure({ p }: { p: ImportPreview }): React.JSX.Element | null {
  if (p.zoomBreakdown?.length) {
    return (
      <Section icon={<Layers className="h-3.5 w-3.5" />} title="Zoom levels">
        <div className="max-h-40 overflow-y-auto">
          {p.zoomBreakdown.map((z) => (
            <div
              key={z.zoom}
              className={cn(
                'flex items-center justify-between gap-2 rounded px-2 py-1 font-mono text-xs',
                z.embeds ? 'bg-signal/10 text-signal' : 'text-muted-foreground'
              )}
            >
              <span className="flex items-center gap-2">
                <span className="tnum w-8 text-foreground/80">z{z.zoom}</span>
                {z.embeds && (
                  <Badge variant="signal" className="px-1.5 py-0 text-[0.5625rem]">
                    embeds
                  </Badge>
                )}
              </span>
              <span className="tnum">{z.count.toLocaleString()}</span>
            </div>
          ))}
        </div>
      </Section>
    )
  }
  if (p.subfolders?.length) {
    const multi = p.subfolders.length > 1 || p.subfolders[0]?.name !== '.'
    if (!multi) return null
    return (
      <Section icon={<Layers className="h-3.5 w-3.5" />} title={`${p.subfolders.length} subfolders`}>
        <div className="max-h-40 overflow-y-auto">
          {p.subfolders.map((s) => (
            <div
              key={s.name}
              className="flex items-center justify-between gap-2 rounded px-2 py-1 font-mono text-xs text-muted-foreground"
            >
              <span className="truncate text-foreground/80">{s.name === '.' ? '(root)' : s.name}</span>
              <span className="tnum shrink-0">{s.count.toLocaleString()}</span>
            </div>
          ))}
        </div>
      </Section>
    )
  }
  return null
}

function Section({
  icon,
  title,
  children
}: {
  icon: React.ReactNode
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="rounded-md border border-border">
      <div className="flex items-center gap-1.5 border-b border-border px-2.5 py-1.5 text-[0.625rem] font-medium uppercase tracking-wide text-muted-foreground">
        {icon}
        {title}
      </div>
      <div className="p-1">{children}</div>
    </div>
  )
}

export function ImportPreviewDialog({
  open,
  onOpenChange,
  preview,
  scanning,
  confirming,
  onConfirm
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  preview: ImportPreview | null
  scanning: boolean
  confirming: boolean
  onConfirm: () => void
}): React.JSX.Element {
  const empty = !!preview && preview.imageCount === 0
  const estHint =
    preview?.estBasis === 'heuristic'
      ? 'rough — sharpens after this run'
      : preview?.estBasis === 'measured'
        ? 'from your last run'
        : undefined

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-4 p-5 sm:max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-2 pr-6">
            <DialogTitle className="truncate">
              {scanning || !preview ? 'Scanning folder…' : preview.folderName}
            </DialogTitle>
            {preview && (
              <Badge variant="outline" className="shrink-0">
                {KIND_LABEL[preview.kind]}
              </Badge>
            )}
          </div>
          <DialogDescription className="truncate font-mono text-[0.6875rem]">
            {preview?.rootPath ?? 'Reading the folder structure…'}
          </DialogDescription>
        </DialogHeader>

        {scanning || !preview ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Counting images…
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-3 gap-2">
              <Stat
                icon={<Images className="h-3 w-3" />}
                label="Images"
                value={preview.imageCount.toLocaleString()}
              />
              <Stat
                icon={<HardDrive className="h-3 w-3" />}
                label="Size"
                value={formatBytes(preview.totalBytes)}
                hint={preview.approxBytes ? 'approx.' : undefined}
              />
              <Stat
                icon={<Clock className="h-3 w-3" />}
                label="Est. time"
                value={preview.estSeconds ? `~${formatDuration(preview.estSeconds)}` : '—'}
                hint={estHint}
              />
            </div>

            <Structure p={preview} />

            {preview.kind === 'satimg-import' && (
              <p className="text-[0.6875rem] leading-relaxed text-muted-foreground">
                Tiles already embedded by another source are skipped, so the final count may be
                lower.
              </p>
            )}
            {empty && (
              <p className="text-[0.6875rem] leading-relaxed text-destructive">
                No embeddable images found in this folder.
              </p>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={confirming}>
            Cancel
          </Button>
          <Button size="sm" onClick={onConfirm} disabled={scanning || !preview || empty || confirming}>
            {confirming && <Loader2 className="h-4 w-4 animate-spin" />}
            {preview && !scanning
              ? `Import ${preview.imageCount.toLocaleString()} images`
              : 'Import'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

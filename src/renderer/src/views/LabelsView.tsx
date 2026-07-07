import { useState } from 'react'
import { Tag, Download, Check } from 'lucide-react'
import { toast } from 'sonner'
import type { LabelClass } from '@/hooks/useClasses'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

export function LabelsView({
  classes,
  activeClass,
  onSetActive,
  onClassesChanged
}: {
  classes: LabelClass[]
  activeClass: string | null
  onSetActive: (name: string | null) => void
  onClassesChanged: () => void
}) {
  const [newName, setNewName] = useState('')
  const total = classes.reduce((a, c) => a + c.count, 0)

  async function add(): Promise<void> {
    if (!newName.trim()) return
    await window.api.addClass(newName.trim())
    setNewName('')
    onClassesChanged()
  }

  async function doExport(): Promise<void> {
    const r = await window.api.exportLabels()
    toast.success(`Exported ${r.count} tiles → ${r.dest}`)
  }

  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col gap-6 overflow-y-auto p-6">
      <header className="space-y-1">
        <h1 className="text-lg font-semibold tracking-tight">Labels &amp; gold-set</h1>
        <p className="text-sm text-muted-foreground">
          Pick an active class, then tag tiles from Search, Gallery, or the detail panel. Export
          builds a per-class dataset on disk. {total.toLocaleString()} tiles tagged across{' '}
          {classes.length} {classes.length === 1 ? 'class' : 'classes'}.
        </p>
      </header>

      <div className="flex max-w-md gap-2">
        <Input
          placeholder="New class name…"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
        />
        <Button onClick={add} disabled={!newName.trim()}>
          Add class
        </Button>
      </div>

      {activeClass ? (
        <p className="text-xs text-muted-foreground">
          Tagging is <span className="font-medium text-foreground">on</span> — new tags apply{' '}
          <span className="font-medium text-foreground">“{activeClass}”</span>. Click it again to
          stop.
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          Select a class below to start tagging tiles with it.
        </p>
      )}

      <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-2">
        {classes.length === 0 && (
          <p className="text-sm text-muted-foreground">No classes yet — add one above.</p>
        )}
        {classes.map((c) => {
          const active = activeClass === c.name
          return (
            <button
              key={c.name}
              onClick={() => onSetActive(active ? null : c.name)}
              className={cn(
                'flex items-center justify-between gap-2 rounded-md border px-3 py-2.5 text-left text-sm transition-colors',
                active
                  ? 'border-foreground/30 bg-accent text-foreground'
                  : 'border-border bg-card text-foreground/80 hover:border-border-strong hover:bg-accent/60'
              )}
            >
              <span className="flex min-w-0 items-center gap-2">
                {active ? (
                  <Check className="h-3.5 w-3.5 shrink-0" />
                ) : (
                  <Tag className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                )}
                <span className="truncate font-medium">{c.name}</span>
              </span>
              <span
                className={cn(
                  'tnum shrink-0 rounded px-1.5 text-[0.6875rem]',
                  active ? 'bg-foreground/15 text-foreground' : 'bg-muted text-muted-foreground'
                )}
              >
                {c.count}
              </span>
            </button>
          )
        })}
      </div>

      <Button variant="secondary" className="w-fit" onClick={doExport} disabled={classes.length === 0}>
        <Download className="h-4 w-4" /> Export gold-set
      </Button>
    </div>
  )
}

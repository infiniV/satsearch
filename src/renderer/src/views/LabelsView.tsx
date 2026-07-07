import { useState } from 'react'
import { Tag, Download, Check, Trash2 } from 'lucide-react'
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

  async function remove(c: LabelClass): Promise<void> {
    // The sidecar rejects deleting a class that still has tagged tiles (409).
    if (c.count > 0) {
      toast.error(`“${c.name}” still has ${c.count} tagged ${c.count === 1 ? 'tile' : 'tiles'} — untag them first`)
      return
    }
    try {
      await window.api.deleteClass(c.name)
      if (activeClass === c.name) onSetActive(null)
      onClassesChanged()
      toast.success(`Deleted “${c.name}”`)
    } catch {
      toast.error(`Couldn't delete “${c.name}”`)
    }
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
            <div
              key={c.name}
              className={cn(
                'group flex items-center gap-1 rounded-md border pr-1 text-sm transition-colors',
                active
                  ? 'border-foreground/30 bg-accent'
                  : 'border-border bg-card hover:border-border-strong hover:bg-accent/60'
              )}
            >
              <button
                onClick={() => onSetActive(active ? null : c.name)}
                className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2.5 text-left"
                title={active ? `Stop tagging with “${c.name}”` : `Tag with “${c.name}”`}
              >
                {active ? (
                  <Check className="h-3.5 w-3.5 shrink-0" />
                ) : (
                  <Tag className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                )}
                <span className="truncate font-medium text-foreground/90">{c.name}</span>
              </button>
              <span
                className={cn(
                  'tnum shrink-0 rounded px-1.5 text-[0.6875rem]',
                  active ? 'bg-foreground/15 text-foreground' : 'bg-muted text-muted-foreground'
                )}
              >
                {c.count}
              </span>
              <button
                onClick={() => remove(c)}
                aria-label={`Delete class “${c.name}”`}
                title={c.count > 0 ? 'Untag its tiles first' : `Delete “${c.name}”`}
                className="shrink-0 rounded p-1.5 text-muted-foreground/50 transition-colors hover:bg-destructive/15 hover:text-destructive"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          )
        })}
      </div>

      <Button variant="secondary" className="w-fit" onClick={doExport} disabled={classes.length === 0}>
        <Download className="h-4 w-4" /> Export gold-set
      </Button>
    </div>
  )
}

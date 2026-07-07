import { useEffect, useState } from 'react'
import { Tag, Download } from 'lucide-react'
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
import { Input } from './ui/input'
import { cn } from '@/lib/utils'

export function LabelPanel({
  classes,
  activeClass,
  onSetActive,
  onClassesChanged
}: {
  classes: { name: string; count: number }[]
  activeClass: string | null
  onSetActive: (name: string | null) => void
  onClassesChanged: () => void
}) {
  const [newName, setNewName] = useState('')

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
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Tag className="h-4 w-4" /> Labels
          {activeClass && <span className="h-1.5 w-1.5 rounded-full bg-foreground/70" />}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Labels &amp; gold-set</DialogTitle>
          <DialogDescription>
            Pick an active class, then tag results in the grid. Export builds a per-class dataset.
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-2">
          <Input
            placeholder="New class name…"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && add()}
          />
          <Button onClick={add} disabled={!newName.trim()}>
            Add
          </Button>
        </div>

        <div className="flex flex-wrap gap-2">
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
                  'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors',
                  active
                    ? 'border-foreground/30 bg-accent text-foreground'
                    : 'border-border-strong text-foreground/80 hover:bg-accent'
                )}
              >
                {c.name}
                <span
                  className={cn(
                    'tnum rounded px-1 text-[0.625rem]',
                    active ? 'bg-foreground/15 text-foreground' : 'bg-muted text-muted-foreground'
                  )}
                >
                  {c.count}
                </span>
              </button>
            )
          })}
        </div>

        <Button variant="secondary" onClick={doExport} disabled={classes.length === 0}>
          <Download className="h-4 w-4" /> Export gold-set
        </Button>
      </DialogContent>
    </Dialog>
  )
}

export function useClasses(): {
  classes: { name: string; count: number }[]
  refresh: () => void
} {
  const [classes, setClasses] = useState<{ name: string; count: number }[]>([])
  const refresh = (): void => {
    window.api.getClasses().then(setClasses).catch(() => {})
  }
  useEffect(refresh, [])
  return { classes, refresh }
}

import { useEffect, useState } from 'react'
import { Tag, Download } from 'lucide-react'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogTrigger } from './ui/dialog'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Badge } from './ui/badge'

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
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Labels & gold-set</DialogTitle>
          <DialogDescription>
            Pick an active class, then tag results in the grid. Export builds a per-class dataset.
          </DialogDescription>
        </DialogHeader>
        <div className="flex gap-2">
          <Input
            placeholder="New class…"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && add()}
          />
          <Button onClick={add}>Add</Button>
        </div>
        <div className="flex flex-wrap gap-2">
          {classes.length === 0 && <p className="text-sm text-[var(--muted-foreground)]">No classes yet.</p>}
          {classes.map((c) => (
            <button key={c.name} onClick={() => onSetActive(activeClass === c.name ? null : c.name)}>
              <Badge className={activeClass === c.name ? 'ring-2 ring-[var(--ring)]' : ''}>
                {c.name} · {c.count}
              </Badge>
            </button>
          ))}
        </div>
        <Button variant="secondary" onClick={doExport}>
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

import { X } from 'lucide-react'
import { Progress } from './ui/progress'
import { Button } from './ui/button'
import type { Job } from '@shared/types'

export function IngestProgress({ jobs }: { jobs: Job[] }) {
  const active = jobs.filter((j) => j.state === 'running')
  if (active.length === 0) return null
  return (
    <div className="space-y-2 rounded-lg border p-3">
      {active.map((j) => (
        <div key={j.id} className="space-y-1">
          <div className="flex items-center justify-between text-xs">
            <span>
              {j.kind === 'import' ? 'Importing' : 'Embedding'} {j.sourceId}
              {j.resumed ? ' (resumed)' : ''}
            </span>
            <div className="flex items-center gap-2">
              <span className="tabular-nums text-[var(--muted-foreground)]">
                {j.done.toLocaleString()} / {j.total.toLocaleString()}
              </span>
              <Button
                size="icon"
                variant="ghost"
                className="h-6 w-6"
                onClick={() => window.api.cancelJob(j.id)}
                title="Cancel"
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
          <Progress value={j.total ? (j.done / j.total) * 100 : 0} />
        </div>
      ))}
    </div>
  )
}

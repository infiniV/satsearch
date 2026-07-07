import { useState } from 'react'
import { X } from 'lucide-react'
import { Progress } from './ui/progress'
import { Button } from './ui/button'
import { Mark } from './Mark'
import type { Job } from '@shared/types'

/** Mirror the sidecar's `app://thumb/<sourceId>/<quote(rel_path)>` encoding. */
function thumbUrl(sourceId: string, rel: string): string {
  const encoded = rel.split('/').map(encodeURIComponent).join('/')
  return `app://thumb/${encodeURIComponent(sourceId)}/${encoded}`
}

export function IngestProgress({ jobs }: { jobs: Job[] }) {
  const active = jobs.filter((j) => j.state === 'running')
  if (active.length === 0) return null
  return (
    <div className="space-y-3 rounded-lg border border-border bg-card p-3">
      {active.map((j) => (
        <IngestRow key={j.id} job={j} />
      ))}
    </div>
  )
}

function IngestRow({ job }: { job: Job }) {
  const pct = job.total ? (job.done / job.total) * 100 : 0
  const verb = job.kind === 'import' ? 'Importing' : 'Embedding'
  const current = job.current?.split('/').pop()

  return (
    <div className="flex items-center gap-3">
      <LivePreview sourceId={job.sourceId} rel={job.current} />

      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex items-center gap-2">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-signal" />
          <span className="truncate text-sm font-medium">
            {verb} <span className="text-muted-foreground">{job.sourceId}</span>
          </span>
          {job.resumed && (
            <span className="shrink-0 text-xs text-muted-foreground/70">resumed</span>
          )}
          <span className="tnum ml-auto shrink-0 text-xs text-muted-foreground">
            {job.done.toLocaleString()}{' '}
            <span className="text-muted-foreground/50">/ {job.total.toLocaleString()}</span>
          </span>
          <Button
            size="icon-sm"
            variant="ghost"
            className="shrink-0"
            onClick={() => window.api.cancelJob(job.id)}
            title="Cancel"
          >
            <X />
          </Button>
        </div>

        <Progress value={pct} tone="signal" />

        <div className="flex items-center justify-between gap-2 font-mono text-[0.6875rem] text-muted-foreground/70">
          <span className="truncate">{current ?? 'preparing…'}</span>
          <span className="tnum shrink-0">{pct.toFixed(1)}%</span>
        </div>
      </div>
    </div>
  )
}

/** The tile currently being embedded — flips as the job advances. */
function LivePreview({ sourceId, rel }: { sourceId: string; rel?: string }) {
  const [failed, setFailed] = useState(false)
  const src = rel ? thumbUrl(sourceId, rel) : null
  return (
    <div className="h-12 w-12 shrink-0 overflow-hidden rounded-md border border-border bg-muted">
      {src && !failed ? (
        <img
          key={src}
          src={src}
          alt=""
          onError={() => setFailed(true)}
          className="h-full w-full object-cover"
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-muted-foreground/40">
          <Mark className="h-5 w-5" />
        </div>
      )}
    </div>
  )
}

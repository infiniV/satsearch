import { Loader2, AlertTriangle } from 'lucide-react'
import type { HealthStatus } from '@shared/types'

export function HealthGate({
  health,
  error
}: {
  health: HealthStatus | null
  error: string | null
}) {
  if (health?.ready) return null
  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-[var(--background)]">
      {error ? (
        <>
          <AlertTriangle className="h-10 w-10 text-[var(--destructive)]" />
          <div className="max-w-md text-center">
            <p className="font-medium">The GPU sidecar could not start</p>
            <p className="mt-1 text-sm text-[var(--muted-foreground)]">{error}</p>
          </div>
        </>
      ) : (
        <>
          <Loader2 className="h-10 w-10 animate-spin text-[var(--muted-foreground)]" />
          <p className="text-sm text-[var(--muted-foreground)]">
            Starting SigLIP2 sidecar… (first run downloads the model — several GB)
          </p>
        </>
      )}
    </div>
  )
}
